import path from "node:path";

import type { Run, RunStep, Session } from "@oah/api-contracts";

import { AppError } from "../errors.js";
import type {
  GenerateModelInput,
  HookDefinition,
  HookRunAuditRepository,
  ModelDefinition,
  ModelGateway,
  SessionEvent,
  WorkspaceCommandExecutor,
  WorkspaceFileSystem,
  WorkspaceRecord
} from "../types.js";
import {
  WorkspaceCommandTimeoutError
} from "../workspace-command-executor.js";

export interface HookEnvelope {
  workspace_id: string;
  session_id?: string | undefined;
  run_id: string;
  cwd: string;
  hook_event_name: string;
  agent_name?: string | undefined;
  effective_agent_name: string;
  trigger_type: Run["triggerType"];
  run_status: Run["status"];
  model_ref?: string | undefined;
  model_request?: Record<string, unknown> | undefined;
  model_response?: Record<string, unknown> | undefined;
  context?: Record<string, unknown> | undefined;
  tool_name?: string | undefined;
  tool_input?: unknown;
  tool_output?: unknown;
  tool_call_id?: string | undefined;
}

export interface HookResult {
  continue?: boolean | undefined;
  stopReason?: string | undefined;
  suppressOutput?: boolean | undefined;
  systemMessage?: string | undefined;
  decision?: string | undefined;
  reason?: string | undefined;
  hookSpecificOutput?: {
    hookEventName?: string | undefined;
    additionalContext?: string | undefined;
    patch?: Record<string, unknown> | undefined;
  } | undefined;
}

export interface ResolvedHookModel {
  model: string;
  modelDefinition?: ModelDefinition | undefined;
}

export function selectHooks(
  workspace: WorkspaceRecord,
  eventName: string,
  matcherValue?: string
): HookDefinition[] {
  return Object.values(workspace.hooks).filter((hook) => {
    if (!hook.events.includes(eventName)) {
      return false;
    }

    if (!hook.matcher || !matcherValue) {
      return true;
    }

    try {
      return new RegExp(hook.matcher, "u").test(matcherValue);
    } catch {
      return false;
    }
  });
}

export function ensureHookCanContinue(result: HookResult | undefined, hookName: string): void {
  if (!result) {
    return;
  }

  if (result.continue === false || result.decision === "block") {
    throw new AppError(409, "hook_blocked", result.stopReason ?? result.reason ?? `Hook ${hookName} blocked execution.`);
  }
}

export function serializeHookResult(result: HookResult | undefined): Record<string, unknown> {
  if (!result) {
    return {
      result: null
    };
  }

  return {
    ...(result.continue !== undefined ? { continue: result.continue } : {}),
    ...(result.stopReason ? { stopReason: result.stopReason } : {}),
    ...(result.suppressOutput !== undefined ? { suppressOutput: result.suppressOutput } : {}),
    ...(result.systemMessage ? { systemMessage: result.systemMessage } : {}),
    ...(result.decision ? { decision: result.decision } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.hookSpecificOutput ? { hookSpecificOutput: result.hookSpecificOutput } : {})
  };
}

interface HookStepInput {
  runId: string;
  stepType: "hook";
  name?: string | undefined;
  agentName?: string | undefined;
  input?: Record<string, unknown> | undefined;
}

interface HookAuditRecordInput {
  hook: HookDefinition;
  envelope: HookEnvelope;
  step: RunStep;
  status: "completed" | "failed";
  result?: HookResult | undefined;
  error?: unknown;
}

export interface HookServiceDependencies {
  defaultModel: string;
  modelGateway: ModelGateway;
  commandExecutor: WorkspaceCommandExecutor;
  fileSystem: WorkspaceFileSystem;
  hookRunAuditRepository?: HookRunAuditRepository | undefined;
  startRunStep: (input: HookStepInput) => Promise<RunStep>;
  completeRunStep: (
    step: RunStep,
    status: "completed" | "failed" | "cancelled",
    output?: Record<string, unknown> | undefined
  ) => Promise<RunStep>;
  appendEvent: (input: Omit<SessionEvent, "id" | "cursor" | "createdAt">) => Promise<SessionEvent>;
  resolveModelForRun: (workspace: WorkspaceRecord, modelRef: string | undefined) => ResolvedHookModel;
  createId: (prefix: string) => string;
  timeoutMsFromSeconds: (value: unknown) => number | undefined;
  withTimeout: <T>(
    operation: (signal: AbortSignal | undefined) => Promise<T>,
    timeoutMs: number | undefined,
    timeoutMessage: string
  ) => Promise<T>;
  isAbortError: (error: unknown) => boolean;
}

