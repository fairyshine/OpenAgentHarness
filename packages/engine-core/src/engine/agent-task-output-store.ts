import type { Run } from "@oah/api-contracts";

import { AppError } from "../errors.js";
import type { AgentTaskRecord, AgentTaskStatus } from "../types.js";
import { taskOutputPath } from "./agent-delegation-messages.js";
import { delegatedRunRecords } from "./agent-coordination-records.js";
import {
  isRunTerminal,
  waitForRunTerminalStateUntil
} from "./agent-coordination-run-state.js";
import type {
  AgentCoordinationHelpers,
  AgentCoordinationLifecycle,
  AgentCoordinationPersistence,
  AgentTaskOutputReadResult,
  AwaitedRunSummary
} from "./agent-coordination-types.js";
import { summarizeChildRunUsage } from "./agent-run-usage.js";
import {
  agentTaskOutputView,
  agentTaskStatusFromRun,
  localAgentTaskState,
  taskOutputRef
} from "./agent-task-state.js";

export interface PersistAgentTaskTerminalOutputInput {
  workspaceId: string;
  parentSessionId: string;
  parentRunId: string;
  childSessionId: string;
  childRunId: string;
  targetAgentName: string;
  parentAgentName: string;
  taskId: string;
  toolUseId?: string | undefined;
  status: AgentTaskStatus;
  updatedAt: string;
  outputRef: string;
  outputFile: string;
  finalText?: string | undefined;
  errorMessage?: string | undefined;
  usage?: Record<string, unknown> | undefined;
  taskState?: AgentTaskRecord["taskState"] | undefined;
  notifiedAt?: string | undefined;
}

export class AgentTaskOutputStore {
  readonly #persistence: AgentCoordinationPersistence;
  readonly #lifecycle: AgentCoordinationLifecycle;
  readonly #helpers: AgentCoordinationHelpers;
  readonly #collectAwaitedRunSummary: (runId: string) => Promise<AwaitedRunSummary>;

  constructor(dependencies: {
    persistence: AgentCoordinationPersistence;
    lifecycle: AgentCoordinationLifecycle;
    helpers: AgentCoordinationHelpers;
    collectAwaitedRunSummary: (runId: string) => Promise<AwaitedRunSummary>;
  }) {
    this.#persistence = dependencies.persistence;
    this.#lifecycle = dependencies.lifecycle;
    this.#helpers = dependencies.helpers;
    this.#collectAwaitedRunSummary = dependencies.collectAwaitedRunSummary;
  }

  async read(input: {
    taskId: string;
    block?: boolean | undefined;
    timeoutMs?: number | undefined;
    abortSignal?: AbortSignal | undefined;
  }): Promise<AgentTaskOutputReadResult> {
    const repository = this.#persistence.agentTasks;
    if (!repository) {
      throw new AppError(501, "agent_task_output_unavailable", "Agent task output storage is not configured.");
    }

    const task = (await repository.getByTaskId(input.taskId)) ?? (await this.#recoverMissingAgentTask(input.taskId));
    if (!task) {
      throw new AppError(404, "agent_task_not_found", `Agent task ${input.taskId} was not found.`);
    }

    const run = await this.#lifecycle.getRun(task.childRunId);
    if (isRunTerminal(run.status)) {
      const terminalTask = await this.#ensureAgentTaskTerminalOutput(task, run);
      const retrievedTask = await this.#markAgentTaskRetrieved(terminalTask, run);
      return {
        retrievalStatus: "success",
        task: agentTaskOutputView(retrievedTask)
      };
    }

    if (input.block === false) {
      const latestTask = await this.#syncAgentTaskRunningState(task, run, { retrieved: false });
      return {
        retrievalStatus: "not_ready",
        task: agentTaskOutputView(latestTask, run)
      };
    }

    const completedRun = await waitForRunTerminalStateUntil(
      this.#lifecycle,
      task.childRunId,
      input.timeoutMs ?? 30_000,
      input.abortSignal
    );
    if (!completedRun || !isRunTerminal(completedRun.status)) {
      const latestTask = (await repository.getByTaskId(input.taskId)) ?? task;
      const latestRun = await this.#lifecycle.getRun(task.childRunId);
      const syncedTask = await this.#syncAgentTaskRunningState(latestTask, latestRun, { retrieved: false });
      return {
        retrievalStatus: "timeout",
        task: agentTaskOutputView(syncedTask, latestRun)
      };
    }

    const terminalTask = await this.#ensureAgentTaskTerminalOutput(task, completedRun);
    const retrievedTask = await this.#markAgentTaskRetrieved(terminalTask, completedRun);
    return {
      retrievalStatus: "success",
      task: agentTaskOutputView(retrievedTask)
    };
  }

  async persistTerminalOutput(input: PersistAgentTaskTerminalOutputInput): Promise<AgentTaskRecord | undefined> {
    if (!this.#persistence.agentTasks) {
      return undefined;
    }

    const existing = await this.#persistence.agentTasks.getByTaskId(input.taskId);
    if (!existing) {
      return this.#persistence.agentTasks.upsert({
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        parentSessionId: input.parentSessionId,
        parentRunId: input.parentRunId,
        childSessionId: input.childSessionId,
        childRunId: input.childRunId,
        ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
        targetAgentName: input.targetAgentName,
        parentAgentName: input.parentAgentName,
        status: input.status,
        outputRef: input.outputRef,
        outputFile: input.outputFile,
        taskState:
          input.taskState ??
          localAgentTaskState({
            taskId: input.taskId,
            prompt: "",
            agentType: input.targetAgentName,
            status: input.status,
            finalText: input.finalText,
            errorMessage: input.errorMessage,
            usage: input.usage,
            isBackgrounded: true,
            notified: input.notifiedAt !== undefined
          }),
        ...(input.finalText !== undefined ? { finalText: input.finalText } : {}),
        ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
        ...(input.usage !== undefined ? { usage: input.usage } : {}),
        ...(input.notifiedAt !== undefined ? { notifiedAt: input.notifiedAt } : {}),
        createdAt: input.updatedAt,
        updatedAt: input.updatedAt
      });
    }

