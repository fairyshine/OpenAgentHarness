import type { Run, RunStep, Session } from "@oah/api-contracts";

import { AppError } from "../errors.js";
import type {
  RuntimeLogger,
  RuntimeServiceOptions,
  SessionEvent,
  WorkspaceExecutionLease,
  WorkspaceRecord
} from "../types.js";
import { nowIso } from "../utils.js";
import { timeoutMsFromSeconds } from "./internal-helpers.js";
import { ModelRunExecutor } from "./model-run-executor.js";
import type { RunFinalizationService } from "./run-finalization.js";

interface RunProcessorExecutionServices {
  runFinalization: Pick<RunFinalizationService, "finalizeTimedOutRun" | "finalizeCancelledRun" | "finalizeFailedRun">;
}

export interface RunProcessorServiceDependencies {
  logger?: RuntimeLogger | undefined;
  workspaceExecutionProvider?: RuntimeServiceOptions["workspaceExecutionProvider"] | undefined;
  runAbortControllers: Map<string, AbortController>;
  drainTimeoutRecoveredRuns: Set<string>;
  runHeartbeatIntervalMs: number;
  ensureExecutionServices: () => RunProcessorExecutionServices;
  getRun: (runId: string) => Promise<Run>;
  getSession: (sessionId: string) => Promise<Session>;
  getWorkspaceRecord: (workspaceId: string) => Promise<WorkspaceRecord>;
  setRunStatus: (run: Run, nextStatus: Run["status"], patch: Partial<Run>) => Promise<Run>;
  markRunCancelled: (sessionId: string, run: Run) => Promise<void>;
  refreshRunHeartbeat: (runId: string) => Promise<void>;
  recordSystemStep: (run: Run, name: string, output?: Record<string, unknown> | undefined) => Promise<RunStep>;
  appendEvent: (input: Omit<SessionEvent, "id" | "cursor" | "createdAt">) => Promise<unknown>;
  modelRunExecutor: ModelRunExecutor;
  processActionRun: (
    workspace: WorkspaceRecord,
    run: Run,
    session: Session | undefined,
    signal: AbortSignal
  ) => Promise<void>;
}

export class RunProcessorService {
  readonly #logger?: RuntimeLogger | undefined;
  readonly #workspaceExecutionProvider?: RuntimeServiceOptions["workspaceExecutionProvider"] | undefined;
  readonly #runAbortControllers: Map<string, AbortController>;
  readonly #drainTimeoutRecoveredRuns: Set<string>;
  readonly #runHeartbeatIntervalMs: number;
  readonly #ensureExecutionServices: RunProcessorServiceDependencies["ensureExecutionServices"];
  readonly #getRun: RunProcessorServiceDependencies["getRun"];
  readonly #getSession: RunProcessorServiceDependencies["getSession"];
  readonly #getWorkspaceRecord: RunProcessorServiceDependencies["getWorkspaceRecord"];
  readonly #setRunStatus: RunProcessorServiceDependencies["setRunStatus"];
  readonly #markRunCancelled: RunProcessorServiceDependencies["markRunCancelled"];
  readonly #refreshRunHeartbeat: RunProcessorServiceDependencies["refreshRunHeartbeat"];
  readonly #recordSystemStep: RunProcessorServiceDependencies["recordSystemStep"];
  readonly #appendEvent: RunProcessorServiceDependencies["appendEvent"];
  readonly #modelRunExecutor: ModelRunExecutor;
  readonly #processActionRun: RunProcessorServiceDependencies["processActionRun"];

  constructor(dependencies: RunProcessorServiceDependencies) {
    this.#logger = dependencies.logger;
    this.#workspaceExecutionProvider = dependencies.workspaceExecutionProvider;
    this.#runAbortControllers = dependencies.runAbortControllers;
    this.#drainTimeoutRecoveredRuns = dependencies.drainTimeoutRecoveredRuns;
    this.#runHeartbeatIntervalMs = dependencies.runHeartbeatIntervalMs;
    this.#ensureExecutionServices = dependencies.ensureExecutionServices;
    this.#getRun = dependencies.getRun;
    this.#getSession = dependencies.getSession;
    this.#getWorkspaceRecord = dependencies.getWorkspaceRecord;
    this.#setRunStatus = dependencies.setRunStatus;
    this.#markRunCancelled = dependencies.markRunCancelled;
    this.#refreshRunHeartbeat = dependencies.refreshRunHeartbeat;
    this.#recordSystemStep = dependencies.recordSystemStep;
    this.#appendEvent = dependencies.appendEvent;
    this.#modelRunExecutor = dependencies.modelRunExecutor;
    this.#processActionRun = dependencies.processActionRun;
  }