export class HookService {
  readonly #defaultModel: string;
  readonly #modelGateway: ModelGateway;
  readonly #commandExecutor: WorkspaceCommandExecutor;
  readonly #fileSystem: WorkspaceFileSystem;
  readonly #hookRunAuditRepository?: HookRunAuditRepository | undefined;
  readonly #startRunStep: HookServiceDependencies["startRunStep"];
  readonly #completeRunStep: HookServiceDependencies["completeRunStep"];
  readonly #appendEvent: HookServiceDependencies["appendEvent"];
  readonly #resolveModelForRun: HookServiceDependencies["resolveModelForRun"];
  readonly #createId: HookServiceDependencies["createId"];
  readonly #timeoutMsFromSeconds: HookServiceDependencies["timeoutMsFromSeconds"];
  readonly #withTimeout: HookServiceDependencies["withTimeout"];
  readonly #isAbortError: HookServiceDependencies["isAbortError"];

  constructor(dependencies: HookServiceDependencies) {
    this.#defaultModel = dependencies.defaultModel;
    this.#modelGateway = dependencies.modelGateway;
    this.#commandExecutor = dependencies.commandExecutor;
    this.#fileSystem = dependencies.fileSystem;
    this.#hookRunAuditRepository = dependencies.hookRunAuditRepository;
    this.#startRunStep = dependencies.startRunStep;
    this.#completeRunStep = dependencies.completeRunStep;
    this.#appendEvent = dependencies.appendEvent;
    this.#resolveModelForRun = dependencies.resolveModelForRun;
    this.#createId = dependencies.createId;
    this.#timeoutMsFromSeconds = dependencies.timeoutMsFromSeconds;
    this.#withTimeout = dependencies.withTimeout;
    this.#isAbortError = dependencies.isAbortError;
  }

