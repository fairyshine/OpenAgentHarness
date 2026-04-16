import path from "node:path";

import type { Message, Run, RunStep, Session } from "@oah/api-contracts";

import { validateActionInput } from "../action-input-validation.js";
import { AppError } from "../errors.js";
import type { ActionDefinition, SessionEvent, SessionRepository, WorkspaceCommandExecutor, WorkspaceRecord } from "../types.js";
import type { ToolMessageService } from "./tool-messages.js";
import {
  WorkspaceCommandCancelledError,
  WorkspaceCommandTimeoutError
} from "../workspace-command-executor.js";

export interface ActionExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  output: string;
}

export interface ActionRunServiceDependencies {
  defaultModel: string;
  commandExecutor: WorkspaceCommandExecutor;
  sessionRepository: SessionRepository;
  toolMessages: ToolMessageService;
  startRunStep: (input: {
    runId: string;
    stepType: "tool_call";
    name?: string | undefined;
    agentName?: string | undefined;
    input?: Record<string, unknown> | undefined;
  }) => Promise<RunStep>;
  completeRunStep: (
    step: RunStep,
    status: "completed" | "failed" | "cancelled",
    output?: Record<string, unknown> | undefined
  ) => Promise<RunStep>;
  setRunStatus: (run: Run, nextStatus: Run["status"], patch: Partial<Run>) => Promise<Run>;
  getRun: (runId: string) => Promise<Run>;
  recordSystemStep: (run: Run, name: string, output?: Record<string, unknown>) => Promise<unknown>;
  recordToolCallAuditFromStep: (
    step: RunStep,
    toolName: string,
    status: "completed" | "failed" | "cancelled"
  ) => Promise<void>;
  appendEvent: (input: Omit<SessionEvent, "id" | "cursor" | "createdAt">) => Promise<SessionEvent>;
  nowIso: () => string;
  normalizeJsonObject: (value: unknown) => Record<string, unknown>;
}

function buildActionMessageMetadata(workspace: WorkspaceRecord, agentName: string): Record<string, unknown> {
  const agentMode = workspace.agents[agentName]?.mode;

  return {
    agentName,
    effectiveAgentName: agentName,
    ...(agentMode ? { agentMode } : {})
  };
}

function mergeToolMetadata(
  metadata: Record<string, unknown>,
  toolMetadata: {
    toolStatus: "running" | "completed" | "failed";
    toolSourceType: "action";
    toolDurationMs?: number | undefined;
  }
): Record<string, unknown> {
  return {
    ...metadata,
    ...toolMetadata
  };
}

export class ActionRunService {
  readonly #defaultModel: string;
  readonly #commandExecutor: WorkspaceCommandExecutor;
  readonly #sessionRepository: SessionRepository;
  readonly #toolMessages: ToolMessageService;
  readonly #startRunStep: ActionRunServiceDependencies["startRunStep"];
  readonly #completeRunStep: ActionRunServiceDependencies["completeRunStep"];
  readonly #setRunStatus: ActionRunServiceDependencies["setRunStatus"];
  readonly #getRun: ActionRunServiceDependencies["getRun"];
  readonly #recordSystemStep: ActionRunServiceDependencies["recordSystemStep"];
  readonly #recordToolCallAuditFromStep: ActionRunServiceDependencies["recordToolCallAuditFromStep"];
  readonly #appendEvent: ActionRunServiceDependencies["appendEvent"];
  readonly #nowIso: ActionRunServiceDependencies["nowIso"];
  readonly #normalizeJsonObject: ActionRunServiceDependencies["normalizeJsonObject"];

  constructor(dependencies: ActionRunServiceDependencies) {
    this.#defaultModel = dependencies.defaultModel;
    this.#commandExecutor = dependencies.commandExecutor;
    this.#sessionRepository = dependencies.sessionRepository;
    this.#toolMessages = dependencies.toolMessages;
    this.#startRunStep = dependencies.startRunStep;
    this.#completeRunStep = dependencies.completeRunStep;
    this.#setRunStatus = dependencies.setRunStatus;
    this.#getRun = dependencies.getRun;
    this.#recordSystemStep = dependencies.recordSystemStep;
    this.#recordToolCallAuditFromStep = dependencies.recordToolCallAuditFromStep;
    this.#appendEvent = dependencies.appendEvent;
    this.#nowIso = dependencies.nowIso;
    this.#normalizeJsonObject = dependencies.normalizeJsonObject;
  }

