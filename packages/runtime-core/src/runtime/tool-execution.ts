import type { Run, RunStep, Session } from "@oah/api-contracts";

import { AppError } from "../errors.js";
import type {
  ActionRetryPolicy,
  RuntimeLogger,
  RuntimeToolExecutionContext,
  RuntimeToolSet,
  WorkspaceRecord
} from "../types.js";

interface RunExecutionContextLike {
  currentAgentName: string;
}

function asJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

export interface ToolExecutionServiceDependencies {
  logger?: RuntimeLogger | undefined;
  startRunStep: (input: {
    runId: string;
    stepType: RunStep["stepType"];
    name?: string | undefined;
    agentName?: string | undefined;
    input?: Record<string, unknown> | undefined;
  }) => Promise<RunStep>;
  completeRunStep: (
    step: RunStep,
    status: "completed" | "failed" | "cancelled",
    output?: Record<string, unknown> | undefined
  ) => Promise<RunStep>;
  recordToolCallAuditFromStep: (
    step: RunStep,
    toolName: string,
    status: "completed" | "failed" | "cancelled"
  ) => Promise<void>;
  appendEvent: (input: {
    sessionId: string;
    runId: string;
    event: "tool.started" | "tool.failed";
    data: Record<string, unknown>;
  }) => Promise<unknown>;
  setRunStatusIfPossible: (runId: string, nextStatus: Run["status"]) => Promise<void>;
  applyBeforeToolDispatchHooks: (
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    activeAgentName: string,
    toolName: string,
    toolCallId: string | undefined,
    input: unknown
  ) => Promise<unknown>;
  applyAfterToolDispatchHooks: (
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    activeAgentName: string,
    toolName: string,
    toolCallId: string | undefined,
    input: unknown,
    output: unknown
  ) => Promise<unknown>;
  resolveToolRetryPolicy: (
    workspace: WorkspaceRecord,
    toolName: string,
    input: unknown,
    definition: RuntimeToolSet[string]
  ) => ActionRetryPolicy | undefined;
  resolveToolSourceType: (toolName: string) => "action" | "skill" | "agent" | "tool" | "native";
  timeoutMsFromSeconds: (value: unknown) => number | undefined;
  createAbortError: () => Error;
  normalizeJsonObject: (value: unknown) => Record<string, unknown>;
  previewValue: (value: unknown, maxLength?: number) => string;
}

export class ToolExecutionService {
  readonly #logger?: RuntimeLogger | undefined;
  readonly #startRunStep: ToolExecutionServiceDependencies["startRunStep"];
  readonly #completeRunStep: ToolExecutionServiceDependencies["completeRunStep"];
  readonly #recordToolCallAuditFromStep: ToolExecutionServiceDependencies["recordToolCallAuditFromStep"];
  readonly #appendEvent: ToolExecutionServiceDependencies["appendEvent"];
  readonly #setRunStatusIfPossible: ToolExecutionServiceDependencies["setRunStatusIfPossible"];
  readonly #applyBeforeToolDispatchHooks: ToolExecutionServiceDependencies["applyBeforeToolDispatchHooks"];
  readonly #applyAfterToolDispatchHooks: ToolExecutionServiceDependencies["applyAfterToolDispatchHooks"];
  readonly #resolveToolRetryPolicy: ToolExecutionServiceDependencies["resolveToolRetryPolicy"];
  readonly #resolveToolSourceType: ToolExecutionServiceDependencies["resolveToolSourceType"];
  readonly #timeoutMsFromSeconds: ToolExecutionServiceDependencies["timeoutMsFromSeconds"];
  readonly #createAbortError: ToolExecutionServiceDependencies["createAbortError"];
  readonly #normalizeJsonObject: ToolExecutionServiceDependencies["normalizeJsonObject"];
  readonly #previewValue: ToolExecutionServiceDependencies["previewValue"];