  async executeHook(
    workspace: WorkspaceRecord,
    session: Session | undefined,
    run: Run,
    hook: HookDefinition,
    envelope: HookEnvelope
  ): Promise<HookResult | undefined> {
    const handler = hook.definition.handler as Record<string, unknown> | undefined;
    if (!handler || typeof handler.type !== "string") {
      return undefined;
    }

    const hookStep = await this.#startRunStep({
      runId: run.id,
      stepType: "hook",
      name: hook.name,
      agentName: run.effectiveAgentName,
      input: {
        hookEventName: envelope.hook_event_name,
        handlerType: handler.type,
        ...(hook.matcher ? { matcher: hook.matcher } : {})
      }
    });

    try {
      let result: HookResult | undefined;
      switch (handler.type) {
        case "command":
          result = await this.#executeCommandHook(workspace, handler, envelope);
          break;
        case "http":
          result = await this.#executeHttpHook(handler, envelope);
          break;
        case "prompt":
          result = await this.#executePromptHook(workspace, hook, handler, envelope);
          break;
        case "agent":
          result = await this.#executeAgentHook(workspace, hook, handler, envelope);
          break;
        default:
          result = undefined;
          break;
      }

      const completedHookStep = await this.#completeRunStep(hookStep, "completed", serializeHookResult(result));
      await this.#recordHookRunAudit({
        hook,
        envelope,
        step: completedHookStep,
        status: "completed",
        result
      });
      return result;
    } catch (error) {
      const failedHookStep = await this.#completeRunStep(hookStep, "failed", {
        errorMessage: error instanceof Error ? error.message : "Unknown hook execution error."
      });
      await this.#recordHookRunAudit({
        hook,
        envelope,
        step: failedHookStep,
        status: "failed",
        error
      });
      if (session) {
        const errorCode = error instanceof AppError ? error.code : "hook_execution_failed";
        await this.#appendEvent({
          sessionId: session.id,
          runId: run.id,
          event: "hook.notice",
          data: {
            runId: run.id,
            sessionId: session.id,
            hookName: hook.name,
            eventName: envelope.hook_event_name,
            handlerType: handler.type,
            errorCode,
            errorMessage: error instanceof Error ? error.message : "Unknown hook execution error."
          }
        });
      }
      return undefined;
    }
  }

  async #executeCommandHook(
    workspace: WorkspaceRecord,
    handler: Record<string, unknown>,
    envelope: HookEnvelope
  ): Promise<HookResult | undefined> {
    if (typeof handler.command !== "string") {
      return undefined;
    }

    const cwd =
      typeof handler.cwd === "string" ? path.resolve(workspace.rootPath, handler.cwd) : workspace.rootPath;
    const timeoutMs = this.#timeoutMsFromSeconds(handler.timeout_seconds);
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      ({ stdout, stderr, exitCode } = await this.#commandExecutor.runForeground({
        workspace,
        command: handler.command,
        cwd,
        env:
          handler.environment && typeof handler.environment === "object"
            ? (handler.environment as Record<string, string>)
            : undefined,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        stdinText: JSON.stringify(envelope)
      }));
    } catch (error) {
      if (error instanceof WorkspaceCommandTimeoutError) {
        throw new Error(`Command hook timed out after ${timeoutMs}ms.`);
      }
      throw error;
    }

    if (exitCode === 2) {
      return {
        continue: false,
        stopReason: stderr.trim() || `Hook blocked execution: ${handler.command}`
      };
    }

    if (exitCode !== 0) {
      throw new Error(stderr.trim() || `Command hook exited with code ${exitCode}.`);
    }

    if (stdout.trim().length === 0) {
      return undefined;
    }

    const parsed = this.#parseHookResult(stdout);
    if (!parsed) {
      throw new Error("Command hook returned invalid JSON output.");
    }

    return parsed;
  }

  async #executeHttpHook(handler: Record<string, unknown>, envelope: HookEnvelope): Promise<HookResult | undefined> {
    if (typeof handler.url !== "string") {
      return undefined;
    }

    const timeoutMs = this.#timeoutMsFromSeconds(handler.timeout_seconds);
    const abortController = timeoutMs !== undefined ? new AbortController() : undefined;
    const abortTimer =
      timeoutMs !== undefined && abortController
        ? setTimeout(() => {
            abortController.abort();
          }, timeoutMs)
        : undefined;

    const response = await fetch(handler.url, {
      method: typeof handler.method === "string" ? handler.method : "POST",
      headers: {
        "content-type": "application/json",
        ...(handler.headers && typeof handler.headers === "object" ? (handler.headers as Record<string, string>) : {})
      },
      body: JSON.stringify(envelope),
      ...(abortController ? { signal: abortController.signal } : {})
    })
      .catch((error) => {
        if (this.#isAbortError(error)) {
          throw new Error(`HTTP hook timed out after ${timeoutMs}ms.`);
        }

        throw error;
      })
      .finally(() => {
        if (abortTimer) {
          clearTimeout(abortTimer);
        }
      });

    if (!response.ok) {
      throw new Error(`HTTP hook returned ${response.status}.`);
    }

    const body = await response.text();
    if (!body.trim()) {
      return undefined;
    }

    const parsed = this.#parseHookResult(body);
    if (!parsed) {
      throw new Error("HTTP hook returned invalid JSON output.");
    }

    return parsed;
  }

  async #executePromptHook(
    workspace: WorkspaceRecord,
    hook: HookDefinition,
    handler: Record<string, unknown>,
    envelope: HookEnvelope
  ): Promise<HookResult | undefined> {
    const prompt = await this.#resolveHookPromptSource(workspace, handler.prompt as Record<string, unknown> | undefined);
    if (!prompt) {
      return undefined;
    }

    const resolvedModel = this.#resolveModelForRun(
      workspace,
      typeof handler.model_ref === "string" ? handler.model_ref : this.#defaultModel
    );
    const timeoutMs = this.#timeoutMsFromSeconds(handler.timeout_seconds);
    const result = await this.#withTimeout(
      async (signal) => {
        const request = {
          model: resolvedModel.model,
          ...(resolvedModel.modelDefinition ? { modelDefinition: resolvedModel.modelDefinition } : {}),
          prompt: [
            prompt,
            "Return only JSON matching the Open Agent Harness hook output protocol.",
            JSON.stringify({
              hook: hook.name,
              envelope
            })
          ].join("\n\n")
        };
        return this.#modelGateway.generate(request, signal ? { signal } : undefined);
      },
      timeoutMs,
      `Prompt hook timed out after ${timeoutMs}ms.`
    );

    const parsed = this.#parseHookResult(result.text);
    if (!parsed) {
      throw new Error("Prompt hook returned invalid JSON output.");
    }

    return parsed;
  }

  async #executeAgentHook(
    workspace: WorkspaceRecord,
    hook: HookDefinition,
    handler: Record<string, unknown>,
    envelope: HookEnvelope
  ): Promise<HookResult | undefined> {
    if (typeof handler.agent !== "string") {
      return undefined;
    }

    const agent = workspace.agents[handler.agent];
    if (!agent) {
      throw new AppError(404, "agent_not_found", `Agent ${handler.agent} was not found in workspace ${workspace.id}.`);
    }

    const task = await this.#resolveHookPromptSource(workspace, handler.task as Record<string, unknown> | undefined);
    if (!task) {
      return undefined;
    }

    const resolvedModel = this.#resolveModelForRun(workspace, agent.modelRef);
    const timeoutMs = this.#timeoutMsFromSeconds(handler.timeout_seconds);
    const result = await this.#withTimeout(
      async (signal) => {
        const request: GenerateModelInput = {
          model: resolvedModel.model,
          ...(resolvedModel.modelDefinition ? { modelDefinition: resolvedModel.modelDefinition } : {}),
          ...(agent.maxTokens !== undefined ? { maxTokens: agent.maxTokens } : {}),
          ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
          ...(agent.topP !== undefined ? { topP: agent.topP } : {}),
          messages: [
            { role: "system", content: agent.prompt },
            { role: "user", content: task },
            {
              role: "user",
              content: `Return only JSON matching the Open Agent Harness hook output protocol.\n\n${JSON.stringify({
                hook: hook.name,
                envelope
              })}`
            }
          ]
        };
        return this.#modelGateway.generate(request, signal ? { signal } : undefined);
      },
      timeoutMs,
      `Agent hook timed out after ${timeoutMs}ms.`
    );

    const parsed = this.#parseHookResult(result.text);
    if (!parsed) {
      throw new Error("Agent hook returned invalid JSON output.");
    }

    return parsed;
  }

  async #resolveHookPromptSource(
    workspace: WorkspaceRecord,
    promptSource: Record<string, unknown> | undefined
  ): Promise<string | undefined> {
    if (!promptSource) {
      return undefined;
    }

    if (typeof promptSource.inline === "string") {
      return promptSource.inline;
    }

    if (typeof promptSource.file === "string") {
      return this.#fileSystem.readFile(path.resolve(workspace.rootPath, promptSource.file)).then((buffer) => buffer.toString("utf8"));
    }

    return undefined;
  }

  #parseHookResult(rawOutput: string): HookResult | undefined {
    const trimmed = rawOutput.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    const jsonMatch = trimmed.match(/\{[\s\S]*\}/u);
    if (!jsonMatch) {
      return undefined;
    }

    try {
      return JSON.parse(jsonMatch[0]) as HookResult;
    } catch {
      return undefined;
    }
  }

  async #recordHookRunAudit(input: HookAuditRecordInput): Promise<void> {
    const { hook, envelope, step, status, result, error } = input;

    if (!this.#hookRunAuditRepository || !step.endedAt) {
      return;
    }

    const patch =
      result?.hookSpecificOutput?.patch && typeof result.hookSpecificOutput.patch === "object"
        ? (result.hookSpecificOutput.patch as Record<string, unknown>)
        : undefined;

    await this.#hookRunAuditRepository.create({
      id: this.#createId("hookrun"),
      runId: step.runId,
      hookName: hook.name,
      eventName: envelope.hook_event_name,
      capabilities: hook.capabilities,
      ...(patch ? { patch } : {}),
      status,
      startedAt: step.startedAt ?? step.endedAt,
      endedAt: step.endedAt,
      ...(status === "failed"
        ? {
            errorMessage: error instanceof Error ? error.message : "Unknown hook execution error."
          }
        : {})
    });
  }
}