  async processActionRun(
    workspace: WorkspaceRecord,
    run: Run,
    session: Session | undefined,
    signal: AbortSignal
  ): Promise<void> {
    const actionName = typeof run.metadata?.actionName === "string" ? run.metadata.actionName : run.triggerRef;
    if (!actionName) {
      throw new AppError(500, "action_name_missing", `Run ${run.id} is missing an action name.`);
    }

    const action = workspace.actions[actionName];
    if (!action) {
      throw new AppError(404, "action_not_found", `Action ${actionName} was not found in workspace ${workspace.id}.`);
    }

    const actionToolCallId = `action-run:${run.id}:${action.name}`;
    const actionInput = this.#normalizeJsonObject(run.metadata?.input ?? null);
    const actionMetadata = buildActionMessageMetadata(workspace, run.effectiveAgentName);
    const actionStartedAt = Date.now();
    let persistedToolCallMessage: Message | undefined;

    const actionStep = await this.#startRunStep({
      runId: run.id,
      stepType: "tool_call",
      name: action.name,
      ...(run.effectiveAgentName ? { agentName: run.effectiveAgentName } : {}),
      input: {
        toolCallId: actionToolCallId,
        sourceType: "action",
        actionName: action.name,
        ...(action.retryPolicy ? { retryPolicy: action.retryPolicy } : {}),
        input: actionInput
      }
    });

    if (session) {
      await this.#appendEvent({
        sessionId: session.id,
        runId: run.id,
        event: "tool.started",
        data: {
          runId: run.id,
          sessionId: session.id,
          toolCallId: actionToolCallId,
          toolName: action.name,
          sourceType: "action",
          ...(action.retryPolicy ? { retryPolicy: action.retryPolicy } : {}),
          input: actionInput,
          metadata: actionMetadata
        }
      });
      persistedToolCallMessage = await this.#toolMessages.persistStandaloneToolCallMessage({
        session,
        run,
        toolCallId: actionToolCallId,
        toolName: action.name,
        toolInput: actionInput,
        metadata: mergeToolMetadata(actionMetadata, {
          toolStatus: "running",
          toolSourceType: "action"
        })
      });
    }

    let result: ActionExecutionResult;
    try {
      result = await this.executeAction(workspace, action, run, signal);
    } catch (error) {
      const latestRun = await this.#getRun(run.id);
      const failedStatus = signal.aborted || latestRun.status === "cancelled" ? "cancelled" : "failed";
      const completedActionStep = await this.#completeRunStep(actionStep, failedStatus, {
        sourceType: "action",
        actionName: action.name,
        ...(action.retryPolicy ? { retryPolicy: action.retryPolicy } : {}),
        ...(latestRun.errorCode ? { errorCode: latestRun.errorCode } : {}),
        ...(latestRun.errorMessage ? { errorMessage: latestRun.errorMessage } : {}),
        durationMs: Date.now() - actionStartedAt
      });
      await this.#recordToolCallAuditFromStep(completedActionStep, action.name, failedStatus);
      if (session) {
        const failedMetadata = mergeToolMetadata(actionMetadata, {
          toolStatus: "failed",
          toolSourceType: "action",
          toolDurationMs: Date.now() - actionStartedAt
        });
        await this.#appendEvent({
          sessionId: session.id,
          runId: run.id,
          event: "tool.failed",
          data: {
            runId: run.id,
            sessionId: session.id,
            toolCallId: actionToolCallId,
            toolName: action.name,
            sourceType: "action",
            ...(action.retryPolicy ? { retryPolicy: action.retryPolicy } : {}),
            errorCode: latestRun.errorCode ?? (error instanceof AppError ? error.code : "tool_execution_failed"),
            errorMessage: latestRun.errorMessage ?? (error instanceof Error ? error.message : "Unknown tool execution error."),
            durationMs: Date.now() - actionStartedAt,
            metadata: failedMetadata
          }
        });
        if (persistedToolCallMessage && "metadata" in persistedToolCallMessage) {
          await this.#toolMessages.updateMessageMetadata(
            persistedToolCallMessage,
            failedMetadata
          );
        }
        await this.#toolMessages.persistStandaloneToolErrorMessage({
          session,
          run,
          toolCallId: actionToolCallId,
          toolName: action.name,
          error,
          actionName: action.name,
          metadata: failedMetadata
        });
      }
      throw error;
    }

    const completedActionStep = await this.#completeRunStep(actionStep, "completed", {
      sourceType: "action",
      actionName: action.name,
      ...(action.retryPolicy ? { retryPolicy: action.retryPolicy } : {}),
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - actionStartedAt
    });
    await this.#recordToolCallAuditFromStep(completedActionStep, action.name, "completed");

    if (session) {
      const completedMetadata = mergeToolMetadata(actionMetadata, {
        toolStatus: "completed",
        toolSourceType: "action",
        toolDurationMs: Date.now() - actionStartedAt
      });
      await this.#appendEvent({
        sessionId: session.id,
        runId: run.id,
        event: "tool.completed",
        data: {
          runId: run.id,
          sessionId: session.id,
          toolCallId: actionToolCallId,
          toolName: action.name,
          sourceType: "action",
          ...(action.retryPolicy ? { retryPolicy: action.retryPolicy } : {}),
          output: result.output,
          durationMs: Date.now() - actionStartedAt,
          metadata: completedMetadata
        }
      });
      if (persistedToolCallMessage && "metadata" in persistedToolCallMessage) {
        await this.#toolMessages.updateMessageMetadata(
          persistedToolCallMessage,
          completedMetadata
        );
      }
      await this.#toolMessages.persistStandaloneToolResultMessage({
        session,
        run,
        toolCallId: actionToolCallId,
        toolName: action.name,
        output: result.output,
        actionName: action.name,
        metadata: completedMetadata
      });
    }

    const endedAt = this.#nowIso();
    const completedRun = await this.#setRunStatus(run, "completed", {
      endedAt,
      metadata: {
        ...(run.metadata ?? {}),
        actionName: action.name,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr
      }
    });
    await this.#recordSystemStep(completedRun, "run.completed", {
      status: completedRun.status
    });

    if (session) {
      await this.#sessionRepository.update({
        ...session,
        lastRunAt: endedAt,
        updatedAt: endedAt
      });

      await this.#appendEvent({
        sessionId: session.id,
        runId: completedRun.id,
        event: "run.completed",
        data: {
          runId: completedRun.id,
          sessionId: session.id,
          status: completedRun.status
        }
      });
    }
  }

  async executeAction(
    workspace: WorkspaceRecord,
    action: ActionDefinition,
    run: Run,
    signal: AbortSignal | undefined,
    explicitInput?: unknown
  ): Promise<ActionExecutionResult> {
    validateActionInput(action, explicitInput ?? run.metadata?.input ?? null);

    const cwd = action.entry.cwd ? path.resolve(action.directory, action.entry.cwd) : action.directory;
    const env = {
      ...process.env,
      ...(action.entry.environment ?? {}),
      OPENHARNESS_WORKSPACE_ROOT: workspace.rootPath,
      OPENHARNESS_ACTION_NAME: action.name,
      OPENHARNESS_RUN_ID: run.id,
      OPENHARNESS_DEFAULT_MODEL: this.#defaultModel,
      OPENHARNESS_ACTION_INPUT: JSON.stringify(explicitInput ?? run.metadata?.input ?? null)
    };

    let execution;
    try {
      execution = await this.#commandExecutor.runForeground({
        workspace,
        command: action.entry.command,
        cwd,
        env,
        ...(action.entry.timeoutSeconds !== undefined ? { timeoutMs: action.entry.timeoutSeconds * 1000 } : {}),
        ...(signal ? { signal } : {})
      });
    } catch (error) {
      if (error instanceof WorkspaceCommandCancelledError) {
        throw new Error("aborted");
      }
      if (error instanceof WorkspaceCommandTimeoutError) {
        const timedOutRun = await this.#setRunStatus(run, "timed_out", {
          endedAt: this.#nowIso(),
          errorCode: "action_timed_out",
          errorMessage: `Action ${action.name} timed out.`
        });
        await this.#recordSystemStep(timedOutRun, "run.timed_out", {
          status: timedOutRun.status,
          errorCode: timedOutRun.errorCode,
          errorMessage: timedOutRun.errorMessage
        });
        throw new AppError(408, "action_timed_out", `Action ${action.name} timed out.`);
      }
      throw error;
    }

    const { stdout, stderr, exitCode } = execution;

    if (signal?.aborted) {
      throw new Error("aborted");
    }

    if (exitCode !== 0) {
      const failedRun = await this.#setRunStatus(run, "failed", {
        endedAt: this.#nowIso(),
        errorCode: "action_failed",
        errorMessage: stderr.trim() || `Action ${action.name} exited with code ${exitCode}.`,
        metadata: {
          ...(run.metadata ?? {}),
          actionName: action.name,
          exitCode,
          stdout,
          stderr
        }
      });
      await this.#recordSystemStep(failedRun, "run.failed", {
        status: failedRun.status,
        errorCode: failedRun.errorCode,
        errorMessage: failedRun.errorMessage
      });
      throw new AppError(500, "action_failed", stderr.trim() || `Action ${action.name} exited with code ${exitCode}.`);
    }

    const output = stdout || stderr || "";
    return {
      stdout,
      stderr,
      exitCode,
      output
    };
  }
}