  async processRun(runId: string): Promise<void> {
    let run = await this.#getRun(runId);
    const workspace = await this.#getWorkspaceRecord(run.workspaceId);
    const session = run.sessionId ? await this.#getSession(run.sessionId) : undefined;
    if (run.cancelRequestedAt) {
      if (session) {
        await this.#markRunCancelled(session.id, run);
      } else {
        await this.#setRunStatus(run, "cancelled", {
          endedAt: nowIso(),
          cancelRequestedAt: run.cancelRequestedAt ?? nowIso()
        });
      }
      return;
    }

    const startedAt = nowIso();
    run = await this.#setRunStatus(run, "running", {
      startedAt,
      heartbeatAt: startedAt
    });
    await this.#recordSystemStep(run, "run.started", {
      status: run.status
    });
    if (session) {
      await this.#appendEvent({
        sessionId: session.id,
        runId: run.id,
        event: "run.started",
        data: {
          runId: run.id,
          sessionId: session.id,
          status: "running"
        }
      });
    }

    const abortController = new AbortController();
    this.#runAbortControllers.set(run.id, abortController);
    const runHeartbeat = setInterval(() => {
      void this.#refreshRunHeartbeat(run.id);
    }, this.#runHeartbeatIntervalMs);
    runHeartbeat.unref?.();
    const runTimeoutMs = timeoutMsFromSeconds(workspace.agents[run.effectiveAgentName]?.policy?.runTimeoutSeconds);
    let runTimedOut = false;
    const runTimeout =
      runTimeoutMs !== undefined
        ? setTimeout(() => {
            runTimedOut = true;
            abortController.abort();
          }, runTimeoutMs)
        : undefined;
    let executionWorkspace = workspace;
    let executionLease: WorkspaceExecutionLease | undefined;

    try {
      if (this.#workspaceExecutionProvider) {
        executionLease = await this.#workspaceExecutionProvider.acquire({
          workspace,
          run,
          ...(session ? { session } : {})
        });
        executionWorkspace = executionLease.workspace;
      }

      if (run.triggerType === "api_action") {
        await this.#processActionRun(executionWorkspace, run, session, abortController.signal);
        return;
      }

      if (!session) {
        throw new AppError(500, "session_required", `Run ${run.id} requires a session for message execution.`);
      }
      await this.#modelRunExecutor.executeRun({
        workspace: executionWorkspace,
        session,
        run,
        abortSignal: abortController.signal,
        shouldSkipCompletion: (targetRunId) => this.#drainTimeoutRecoveredRuns.has(targetRunId)
      });
    } catch (error) {
      if (abortController.signal.aborted) {
        if (this.#drainTimeoutRecoveredRuns.has(run.id)) {
          return;
        }

        const execution = this.#ensureExecutionServices();
        if (runTimedOut) {
          this.#logger?.error?.("Runtime run timed out.", {
            workspaceId: executionWorkspace.id,
            sessionId: session?.id,
            runId: run.id,
            triggerType: run.triggerType,
            errorCode: "run_timed_out",
            errorMessage: runTimeoutMs ? `Run exceeded timeout after ${runTimeoutMs}ms.` : "Run exceeded the configured timeout."
          });
          await execution.runFinalization.finalizeTimedOutRun({
            workspace: executionWorkspace,
            session,
            runId: run.id,
            runTimeoutMs
          });
          return;
        }

        this.#logger?.warn?.("Runtime run cancelled.", {
          workspaceId: executionWorkspace.id,
          sessionId: session?.id,
          runId: run.id,
          triggerType: run.triggerType,
          status: "cancelled"
        });
        await execution.runFinalization.finalizeCancelledRun({
          session,
          runId: run.id
        });
        return;
      }

      if (this.#drainTimeoutRecoveredRuns.has(run.id)) {
        return;
      }

      const currentRun = await this.#getRun(run.id);
      const execution = this.#ensureExecutionServices();
      this.#logger?.error?.("Runtime run failed.", {
        workspaceId: executionWorkspace.id,
        sessionId: session?.id,
        runId: run.id,
        triggerType: run.triggerType,
        status: currentRun.status,
        errorCode: error instanceof AppError ? error.code : "model_stream_failed",
        errorMessage: error instanceof Error ? error.message : "Unknown streaming error."
      });
      await execution.runFinalization.finalizeFailedRun({
        workspace: executionWorkspace,
        session,
        runId: run.id,
        errorCode: error instanceof AppError ? error.code : "model_stream_failed",
        errorMessage: error instanceof Error ? error.message : "Unknown streaming error."
      });
    } finally {
      clearInterval(runHeartbeat);
      if (runTimeout) {
        clearTimeout(runTimeout);
      }
      this.#runAbortControllers.delete(run.id);
      this.#drainTimeoutRecoveredRuns.delete(run.id);
      if (executionLease) {
        try {
          await executionLease.release({
            dirty: !executionWorkspace.readOnly && executionWorkspace.kind === "project"
          });
        } catch (error) {
          this.#logger?.warn?.("Failed to release execution workspace lease.", {
            error: error instanceof Error ? error.message : String(error),
            workspaceId: executionWorkspace.id,
            runId: run.id
          });
        }
      }
    }
  }
}