    return this.#persistence.agentTasks.update({
      ...input,
      taskState:
        input.taskState ??
        localAgentTaskState({
          taskId: input.taskId,
          prompt: existing.description ?? "",
          agentType: existing.targetAgentName,
          existing: existing.taskState,
          status: input.status,
          finalText: input.finalText ?? existing.finalText,
          errorMessage: input.errorMessage ?? existing.errorMessage,
          usage: input.usage ?? existing.usage,
          isBackgrounded: existing.taskState?.isBackgrounded ?? true,
          notified: input.notifiedAt !== undefined ? true : existing.taskState?.notified
        })
    });
  }

  async #ensureAgentTaskTerminalOutput(task: AgentTaskRecord, run: Run): Promise<AgentTaskRecord> {
    if (!this.#persistence.agentTasks) {
      return task;
    }

    if (run.status === "completed") {
      const summary = await this.#collectAwaitedRunSummary(run.id);
      const usage = await summarizeChildRunUsage(run, this.#persistence.runSteps);
      await this.persistTerminalOutput({
        workspaceId: task.workspaceId,
        parentSessionId: task.parentSessionId,
        parentRunId: task.parentRunId,
        childSessionId: task.childSessionId,
        childRunId: task.childRunId,
        targetAgentName: task.targetAgentName,
        parentAgentName: task.parentAgentName,
        taskId: task.taskId,
        ...(task.toolUseId ? { toolUseId: task.toolUseId } : {}),
        status: "completed",
        outputRef: task.outputRef,
        outputFile: task.outputFile ?? taskOutputPath(task.parentSessionId, task.taskId),
        finalText: summary.outputContent ?? task.finalText ?? "",
        usage,
        taskState: localAgentTaskState({
          taskId: task.taskId,
          prompt: task.description ?? "",
          agentType: task.targetAgentName,
          existing: task.taskState,
          usage,
          status: "completed",
          finalText: summary.outputContent ?? task.finalText ?? "",
          isBackgrounded: task.taskState?.isBackgrounded ?? true
        }),
        updatedAt: this.#helpers.nowIso(),
        ...(task.notifiedAt ? { notifiedAt: task.notifiedAt } : {})
      });
    } else {
      const usage = await summarizeChildRunUsage(run, this.#persistence.runSteps);
      await this.persistTerminalOutput({
        workspaceId: task.workspaceId,
        parentSessionId: task.parentSessionId,
        parentRunId: task.parentRunId,
        childSessionId: task.childSessionId,
        childRunId: task.childRunId,
        targetAgentName: task.targetAgentName,
        parentAgentName: task.parentAgentName,
        taskId: task.taskId,
        ...(task.toolUseId ? { toolUseId: task.toolUseId } : {}),
        status: agentTaskStatusFromRun(run.status),
        outputRef: task.outputRef,
        outputFile: task.outputFile ?? taskOutputPath(task.parentSessionId, task.taskId),
        errorMessage: run.errorMessage ?? task.errorMessage ?? "",
        usage,
        taskState: localAgentTaskState({
          taskId: task.taskId,
          prompt: task.description ?? "",
          agentType: task.targetAgentName,
          existing: task.taskState,
          usage,
          status: agentTaskStatusFromRun(run.status),
          errorMessage: run.errorMessage ?? task.errorMessage ?? "",
          isBackgrounded: task.taskState?.isBackgrounded ?? true
        }),
        updatedAt: this.#helpers.nowIso(),
        ...(task.notifiedAt ? { notifiedAt: task.notifiedAt } : {})
      });
    }

    return (await this.#persistence.agentTasks.getByTaskId(task.taskId)) ?? task;
  }

  async #syncAgentTaskRunningState(
    task: AgentTaskRecord,
    run: Run,
    options: { retrieved?: boolean | undefined } = {}
  ): Promise<AgentTaskRecord> {
    if (!this.#persistence.agentTasks || isRunTerminal(run.status)) {
      return task;
    }

    const status: AgentTaskStatus = run.status === "queued" ? "queued" : "running";
    return this.#persistence.agentTasks.update({
      taskId: task.taskId,
      status,
      updatedAt: this.#helpers.nowIso(),
      taskState: localAgentTaskState({
        taskId: task.taskId,
        prompt: task.description ?? "",
        agentType: task.targetAgentName,
        existing: task.taskState,
        status,
        retrieved: options.retrieved ?? task.taskState?.retrieved,
        isBackgrounded: task.taskState?.isBackgrounded ?? true
      })
    });
  }

  async #markAgentTaskRetrieved(task: AgentTaskRecord, run?: Run | undefined): Promise<AgentTaskRecord> {
    if (!this.#persistence.agentTasks) {
      return task;
    }

    return this.#persistence.agentTasks.update({
      taskId: task.taskId,
      status: task.status,
      updatedAt: this.#helpers.nowIso(),
      taskState: localAgentTaskState({
        taskId: task.taskId,
        prompt: task.description ?? "",
        agentType: task.targetAgentName,
        existing: task.taskState,
        usage: task.usage,
        status: task.status,
        retrieved: true,
        isBackgrounded: task.taskState?.isBackgrounded ?? true,
        notified: task.notifiedAt !== undefined || task.taskState?.notified
      }),
      ...(task.finalText !== undefined ? { finalText: task.finalText } : {}),
      ...(task.errorMessage !== undefined ? { errorMessage: task.errorMessage } : {}),
      ...(task.usage !== undefined ? { usage: task.usage } : {}),
      ...(task.notifiedAt !== undefined ? { notifiedAt: task.notifiedAt } : {}),
      ...(task.outputRef !== undefined ? { outputRef: task.outputRef } : {}),
      ...(task.outputFile !== undefined ? { outputFile: task.outputFile } : {})
    }).catch(async () => {
      if (run && isRunTerminal(run.status)) {
        return this.#ensureAgentTaskTerminalOutput(task, run);
      }
      return task;
    });
  }

  async #recoverMissingAgentTask(taskId: string): Promise<AgentTaskRecord | null> {
    if (!this.#persistence.agentTasks) {
      return null;
    }

    const childSession = await this.#persistence.sessions.getById(taskId);
    if (!childSession?.parentSessionId) {
      return null;
    }

    const childRuns = await Promise.all(
      (await this.#persistence.messages.listBySessionId(taskId))
        .map((message) => message.runId)
        .filter((runId): runId is string => typeof runId === "string")
        .map(async (runId) => this.#persistence.runs.getById(runId))
    );
    const childRun = childRuns
      .filter((run): run is Run => run !== null)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
    if (!childRun?.parentRunId) {
      return null;
    }

    const parentRun = await this.#persistence.runs.getById(childRun.parentRunId);
    const delegatedRecord = parentRun ? delegatedRunRecords(parentRun).find((record) => record.childSessionId === taskId) : undefined;
    const now = this.#helpers.nowIso();
    const recovered = await this.#persistence.agentTasks.upsert({
      taskId,
      workspaceId: childRun.workspaceId,
      parentSessionId: childSession.parentSessionId,
      parentRunId: childRun.parentRunId,
      childSessionId: taskId,
      childRunId: childRun.id,
      ...(delegatedRecord?.toolUseId ? { toolUseId: delegatedRecord.toolUseId } : {}),
      targetAgentName: delegatedRecord?.targetAgentName ?? childRun.effectiveAgentName,
      parentAgentName: delegatedRecord?.parentAgentName ?? parentRun?.effectiveAgentName ?? childRun.effectiveAgentName,
      status:
        childRun.status === "queued" || childRun.status === "running" || childRun.status === "waiting_tool"
          ? childRun.status === "queued"
            ? "queued"
            : "running"
          : agentTaskStatusFromRun(childRun.status),
      description: typeof childRun.metadata?.delegatedTask === "string" ? childRun.metadata.delegatedTask : undefined,
      handoffSummary: typeof childRun.metadata?.handoffSummary === "string" ? childRun.metadata.handoffSummary : undefined,
      outputRef: taskOutputRef(taskId),
      outputFile: taskOutputPath(childSession.parentSessionId, taskId),
      taskState: localAgentTaskState({
        taskId,
        prompt: typeof childRun.metadata?.delegatedTask === "string" ? childRun.metadata.delegatedTask : "",
        agentType: delegatedRecord?.targetAgentName ?? childRun.effectiveAgentName,
        status:
          childRun.status === "queued" || childRun.status === "running" || childRun.status === "waiting_tool"
            ? childRun.status === "queued"
              ? "queued"
              : "running"
            : agentTaskStatusFromRun(childRun.status),
        isBackgrounded: delegatedRecord?.notifyParentOnCompletion ?? true,
        notified: false
      }),
      createdAt: childRun.createdAt,
      updatedAt: now
    });

    if (isRunTerminal(childRun.status)) {
      return (
        (await this.#ensureAgentTaskTerminalOutput(recovered, childRun)) ??
        (await this.#persistence.agentTasks.getByTaskId(taskId))
      );
    }

    return recovered;
  }
}