  constructor(dependencies: ToolExecutionServiceDependencies) {
    this.#logger = dependencies.logger;
    this.#startRunStep = dependencies.startRunStep;
    this.#completeRunStep = dependencies.completeRunStep;
    this.#recordToolCallAuditFromStep = dependencies.recordToolCallAuditFromStep;
    this.#appendEvent = dependencies.appendEvent;
    this.#setRunStatusIfPossible = dependencies.setRunStatusIfPossible;
    this.#applyBeforeToolDispatchHooks = dependencies.applyBeforeToolDispatchHooks;
    this.#applyAfterToolDispatchHooks = dependencies.applyAfterToolDispatchHooks;
    this.#resolveToolRetryPolicy = dependencies.resolveToolRetryPolicy;
    this.#resolveToolSourceType = dependencies.resolveToolSourceType;
    this.#timeoutMsFromSeconds = dependencies.timeoutMsFromSeconds;
    this.#createAbortError = dependencies.createAbortError;
    this.#normalizeJsonObject = dependencies.normalizeJsonObject;
    this.#previewValue = dependencies.previewValue;
  }

  wrapRuntimeToolsForEvents(input: {
    workspace: WorkspaceRecord;
    session: Session;
    run: Run;
    runtimeTools: RuntimeToolSet;
    executionContext: RunExecutionContextLike;
    toolCallStartedAt: Map<string, number>;
    toolCallSteps: Map<string, RunStep>;
  }): RuntimeToolSet {
    return Object.fromEntries(
      Object.entries(input.runtimeTools).map(([toolName, definition]) => [
        toolName,
        {
          ...definition,
          execute: async (rawInput, context) => {
            const currentAgentName = input.executionContext.currentAgentName;
            const toolStartedAt = context.toolCallId
              ? (input.toolCallStartedAt.get(context.toolCallId) ?? Date.now())
              : Date.now();
            let executedInput = rawInput;
            let retryPolicy = this.#resolveToolRetryPolicy(input.workspace, toolName, rawInput, definition);

            try {
              executedInput = await this.#applyBeforeToolDispatchHooks(
                input.workspace,
                input.session,
                input.run,
                currentAgentName,
                toolName,
                context.toolCallId,
                rawInput
              );
              retryPolicy = this.#resolveToolRetryPolicy(input.workspace, toolName, executedInput, definition);

              if (context.toolCallId) {
                input.toolCallStartedAt.set(context.toolCallId, toolStartedAt);
                input.toolCallSteps.set(
                  context.toolCallId,
                  await this.#startRunStep({
                    runId: input.run.id,
                    stepType: "tool_call",
                    name: toolName,
                    agentName: currentAgentName,
                    input: {
                      toolCallId: context.toolCallId,
                      sourceType: this.#resolveToolSourceType(toolName),
                      retryPolicy,
                      input: this.#normalizeJsonObject(executedInput)
                    }
                  })
                );
              }

              await this.#appendEvent({
                sessionId: input.session.id,
                runId: input.run.id,
                event: "tool.started",
                data: {
                  runId: input.run.id,
                  sessionId: input.session.id,
                  ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
                  toolName,
                  sourceType: this.#resolveToolSourceType(toolName),
                  retryPolicy,
                  input: executedInput
                }
              });
              await this.#setRunStatusIfPossible(input.run.id, "waiting_tool");

              const toolTimeoutMs = this.#timeoutMsFromSeconds(
                input.workspace.agents[currentAgentName]?.policy?.toolTimeoutSeconds
              );
              const output = await this.#executeRuntimeToolWithPolicy(
                definition,
                executedInput,
                context,
                toolName,
                toolTimeoutMs
              );
              return this.#applyAfterToolDispatchHooks(
                input.workspace,
                input.session,
                input.run,
                currentAgentName,
                toolName,
                context.toolCallId,
                executedInput,
                output
              );
            } catch (error) {
              const startedAt = context.toolCallId ? input.toolCallStartedAt.get(context.toolCallId) : undefined;
              const toolStep = context.toolCallId ? input.toolCallSteps.get(context.toolCallId) : undefined;
              if (context.toolCallId) {
                input.toolCallStartedAt.delete(context.toolCallId);
                input.toolCallSteps.delete(context.toolCallId);
              }
              if (toolStep) {
                const failedToolStep = await this.#completeRunStep(toolStep, "failed", {
                  sourceType: this.#resolveToolSourceType(toolName),
                  retryPolicy,
                  errorCode: error instanceof AppError ? error.code : "tool_execution_failed",
                  errorMessage: error instanceof Error ? error.message : "Unknown tool execution error.",
                  ...(startedAt !== undefined ? { durationMs: Date.now() - startedAt } : {})
                });
                await this.#recordToolCallAuditFromStep(failedToolStep, toolName, "failed");
              }
              await this.#appendEvent({
                sessionId: input.session.id,
                runId: input.run.id,
                event: "tool.failed",
                data: {
                  runId: input.run.id,
                  sessionId: input.session.id,
                  ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
                  toolName,
                  sourceType: this.#resolveToolSourceType(toolName),
                  retryPolicy,
                  errorCode: error instanceof AppError ? error.code : "tool_execution_failed",
                  errorMessage: error instanceof Error ? error.message : "Unknown tool execution error.",
                  ...(startedAt !== undefined ? { durationMs: Date.now() - startedAt } : {})
                }
              });
              this.#logger?.error?.("Runtime tool call failed.", {
                workspaceId: input.workspace.id,
                sessionId: input.session.id,
                runId: input.run.id,
                agentName: currentAgentName,
                toolCallId: context.toolCallId,
                toolName,
                sourceType: this.#resolveToolSourceType(toolName),
                retryPolicy,
                errorCode: error instanceof AppError ? error.code : "tool_execution_failed",
                errorMessage: error instanceof Error ? error.message : "Unknown tool execution error.",
                ...(startedAt !== undefined ? { durationMs: Date.now() - startedAt } : {})
              });
              throw error;
            }
          }
        }
      ])
    );
  }

  runStepRetryPolicy(step: RunStep): ActionRetryPolicy | undefined {
    const inputPayload = asJsonRecord(step.input);
    const inputRetryPolicy = inputPayload?.retryPolicy;
    if (inputRetryPolicy === "manual" || inputRetryPolicy === "safe") {
      return inputRetryPolicy;
    }

    const outputPayload = asJsonRecord(step.output);
    const outputRetryPolicy = outputPayload?.retryPolicy;
    if (outputRetryPolicy === "manual" || outputRetryPolicy === "safe") {
      return outputRetryPolicy;
    }

    return undefined;
  }

  async #executeRuntimeToolWithPolicy(
    definition: RuntimeToolSet[string],
    input: unknown,
    context: RuntimeToolExecutionContext,
    toolName: string,
    timeoutMs: number | undefined
  ): Promise<unknown> {
    if (timeoutMs === undefined) {
      return definition.execute(input, context);
    }

    const abortController = new AbortController();
    const parentSignal = context.abortSignal;
    let timedOut = false;
    const forwardParentAbort = () => {
      abortController.abort();
    };

    if (parentSignal) {
      if (parentSignal.aborted) {
        abortController.abort();
      } else {
        parentSignal.addEventListener("abort", forwardParentAbort, { once: true });
      }
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, timeoutMs);

    try {
      return await Promise.race([
        Promise.resolve(
          definition.execute(input, {
            ...context,
            abortSignal: abortController.signal
          })
        ),
        new Promise<unknown>((_resolve, reject) => {
          const rejectForAbort = () => {
            reject(
              timedOut
                ? new AppError(408, "tool_timed_out", `Tool ${toolName} timed out after ${timeoutMs}ms.`)
                : this.#createAbortError()
            );
          };

          if (abortController.signal.aborted) {
            rejectForAbort();
            return;
          }

          abortController.signal.addEventListener("abort", rejectForAbort, { once: true });
        })
      ]);
    } finally {
      clearTimeout(timeout);
      if (parentSignal && !parentSignal.aborted) {
        parentSignal.removeEventListener("abort", forwardParentAbort);
      }
    }
  }
}
