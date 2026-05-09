import type { Message, Run, Session } from "@oah/api-contracts";

import { AppError } from "../errors.js";
import { textContent } from "../execution-message-content.js";
import { canDelegateFromAgent } from "../capabilities/engine-capabilities.js";
import {
  buildDelegatedRunCompletedMessage,
  buildDelegatedRunFailedMessage,
  buildDelegatedTaskMessage,
  renderAwaitedRunSummary,
  taskOutputPath
} from "./agent-delegation-messages.js";
import type { AgentTaskNotificationRecord, AgentTaskRecord, AgentTaskStatus, WorkspaceRecord } from "../types.js";
import type {
  AgentCoordinationHelpers,
  AgentCoordinationLifecycle,
  AgentCoordinationPersistence,
  AgentCoordinationServiceDependencies,
  AgentTaskOutputReadResult,
  AgentTaskOutputView,
  AwaitedRunSummary,
  DelegatedNotificationBatchState,
  DelegatedRunMonitorState,
  DelegatedRunRecord
} from "./agent-coordination-types.js";

export type {
  AgentCoordinationHelpers,
  AgentCoordinationLifecycle,
  AgentCoordinationPersistence,
  AgentCoordinationServiceDependencies,
  AgentTaskOutputReadResult,
  AgentTaskOutputView,
  AwaitedRunSummary,
  DelegatedRunRecord
} from "./agent-coordination-types.js";

const delegatedOutputFollowUpPrompt = [
  "Your previous delegated run completed, but it did not produce a readable final output for the parent agent.",
  "Please respond now with only the final result of the delegated task.",
  "Do not call tools. Do not quote raw tool output. Synthesize the answer from the work already done.",
  "If there is nothing to report, say that explicitly."
].join("\n");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

export class AgentCoordinationService {
  readonly #persistence: AgentCoordinationPersistence;
  readonly #lifecycle: AgentCoordinationLifecycle;
  readonly #helpers: AgentCoordinationHelpers;
  readonly #delegationQueues = new Map<string, Promise<void>>();
  readonly #delegatedRunMonitors = new Map<string, DelegatedRunMonitorState>();

  constructor(dependencies: AgentCoordinationServiceDependencies) {
    this.#persistence = dependencies.persistence;
    this.#lifecycle = dependencies.lifecycle;
    this.#helpers = dependencies.helpers;
  }

  delegatedRunRecords(run: Run): DelegatedRunRecord[] {
    const rawRecords = run.metadata?.delegatedRuns;
    if (!Array.isArray(rawRecords)) {
      return [];
    }

    return rawRecords.flatMap((entry) => {
      if (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { childRunId?: unknown }).childRunId === "string" &&
        typeof (entry as { childSessionId?: unknown }).childSessionId === "string" &&
        typeof (entry as { targetAgentName?: unknown }).targetAgentName === "string" &&
        typeof (entry as { parentAgentName?: unknown }).parentAgentName === "string"
      ) {
        return [
          {
            childRunId: (entry as { childRunId: string }).childRunId,
            childSessionId: (entry as { childSessionId: string }).childSessionId,
            targetAgentName: (entry as { targetAgentName: string }).targetAgentName,
            parentAgentName: (entry as { parentAgentName: string }).parentAgentName,
            ...(typeof (entry as { notifyParentOnCompletion?: unknown }).notifyParentOnCompletion === "boolean"
              ? { notifyParentOnCompletion: (entry as { notifyParentOnCompletion: boolean }).notifyParentOnCompletion }
              : {}),
            ...(typeof (entry as { toolUseId?: unknown }).toolUseId === "string"
              ? { toolUseId: (entry as { toolUseId: string }).toolUseId }
              : {})
          }
        ];
      }

      return [];
    });
  }

  async switchAgent(input: {
    session: Session;
    run: Run;
    currentAgentName: string;
    targetAgentName: string;
  }): Promise<{ switchCount: number }> {
    const switchStep = await this.#lifecycle.startRunStep({
      runId: input.run.id,
      stepType: "agent_switch",
      name: `${input.currentAgentName}->${input.targetAgentName}`,
      agentName: input.currentAgentName,
      input: {
        fromAgent: input.currentAgentName,
        toAgent: input.targetAgentName
      }
    });
    await this.#lifecycle.appendEvent({
      sessionId: input.session.id,
      runId: input.run.id,
      event: "agent.switch.requested",
      data: {
        runId: input.run.id,
        sessionId: input.session.id,
        fromAgent: input.currentAgentName,
        toAgent: input.targetAgentName
      }
    });

    const latestRun = await this.#lifecycle.getRun(input.run.id);
    const nextSwitchCount = (latestRun.switchCount ?? 0) + 1;
    await this.#lifecycle.updateRun(latestRun, {
      effectiveAgentName: input.targetAgentName,
      switchCount: nextSwitchCount
    });
    await this.#lifecycle.completeRunStep(switchStep, "completed", {
      fromAgent: input.currentAgentName,
      toAgent: input.targetAgentName,
      switchCount: nextSwitchCount
    });

    await this.#lifecycle.appendEvent({
      sessionId: input.session.id,
      runId: input.run.id,
      event: "agent.switched",
      data: {
        runId: input.run.id,
        sessionId: input.session.id,
        fromAgent: input.currentAgentName,
        toAgent: input.targetAgentName,
        switchCount: nextSwitchCount
      }
    });

    return { switchCount: nextSwitchCount };
  }

  async delegateAgentRun(input: {
    workspace: WorkspaceRecord;
    parentSession: Session;
    parentRun: Run;
    currentAgentName: string;
    targetAgentName?: string | undefined;
    task: string;
    handoffSummary?: string | undefined;
    taskId?: string | undefined;
    notifyParentOnCompletion?: boolean | undefined;
    toolUseId?: string | undefined;
    canReadOutputFile?: boolean | undefined;
  }): Promise<{
    childSessionId: string;
    childRunId: string;
    targetAgentName: string;
    outputRef: string;
    outputFile: string;
    canReadOutputFile: boolean;
  }> {
    if (!canDelegateFromAgent(input.workspace, input.currentAgentName)) {
      throw new AppError(
        403,
        "agent_delegate_not_allowed",
        `Agent ${input.currentAgentName} is not allowed to delegate subagent work.`
      );
    }

    const resumedSession = input.taskId ? await this.#persistence.sessions.getById(input.taskId) : null;
    if (input.taskId && !resumedSession) {
      throw new AppError(404, "task_not_found", `Subagent task ${input.taskId} was not found.`);
    }

    if (resumedSession && resumedSession.workspaceId !== input.workspace.id) {
      throw new AppError(
        409,
        "task_workspace_mismatch",
        `Subagent task ${input.taskId} does not belong to workspace ${input.workspace.id}.`
      );
    }

    const resolvedTargetAgentName =
      input.targetAgentName ?? resumedSession?.activeAgentName ?? resumedSession?.agentName;
    if (!resolvedTargetAgentName) {
      throw new AppError(400, "agent_type_required", "SubAgent requires subagent_name or a resumable task_id.");
    }

    const allowedTargets = input.workspace.agents[input.currentAgentName]?.subagents ?? [];
    if (!allowedTargets.includes(resolvedTargetAgentName)) {
      throw new AppError(
        403,
        "agent_delegate_not_allowed",
        `Agent ${input.currentAgentName} is not allowed to delegate to ${resolvedTargetAgentName}.`
      );
    }

    const targetAgent = input.workspace.agents[resolvedTargetAgentName];
    if (!targetAgent) {
      throw new AppError(
        404,
        "agent_not_found",
        `Agent ${resolvedTargetAgentName} was not found in workspace ${input.workspace.id}.`
      );
    }

    if (targetAgent.mode === "primary") {
      throw new AppError(
        409,
        "invalid_subagent_target",
        `Agent ${resolvedTargetAgentName} is a primary agent and cannot be used as a subagent target.`
      );
    }

    if (
      resumedSession &&
      input.targetAgentName &&
      resumedSession.activeAgentName !== input.targetAgentName &&
      resumedSession.agentName !== input.targetAgentName
    ) {
      throw new AppError(
        409,
        "task_agent_mismatch",
        `Subagent task ${input.taskId} is currently associated with ${resumedSession.activeAgentName}, not ${input.targetAgentName}.`
      );
    }

    return this.#serializeDelegation(input.parentRun.id, async () => {
      const latestParentRun = await this.#lifecycle.getRun(input.parentRun.id);
      await this.#enforceSubagentConcurrencyLimit(input.workspace, latestParentRun, input.currentAgentName);
      const resumedActiveRun = resumedSession ? await this.#activeRunForSession(resumedSession.id) : null;

      const delegateStep = await this.#lifecycle.startRunStep({
        runId: input.parentRun.id,
        stepType: "agent_delegate",
        name: resolvedTargetAgentName,
        agentName: input.currentAgentName,
        input: {
          targetAgent: resolvedTargetAgentName,
          task: input.task,
          ...(input.handoffSummary ? { handoffSummary: input.handoffSummary } : {}),
          ...(input.taskId ? { taskId: input.taskId } : {}),
          ...(input.toolUseId ? { toolUseId: input.toolUseId } : {})
        }
      });

      const now = this.#helpers.nowIso();
      const childSessionId = resumedSession?.id ?? this.#helpers.createId("ses");
      const childRunId = this.#helpers.createId("run");
      const parentModelRef = this.#helpers.resolveModelForRun(
        input.workspace,
        input.parentSession.modelRef ?? input.workspace.agents[input.currentAgentName]?.modelRef
      ).canonicalModelRef;
      const childSession: Session = resumedSession ?? {
        id: childSessionId,
        workspaceId: input.workspace.id,
        parentSessionId: input.parentSession.id,
        subjectRef: input.parentSession.subjectRef,
        ...(input.parentSession.modelRef ? { modelRef: input.parentSession.modelRef } : {}),
        agentName: resolvedTargetAgentName,
        activeAgentName: resolvedTargetAgentName,
        title: `Agent ${resolvedTargetAgentName}`,
        status: "active",
        createdAt: now,
        updatedAt: now
      };
      const childMessage: Message = {
        id: this.#helpers.createId("msg"),
        sessionId: childSessionId,
        role: "user",
        content: textContent(
          buildDelegatedTaskMessage(
            input.currentAgentName,
            resolvedTargetAgentName,
            input.task,
            input.handoffSummary
          )
        ),
        metadata: {
          parentRunId: input.parentRun.id,
          parentSessionId: input.parentSession.id,
          delegatedByAgent: input.currentAgentName,
          ...(input.toolUseId ? { delegatedToolUseId: input.toolUseId } : {}),
          ...(input.taskId ? { delegatedTaskId: input.taskId } : {})
        },
        createdAt: now
      };
      const childRun: Run = {
        id: childRunId,
        workspaceId: input.workspace.id,
        sessionId: childSessionId,
        parentRunId: input.parentRun.id,
        initiatorRef: input.parentRun.initiatorRef ?? input.parentSession.subjectRef,
        triggerType: "system",
        triggerRef: "agent.delegate",
        agentName: childSession.activeAgentName,
        effectiveAgentName: childSession.activeAgentName,
        switchCount: 0,
        status: "queued",
        createdAt: now,
        metadata: {
          parentRunId: input.parentRun.id,
          parentSessionId: input.parentSession.id,
          parentAgentName: input.currentAgentName,
          delegatedTask: input.task,
          ...(input.handoffSummary ? { handoffSummary: input.handoffSummary } : {}),
          ...(input.taskId ? { taskId: input.taskId } : {}),
          ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
          ...(targetAgent.modelRef ? {} : { inheritedModelRef: parentModelRef })
        }
      };

      if (resumedSession) {
        await this.#persistence.sessions.update({
          ...childSession,
          status: "active",
          updatedAt: now
        });
      } else {
        await this.#persistence.sessions.create(childSession);
      }
      await this.#persistence.messages.create(childMessage);
      await this.#persistence.runs.create(childRun);

      const outputRef = this.#taskOutputRef(childSessionId);
      const outputFile = taskOutputPath(input.parentSession.id, childSessionId);
      const existingAgentTask = input.taskId ? await this.#persistence.agentTasks?.getByTaskId(input.taskId) : null;
      await this.#persistence.agentTasks?.upsert({
        taskId: childSessionId,
        workspaceId: input.workspace.id,
        parentSessionId: input.parentSession.id,
        parentRunId: input.parentRun.id,
        childSessionId,
        childRunId,
        ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
        targetAgentName: resolvedTargetAgentName,
        parentAgentName: input.currentAgentName,
        status: "queued",
        description: input.task,
        ...(input.handoffSummary ? { handoffSummary: input.handoffSummary } : {}),
        outputRef,
        outputFile,
        taskState: this.#localAgentTaskState({
          taskId: childSessionId,
          prompt: input.task,
          agentType: resolvedTargetAgentName,
          model: targetAgent.modelRef ?? parentModelRef,
          existing: existingAgentTask?.taskState,
          pendingMessage: resumedActiveRun ? input.task : undefined,
          status: "queued",
          isBackgrounded: input.notifyParentOnCompletion ?? existingAgentTask?.taskState?.isBackgrounded ?? false,
          notified: false
        }),
        createdAt: now,
        updatedAt: now
      });

      await this.#appendDelegatedRunRecord(input.parentRun.id, {
        childRunId,
        childSessionId,
        targetAgentName: resolvedTargetAgentName,
        parentAgentName: input.currentAgentName,
        ...(input.notifyParentOnCompletion ? { notifyParentOnCompletion: true } : {}),
        ...(input.toolUseId ? { toolUseId: input.toolUseId } : {})
      });

      await this.#lifecycle.appendEvent({
        sessionId: input.parentSession.id,
        runId: input.parentRun.id,
        event: "agent.delegate.started",
        data: {
          runId: input.parentRun.id,
          sessionId: input.parentSession.id,
          agentName: input.currentAgentName,
          targetAgent: resolvedTargetAgentName,
          childSessionId,
          childRunId,
          ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
          ...(input.taskId ? { taskId: input.taskId, resumed: true } : {})
        }
      });
      await this.#lifecycle.completeRunStep(delegateStep, "completed", {
        targetAgent: resolvedTargetAgentName,
        childSessionId,
        childRunId,
        ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
        ...(input.taskId ? { taskId: input.taskId, resumed: true } : {})
      });

      const delivery = await this.#enqueueChildRunRespectingSessionQueue({
        childSessionId,
        childRunId,
        createdAt: now,
        hasActiveRun: resumedActiveRun !== null
      });
      void this.#startDelegatedRunMonitor({
        parentSessionId: input.parentSession.id,
        parentRunId: input.parentRun.id,
        parentAgentName: input.currentAgentName,
        targetAgentName: resolvedTargetAgentName,
        childRunId,
        ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
        notifyParentOnCompletion: input.notifyParentOnCompletion ?? false
      });

      return {
        childSessionId,
        childRunId,
        targetAgentName: resolvedTargetAgentName,
        outputRef,
        outputFile,
        canReadOutputFile: input.canReadOutputFile ?? false
      };
    });
  }

  async #enqueueChildRunRespectingSessionQueue(input: {
    childSessionId: string;
    childRunId: string;
    createdAt: string;
    hasActiveRun: boolean;
  }): Promise<"active_run" | "session_queue"> {
    if (input.hasActiveRun && this.#persistence.sessionPendingRuns) {
      await this.#persistence.sessionPendingRuns.enqueue({
        sessionId: input.childSessionId,
        runId: input.childRunId,
        createdAt: input.createdAt
      });
      await this.#lifecycle.appendEvent({
        sessionId: input.childSessionId,
        runId: input.childRunId,
        event: "queue.updated",
        data: {
          runId: input.childRunId,
          action: "enqueued",
          source: "subagent_pending_message"
        }
      });
      return "session_queue";
    }

    await this.#lifecycle.enqueueRun(input.childSessionId, input.childRunId, {
      priority: "subagent"
    });
    return "active_run";
  }

  async awaitDelegatedRuns(runIds: string[], mode: "all" | "any"): Promise<string> {
    const awaitedRuns =
      mode === "any"
        ? [await this.#waitForAnyRunTerminalState(runIds)]
        : await Promise.all(runIds.map(async (runId) => this.#waitForRunTerminalState(runId)));
    const summaries = await Promise.all(awaitedRuns.map(async (run) => this.#collectAwaitedRunSummary(run.id)));
    const rendered = summaries.map((summary) => renderAwaitedRunSummary(summary));

    if (rendered.length === 1) {
      return rendered[0] ?? "";
    }

    return [`mode: ${mode}`, `results: ${rendered.length}`, "", rendered.join("\n\n")].join("\n");
  }

  async readAgentTaskOutput(input: {
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
    if (this.#isRunTerminal(run.status)) {
      const terminalTask = await this.#ensureAgentTaskTerminalOutput(task, run);
      const retrievedTask = await this.#markAgentTaskRetrieved(terminalTask, run);
      return {
        retrievalStatus: "success",
        task: this.#agentTaskOutputView(retrievedTask)
      };
    }

    if (input.block === false) {
      const latestTask = await this.#syncAgentTaskRunningState(task, run, { retrieved: false });
      return {
        retrievalStatus: "not_ready",
        task: this.#agentTaskOutputView(latestTask, run)
      };
    }

    const completedRun = await this.#waitForRunTerminalStateUntil(
      task.childRunId,
      input.timeoutMs ?? 30_000,
      input.abortSignal
    );
    if (!completedRun || !this.#isRunTerminal(completedRun.status)) {
      const latestTask = (await repository.getByTaskId(input.taskId)) ?? task;
      const latestRun = await this.#lifecycle.getRun(task.childRunId);
      const syncedTask = await this.#syncAgentTaskRunningState(latestTask, latestRun, { retrieved: false });
      return {
        retrievalStatus: "timeout",
        task: this.#agentTaskOutputView(syncedTask, latestRun)
      };
    }

    const terminalTask = await this.#ensureAgentTaskTerminalOutput(task, completedRun);
    const retrievedTask = await this.#markAgentTaskRetrieved(terminalTask, completedRun);
    return {
      retrievalStatus: "success",
      task: this.#agentTaskOutputView(retrievedTask)
    };
  }

  async drainPendingTaskNotifications(input: {
    parentSessionId: string;
    runId: string;
    parentAgentName: string;
  }): Promise<{ messageIds: string[] }> {
    const repository = this.#persistence.agentTaskNotifications;
    if (!repository) {
      return { messageIds: [] };
    }

    let pending = await repository.listPendingBySessionId(input.parentSessionId);
    if (pending.length === 0) {
      return { messageIds: [] };
    }

    const targetRun = await this.#lifecycle.getRun(input.runId);
    if (typeof targetRun.metadata?.taskNotificationBatchParentRunId === "string") {
      pending = pending.filter((notification) => notification.parentRunId === targetRun.metadata?.taskNotificationBatchParentRunId);
    }

    const drainable = await this.#filterDrainableTaskNotifications(input.parentSessionId, pending);
    if (drainable.length === 0) {
      return { messageIds: [] };
    }

    const consumedAt = this.#helpers.nowIso();
    const messages: Message[] = [];
    for (const notification of drainable) {
      const existingMessage = await this.#persistence.messages.getById(notification.id);
      const deliveredMessage: Message = {
        id: notification.id,
        sessionId: input.parentSessionId,
        runId: existingMessage?.runId ?? input.runId,
        role: "user",
        origin: "engine",
        mode: "task-notification",
        content: textContent(notification.content),
        metadata: {
          ...(existingMessage?.metadata ?? {}),
          ...notification.metadata,
          agentName: input.parentAgentName,
          effectiveAgentName: input.parentAgentName,
          runtimeKind: "task_notification",
          origin: "engine",
          mode: "task-notification",
          source: "engine",
          synthetic: true,
          taskNotification: true,
          pendingTaskNotificationId: notification.id,
          taskNotificationConsumedAt: consumedAt,
          taskNotificationDeliveredToModel: true,
          taskNotificationPendingModelDelivery: false,
          eligibleForModelContext: true,
          visibleInTranscript: true
        },
        createdAt: notification.createdAt
      };
      messages.push(existingMessage ? await this.#persistence.messages.update(deliveredMessage) : await this.#persistence.messages.create(deliveredMessage));
    }

    await repository.markConsumed({
      ids: drainable.map((notification) => notification.id),
      consumedAt
    });

    for (const message of messages) {
      await this.#lifecycle.appendEvent({
        sessionId: input.parentSessionId,
        runId: input.runId,
        event: "message.completed",
        data: {
          runId: input.runId,
          sessionId: input.parentSessionId,
          messageId: message.id,
          role: message.role,
          origin: message.origin,
          mode: message.mode,
          content: message.content,
          ...(message.metadata ? { metadata: message.metadata } : {})
        }
      });
    }

    return { messageIds: messages.map((message) => message.id) };
  }

  async #persistVisiblePendingTaskNotification(input: {
    parentSessionId: string;
    parentRunId: string;
    parentAgentName: string;
    taskId: string;
    message: Message;
  }): Promise<Message> {
    const existingMessage = await this.#persistence.messages.getById(input.message.id);
    if (existingMessage) {
      return existingMessage;
    }

    const message = await this.#persistence.messages.create({
      ...input.message,
      metadata: {
        ...(input.message.metadata ?? {}),
        agentName: input.parentAgentName,
        effectiveAgentName: input.parentAgentName,
        runtimeKind: "task_notification",
        origin: "engine",
        mode: "task-notification",
        source: "engine",
        synthetic: true,
        taskNotification: true,
        pendingTaskNotificationId: input.message.id,
        taskNotificationPendingModelDelivery: true,
        eligibleForModelContext: false,
        visibleInTranscript: true
      }
    });
    await this.#lifecycle.appendEvent({
      sessionId: input.parentSessionId,
      runId: input.parentRunId,
      event: "message.completed",
      data: {
        runId: input.parentRunId,
        sessionId: input.parentSessionId,
        messageId: message.id,
        role: message.role,
        origin: message.origin,
        mode: message.mode,
        content: message.content,
        taskId: input.taskId,
        ...(message.metadata ? { metadata: message.metadata } : {})
      }
    });

    return message;
  }

  async persistUnreportedTerminalDelegatedRuns(input: {
    workspace: WorkspaceRecord;
    parentSessionId: string;
    parentRun: Run;
    parentAgentName: string;
  }): Promise<{ childRunIds: string[] }> {
    const latestParentRun = await this.#lifecycle.getRun(input.parentRun.id);
    const records = this.delegatedRunRecords(latestParentRun);
    if (records.length === 0) {
      return { childRunIds: [] };
    }

    const childRuns = await Promise.all(
      records
        .filter((record) => record.notifyParentOnCompletion === true)
        .map(async (record) => ({
          record,
          run: await this.#persistence.runs.getById(record.childRunId)
        }))
    );
    const unreportedTerminalRuns: Array<{ record: DelegatedRunRecord; run: Run }> = [];
    for (const { record, run } of childRuns) {
      if (!run || !this.#isRunTerminal(run.status)) {
        continue;
      }

      const alreadyReported = await this.#hasDelegatedRunTerminalMessage({
        parentSessionId: input.parentSessionId,
        childRunId: run.id,
        ...(run.sessionId ? { childSessionId: run.sessionId } : {})
      });
      if (!alreadyReported) {
        unreportedTerminalRuns.push({ record, run });
      }
    }

    for (const { record, run } of unreportedTerminalRuns) {
      await this.#persistDelegatedRunTerminalUpdate({
        parentSessionId: input.parentSessionId,
        parentRunId: input.parentRun.id,
        parentAgentName: input.parentAgentName,
        ...(record.toolUseId ? { toolUseId: record.toolUseId } : {}),
        childRun: run
      });
    }

    return { childRunIds: unreportedTerminalRuns.map((entry) => entry.run.id) };
  }

  async #enforceSubagentConcurrencyLimit(
    workspace: WorkspaceRecord,
    parentRun: Run,
    currentAgentName: string
  ): Promise<void> {
    const maxConcurrentSubagents = workspace.agents[currentAgentName]?.policy?.maxConcurrentSubagents;
    if (maxConcurrentSubagents === undefined) {
      return;
    }

    const childRuns = await Promise.all(
      this.delegatedRunRecords(parentRun).map(async (record) => this.#persistence.runs.getById(record.childRunId))
    );
    const activeRuns = childRuns.filter(
      (run): run is Run => run !== null && (run.status === "queued" || run.status === "running" || run.status === "waiting_tool")
    );

    if (activeRuns.length >= maxConcurrentSubagents) {
      throw new AppError(
        409,
        "subagent_concurrency_limit_exceeded",
        `Agent ${currentAgentName} reached max_concurrent_subagents=${maxConcurrentSubagents}.`
      );
    }
  }

  async #serializeDelegation<T>(parentRunId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#delegationQueues.get(parentRunId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.#delegationQueues.set(parentRunId, queued);

    await previous.catch(() => undefined);

    try {
      return await operation();
    } finally {
      release();
      if (this.#delegationQueues.get(parentRunId) === queued) {
        this.#delegationQueues.delete(parentRunId);
      }
    }
  }

  #startDelegatedRunMonitor(input: {
    parentSessionId: string;
    parentRunId: string;
    parentAgentName: string;
    targetAgentName: string;
    childRunId: string;
    toolUseId?: string | undefined;
    notifyParentOnCompletion: boolean;
  }): Promise<void> {
    const existing = this.#delegatedRunMonitors.get(input.childRunId);
    if (existing) {
      existing.notifyParentOnCompletion ||= input.notifyParentOnCompletion;
      return existing.promise ?? Promise.resolve();
    }

    const state: DelegatedRunMonitorState = {
      notifyParentOnCompletion: input.notifyParentOnCompletion
    };
    const monitor = this.#monitorDelegatedRun(input, state).finally(() => {
      if (this.#delegatedRunMonitors.get(input.childRunId) === state) {
        this.#delegatedRunMonitors.delete(input.childRunId);
      }
    });
    state.promise = monitor;
    this.#delegatedRunMonitors.set(input.childRunId, state);
    return monitor;
  }

  async #monitorDelegatedRun(input: {
    parentSessionId: string;
    parentRunId: string;
    parentAgentName: string;
    targetAgentName: string;
    childRunId: string;
    toolUseId?: string | undefined;
    notifyParentOnCompletion: boolean;
  }, state?: DelegatedRunMonitorState | undefined): Promise<void> {
    const childRun = await this.#waitForRunTerminalState(input.childRunId);
    const childSummary = await this.#collectAwaitedRunSummary(input.childRunId);
    const alreadyReported = await this.#hasDelegatedRunTerminalMessage({
      parentSessionId: input.parentSessionId,
      childRunId: input.childRunId,
      childSessionId: childRun.sessionId
    });
    if (alreadyReported) {
      return;
    }

    if (childRun.status === "completed") {
      if (state?.notifyParentOnCompletion ?? input.notifyParentOnCompletion) {
        await this.#persistDelegatedRunUpdate({
          parentSessionId: input.parentSessionId,
          parentRunId: input.parentRunId,
          parentAgentName: input.parentAgentName,
          ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
          childSummary
        });
      }
      await this.#lifecycle.appendEvent({
        sessionId: input.parentSessionId,
        runId: input.parentRunId,
        event: "agent.delegate.completed",
        data: {
          runId: input.parentRunId,
          sessionId: input.parentSessionId,
          agentName: input.parentAgentName,
          targetAgent: input.targetAgentName,
          childRunId: input.childRunId,
          childStatus: childRun.status,
          output: childSummary.outputContent ?? ""
        }
      });
      return;
    }

    if (state?.notifyParentOnCompletion ?? input.notifyParentOnCompletion) {
      await this.#persistDelegatedRunFailure({
        parentSessionId: input.parentSessionId,
        parentRunId: input.parentRunId,
        parentAgentName: input.parentAgentName,
        ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
        childRun
      });
    }
    await this.#lifecycle.appendEvent({
      sessionId: input.parentSessionId,
      runId: input.parentRunId,
      event: "agent.delegate.failed",
      data: {
        runId: input.parentRunId,
        sessionId: input.parentSessionId,
        agentName: input.parentAgentName,
        targetAgent: input.targetAgentName,
        childRunId: input.childRunId,
        childStatus: childRun.status,
        errorCode: childRun.errorCode,
        errorMessage: childRun.errorMessage
      }
    });
  }

  async #waitForRunTerminalState(runId: string): Promise<Run> {
    while (true) {
      const run = await this.#lifecycle.getRun(runId);
      if (this.#isRunTerminal(run.status)) {
        return run;
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async #waitForAnyRunTerminalState(runIds: string[]): Promise<Run> {
    while (true) {
      const runs = await Promise.all(runIds.map(async (runId) => this.#lifecycle.getRun(runId)));
      const completedRun = runs.find((run) => this.#isRunTerminal(run.status));
      if (completedRun) {
        return completedRun;
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async #waitForRunTerminalStateUntil(
    runId: string,
    timeoutMs: number,
    abortSignal?: AbortSignal | undefined
  ): Promise<Run | null> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (abortSignal?.aborted) {
        throw new AppError(499, "run_cancelled", "Task output wait was cancelled.");
      }

      const run = await this.#lifecycle.getRun(runId);
      if (this.#isRunTerminal(run.status)) {
        return run;
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    return this.#lifecycle.getRun(runId);
  }

  #isRunTerminal(status: Run["status"]): boolean {
    return status === "completed" || status === "failed" || status === "cancelled" || status === "timed_out";
  }

  async #collectAwaitedRunSummary(
    runId: string,
    options: { allowOutputFollowUp?: boolean | undefined } = { allowOutputFollowUp: true }
  ): Promise<AwaitedRunSummary> {
    const run = await this.#lifecycle.getRun(runId);
    if (!run.sessionId) {
      return { run };
    }

    const messages = await this.#persistence.messages.listBySessionId(run.sessionId);
    const outputContent = this.#extractRunOutputContent(messages, run.id);
    if (this.#helpers.hasMeaningfulText(outputContent)) {
      return { run, outputContent };
    }

    if (run.status === "completed" && options.allowOutputFollowUp !== false) {
      const followUpRun = await this.#ensureDelegatedOutputFollowUpRun(run, messages);
      const completedFollowUpRun = await this.#waitForRunTerminalState(followUpRun.id);
      const followUpSummary = await this.#collectAwaitedRunSummary(completedFollowUpRun.id, {
        allowOutputFollowUp: false
      });
      if (this.#helpers.hasMeaningfulText(followUpSummary.outputContent)) {
        return {
          run,
          outputContent: followUpSummary.outputContent
        };
      }
    }

    return { run };
  }

  #extractRunOutputContent(messages: Message[], runId: string): string | undefined {
    const runMessages = messages.filter((message) => message.runId === runId);
    const assistantMessages = [...runMessages].reverse().filter((message) => message.role === "assistant");
    let sawAssistantText = false;

    for (const assistantMessage of assistantMessages) {
      const assistantContent = this.#helpers.extractMessageDisplayText(assistantMessage);
      if (!this.#helpers.hasMeaningfulText(assistantContent)) {
        continue;
      }

      sawAssistantText = true;
      if (this.#isAssistantMessageStillUsingTools(assistantMessage)) {
        if (this.#isAssistantMessagePureToolUse(assistantMessage)) {
          continue;
        }
        return undefined;
      }

      if (!this.#looksLikeIntermediateSubagentProgress(assistantContent)) {
        return assistantContent;
      }
    }

    if (sawAssistantText) {
      return undefined;
    }

    const failedToolMessage = [...runMessages].reverse().find((message) => this.#isFailedToolResultMessage(message));
    const failedToolContent = failedToolMessage ? this.#helpers.extractMessageDisplayText(failedToolMessage) : undefined;
    return this.#helpers.hasMeaningfulText(failedToolContent) ? failedToolContent : undefined;
  }

  #isFailedToolResultMessage(message: Message): boolean {
    if (message.role !== "tool") {
      return false;
    }

    if (message.metadata?.toolStatus === "failed") {
      return true;
    }

    if (!Array.isArray(message.content)) {
      return false;
    }

    return message.content.some((part) => {
      if (part.type !== "tool-result") {
        return false;
      }
      const output = part.output;
      return isRecord(output) && (output.type === "error-text" || output.type === "error-json");
    });
  }

  #isAssistantMessageStillUsingTools(message: Message | undefined): boolean {
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
      return false;
    }

    return message.content.some((part) => part.type === "tool-call");
  }

  #isAssistantMessagePureToolUse(message: Message | undefined): boolean {
    if (!message || message.role !== "assistant" || !Array.isArray(message.content) || message.content.length === 0) {
      return false;
    }

    return message.content.every((part) => {
      if (part.type === "tool-call") {
        return true;
      }
      if (part.type === "text" && typeof part.text === "string") {
        return part.text.trim().length === 0;
      }
      return false;
    });
  }

  #looksLikeIntermediateSubagentProgress(content: string): boolean {
    const trimmed = content.trim();
    if (!trimmed) {
      return true;
    }

    const normalized = trimmed.toLowerCase();
    const progressPrefixes = [
      "let me ",
      "now let me ",
      "i need to ",
      "i will ",
      "i'll ",
      "i should ",
      "让我",
      "我需要",
      "我将",
      "现在让我",
      "继续搜索",
      "尝试搜索"
    ];
    const progressFragments = [
      "let me try",
      "let me search",
      "let me continue",
      "try to find",
      "search for",
      "获取成功了",
      "重新搜索",
      "继续搜索",
      "尝试搜索"
    ];
    return (
      progressPrefixes.some((marker) => normalized.startsWith(marker)) ||
      progressFragments.some((marker) => normalized.includes(marker))
    );
  }

  async #ensureDelegatedOutputFollowUpRun(completedRun: Run, messages: Message[]): Promise<Run> {
    const existingFollowUpMessage = [...messages].reverse().find((message) => {
      const metadata = message.metadata as { delegatedOutputFollowUpForRunId?: unknown } | undefined;
      return (
        message.role === "user" &&
        typeof message.runId === "string" &&
        metadata?.delegatedOutputFollowUpForRunId === completedRun.id
      );
    });

    if (existingFollowUpMessage?.runId) {
      const existingRun = await this.#persistence.runs.getById(existingFollowUpMessage.runId);
      if (existingRun) {
        return existingRun;
      }
    }

    const completedRunSessionId = completedRun.sessionId;
    if (!completedRunSessionId) {
      return completedRun;
    }

    const session = await this.#persistence.sessions.getById(completedRunSessionId);
    if (!session) {
      throw new AppError(404, "session_not_found", `Session ${completedRun.sessionId} was not found.`);
    }

    const now = this.#helpers.nowIso();
    const messageId = this.#helpers.createId("msg");
    const runId = this.#helpers.createId("run");
    const followUpRun: Run = {
      id: runId,
      workspaceId: completedRun.workspaceId,
      sessionId: session.id,
      parentRunId: completedRun.parentRunId,
      initiatorRef: completedRun.initiatorRef ?? session.subjectRef,
      triggerType: "message",
      triggerRef: messageId,
      agentName: session.activeAgentName,
      effectiveAgentName: session.activeAgentName,
      switchCount: 0,
      status: "queued",
      createdAt: now,
      metadata: {
        delegatedOutputFollowUpForRunId: completedRun.id
      }
    };
    const followUpMessage: Message = {
      id: messageId,
      sessionId: session.id,
      runId,
      role: "user",
      content: textContent(delegatedOutputFollowUpPrompt),
      metadata: {
        synthetic: true,
        delegatedOutputFollowUpForRunId: completedRun.id
      },
      createdAt: now
    };

    await this.#persistence.runs.create(followUpRun);
    await this.#persistence.messages.create(followUpMessage);
    await this.#lifecycle.appendEvent({
      sessionId: session.id,
      runId,
      event: "run.queued",
      data: {
        runId,
        sessionId: session.id,
        status: "queued",
        delegatedOutputFollowUpForRunId: completedRun.id
      }
    });
    await this.#lifecycle.enqueueRun(session.id, runId, {
      priority: "subagent"
    });

    return followUpRun;
  }

  async #appendDelegatedRunRecord(parentRunId: string, record: DelegatedRunRecord): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const currentParentRun = await this.#lifecycle.getRun(parentRunId);
      const currentRecords = this.delegatedRunRecords(currentParentRun);
      if (currentRecords.some((existing) => existing.childRunId === record.childRunId)) {
        return;
      }

      const nextRecords = [...currentRecords, record];
      await this.#lifecycle.updateRun(currentParentRun, {
        metadata: {
          ...(currentParentRun.metadata ?? {}),
          delegatedRuns: nextRecords
        }
      });

      const persistedParentRun = await this.#lifecycle.getRun(parentRunId);
      if (this.delegatedRunRecords(persistedParentRun).some((existing) => existing.childRunId === record.childRunId)) {
        return;
      }
    }

    throw new AppError(409, "delegated_run_record_conflict", `Failed to attach delegated run ${record.childRunId}.`);
  }

  async #persistDelegatedRunUpdate(input: {
    parentSessionId: string;
    parentRunId: string;
    parentAgentName: string;
    toolUseId?: string | undefined;
    childSummary: AwaitedRunSummary;
  }): Promise<void> {
    if (
      await this.#hasDelegatedRunTerminalMessage({
        parentSessionId: input.parentSessionId,
        childRunId: input.childSummary.run.id,
        ...(input.childSummary.run.sessionId ? { childSessionId: input.childSummary.run.sessionId } : {})
      })
    ) {
      return;
    }

    const taskId = input.childSummary.run.sessionId ?? input.childSummary.run.id;
    const outputRef = this.#taskOutputRef(taskId);
    const outputFile = taskOutputPath(input.parentSessionId, taskId);
    const createdAt = this.#helpers.nowIso();
    const usage = await this.#summarizeChildRunUsage(input.childSummary.run);
    const agentTask = await this.#persistAgentTaskTerminalOutput({
      workspaceId: input.childSummary.run.workspaceId,
      parentSessionId: input.parentSessionId,
      parentRunId: input.parentRunId,
      childSessionId: taskId,
      childRunId: input.childSummary.run.id,
      targetAgentName: input.childSummary.run.effectiveAgentName,
      parentAgentName: input.parentAgentName,
      taskId,
      ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
      status: "completed",
      outputRef,
      outputFile,
      finalText: input.childSummary.outputContent ?? "",
      ...(usage ? { usage } : {}),
      updatedAt: createdAt,
      notifiedAt: createdAt
    });
    const parentRun = await this.#lifecycle.getRun(input.parentRunId);
    if (!this.#isRunTerminal(parentRun.status)) {
      await this.#enqueueOrPersistActiveTaskNotification({
        workspaceId: input.childSummary.run.workspaceId,
        parentSessionId: input.parentSessionId,
        parentRunId: input.parentRunId,
        parentAgentName: input.parentAgentName,
        taskId,
        ...(agentTask?.toolUseId ? { toolUseId: agentTask.toolUseId } : {}),
        childRunId: input.childSummary.run.id,
        childSessionId: taskId,
        updateType: "completed",
        message: buildDelegatedRunCompletedMessage({
          messageId: this.#taskNotificationId(taskId, input.childSummary.run.id, "completed"),
          runId: input.parentRunId,
          createdAt,
          parentSessionId: input.parentSessionId,
          parentAgentName: input.parentAgentName,
          childSummary: input.childSummary,
          outputRef,
          outputFile,
          ...(agentTask?.usage ? { usage: agentTask.usage } : {}),
          ...(agentTask?.taskState ? { taskState: agentTask.taskState } : {}),
          ...(agentTask?.toolUseId ? { toolUseId: agentTask.toolUseId } : {})
        })
      });
      return;
    }

    const message = buildDelegatedRunCompletedMessage({
      messageId: this.#taskNotificationId(taskId, input.childSummary.run.id, "completed"),
      runId: input.parentRunId,
      createdAt,
      parentSessionId: input.parentSessionId,
      parentAgentName: input.parentAgentName,
      childSummary: input.childSummary,
      outputRef,
      outputFile,
      ...(agentTask?.usage ? { usage: agentTask.usage } : {}),
      ...(agentTask?.taskState ? { taskState: agentTask.taskState } : {}),
      ...(agentTask?.toolUseId ? { toolUseId: agentTask.toolUseId } : {})
    });
    await this.#enqueueOrPersistActiveTaskNotification({
      workspaceId: input.childSummary.run.workspaceId,
      parentSessionId: input.parentSessionId,
      parentRunId: input.parentRunId,
      parentAgentName: input.parentAgentName,
      taskId,
      ...(agentTask?.toolUseId ? { toolUseId: agentTask.toolUseId } : {}),
      childRunId: input.childSummary.run.id,
      childSessionId: taskId,
      updateType: "completed",
      message
    });
    await this.#enqueueParentContinuationIfReady({
      workspaceId: input.childSummary.run.workspaceId,
      parentSessionId: input.parentSessionId,
      parentRunId: input.parentRunId,
      parentAgentName: input.parentAgentName,
      initiatorRef: input.childSummary.run.initiatorRef
    });
  }

  async #persistDelegatedRunFailure(input: {
    parentSessionId: string;
    parentRunId: string;
    parentAgentName: string;
    toolUseId?: string | undefined;
    childRun: Run;
  }): Promise<void> {
    if (
      await this.#hasDelegatedRunTerminalMessage({
        parentSessionId: input.parentSessionId,
        childRunId: input.childRun.id,
        ...(input.childRun.sessionId ? { childSessionId: input.childRun.sessionId } : {})
      })
    ) {
      return;
    }

    const taskId = input.childRun.sessionId ?? input.childRun.id;
    const outputRef = this.#taskOutputRef(taskId);
    const outputFile = taskOutputPath(input.parentSessionId, taskId);
    const createdAt = this.#helpers.nowIso();
    const usage = await this.#summarizeChildRunUsage(input.childRun);
    const agentTask = await this.#persistAgentTaskTerminalOutput({
      workspaceId: input.childRun.workspaceId,
      parentSessionId: input.parentSessionId,
      parentRunId: input.parentRunId,
      childSessionId: taskId,
      childRunId: input.childRun.id,
      targetAgentName: input.childRun.effectiveAgentName,
      parentAgentName: input.parentAgentName,
      taskId,
      ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
      status: this.#agentTaskStatusFromRun(input.childRun.status),
      outputRef,
      outputFile,
      errorMessage: input.childRun.errorMessage ?? "",
      ...(usage ? { usage } : {}),
      updatedAt: createdAt,
      notifiedAt: createdAt
    });
    const parentRun = await this.#lifecycle.getRun(input.parentRunId);
    if (!this.#isRunTerminal(parentRun.status)) {
      await this.#enqueueOrPersistActiveTaskNotification({
        workspaceId: input.childRun.workspaceId,
        parentSessionId: input.parentSessionId,
        parentRunId: input.parentRunId,
        parentAgentName: input.parentAgentName,
        taskId,
        ...(agentTask?.toolUseId ? { toolUseId: agentTask.toolUseId } : {}),
        childRunId: input.childRun.id,
        childSessionId: taskId,
        updateType: "failed",
        message: buildDelegatedRunFailedMessage({
          messageId: this.#taskNotificationId(taskId, input.childRun.id, "failed"),
          runId: input.parentRunId,
          createdAt,
          parentSessionId: input.parentSessionId,
          parentAgentName: input.parentAgentName,
          childRun: input.childRun,
          outputRef,
          outputFile,
          ...(agentTask?.usage ? { usage: agentTask.usage } : {}),
          ...(agentTask?.taskState ? { taskState: agentTask.taskState } : {}),
          ...(agentTask?.toolUseId ? { toolUseId: agentTask.toolUseId } : {})
        })
      });
      return;
    }

    const message = buildDelegatedRunFailedMessage({
      messageId: this.#taskNotificationId(taskId, input.childRun.id, "failed"),
      runId: input.parentRunId,
      createdAt,
      parentSessionId: input.parentSessionId,
      parentAgentName: input.parentAgentName,
      childRun: input.childRun,
      outputRef,
      outputFile,
      ...(agentTask?.usage ? { usage: agentTask.usage } : {}),
      ...(agentTask?.taskState ? { taskState: agentTask.taskState } : {}),
      ...(agentTask?.toolUseId ? { toolUseId: agentTask.toolUseId } : {})
    });
    await this.#enqueueOrPersistActiveTaskNotification({
      workspaceId: input.childRun.workspaceId,
      parentSessionId: input.parentSessionId,
      parentRunId: input.parentRunId,
      parentAgentName: input.parentAgentName,
      taskId,
      ...(agentTask?.toolUseId ? { toolUseId: agentTask.toolUseId } : {}),
      childRunId: input.childRun.id,
      childSessionId: taskId,
      updateType: "failed",
      message
    });
    await this.#enqueueParentContinuationIfReady({
      workspaceId: input.childRun.workspaceId,
      parentSessionId: input.parentSessionId,
      parentRunId: input.parentRunId,
      parentAgentName: input.parentAgentName,
      initiatorRef: input.childRun.initiatorRef
    });
  }

  async #persistDelegatedRunTerminalUpdate(input: {
    parentSessionId: string;
    parentRunId: string;
    parentAgentName: string;
    toolUseId?: string | undefined;
    childRun: Run;
  }): Promise<void> {
    if (input.childRun.status === "completed") {
      await this.#persistDelegatedRunUpdate({
        parentSessionId: input.parentSessionId,
        parentRunId: input.parentRunId,
        parentAgentName: input.parentAgentName,
        ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
        childSummary: await this.#collectAwaitedRunSummary(input.childRun.id)
      });
      return;
    }

    await this.#persistDelegatedRunFailure({
      parentSessionId: input.parentSessionId,
      parentRunId: input.parentRunId,
      parentAgentName: input.parentAgentName,
      ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
      childRun: input.childRun
    });
  }

  async #enqueueOrPersistActiveTaskNotification(input: {
    workspaceId: string;
    parentSessionId: string;
    parentRunId: string;
    parentAgentName: string;
    taskId: string;
    toolUseId?: string | undefined;
    childRunId: string;
    childSessionId: string;
    updateType: "completed" | "failed";
    message: Message;
  }): Promise<void> {
    const notificationId = this.#taskNotificationId(input.taskId, input.childRunId, input.updateType);
    if (this.#persistence.agentTaskNotifications) {
      await this.#persistence.agentTaskNotifications.create({
        id: notificationId,
        workspaceId: input.workspaceId,
        parentSessionId: input.parentSessionId,
        parentRunId: input.parentRunId,
        taskId: input.taskId,
        ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
        childRunId: input.childRunId,
        childSessionId: input.childSessionId,
        updateType: input.updateType,
        content: typeof input.message.content === "string" ? input.message.content : "",
        metadata: input.message.metadata ?? {},
        status: "pending",
        createdAt: input.message.createdAt
      });
      await this.#persistVisiblePendingTaskNotification({
        parentSessionId: input.parentSessionId,
        parentRunId: input.parentRunId,
        parentAgentName: input.parentAgentName,
        taskId: input.taskId,
        message: {
          ...input.message,
          id: notificationId
        }
      });
      return;
    }

    const message = await this.#persistence.messages.create({
      ...input.message,
      id: notificationId
    });
    await this.#lifecycle.appendEvent({
      sessionId: input.parentSessionId,
      runId: input.parentRunId,
      event: "message.completed",
      data: {
        runId: input.parentRunId,
        sessionId: input.parentSessionId,
        messageId: message.id,
        role: message.role,
        origin: message.origin,
        mode: message.mode,
        content: message.content,
        taskId: input.taskId,
        ...(message.metadata ? { metadata: message.metadata } : {})
      }
    });
  }

  async #filterDrainableTaskNotifications(
    parentSessionId: string,
    notifications: AgentTaskNotificationRecord[]
  ): Promise<AgentTaskNotificationRecord[]> {
    const groupedByParentRunId = new Map<string, AgentTaskNotificationRecord[]>();
    for (const notification of notifications) {
      const entries = groupedByParentRunId.get(notification.parentRunId) ?? [];
      entries.push(notification);
      groupedByParentRunId.set(notification.parentRunId, entries);
    }

    const drainable: AgentTaskNotificationRecord[] = [];
    for (const [parentRunId, entries] of groupedByParentRunId) {
      const batchState = await this.#delegatedNotificationBatchState(parentSessionId, parentRunId, entries);
      if (batchState.ready) {
        drainable.push(...entries);
      }
    }
    return drainable.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  async #enqueueParentContinuationIfReady(input: {
    workspaceId: string;
    parentSessionId: string;
    parentRunId: string;
    parentAgentName: string;
    initiatorRef?: string | undefined;
  }): Promise<void> {
    return this.#serializeDelegation(input.parentRunId, async () => {
      const repository = this.#persistence.agentTaskNotifications;
      if (!repository) {
        return;
      }

      const pending = (await repository.listPendingBySessionId(input.parentSessionId)).filter(
        (notification) => notification.parentRunId === input.parentRunId
      );
      if (pending.length === 0) {
        return;
      }

      const batchState = await this.#delegatedNotificationBatchState(input.parentSessionId, input.parentRunId, pending);
      if (!batchState.ready || this.#hasQueuedTaskNotificationContinuation(batchState.parentRun)) {
        return;
      }

      const createdAt = this.#helpers.nowIso();
      const continuationRunId = this.#taskNotificationContinuationRunId(input.parentRunId);
      if (await this.#persistence.runs.getById(continuationRunId)) {
        return;
      }

      const triggerRef = `task-notification:${input.parentRunId}`;
      const continuationRun = await this.#persistence.runs.create({
        id: continuationRunId,
        workspaceId: input.workspaceId,
        sessionId: input.parentSessionId,
        parentRunId: input.parentRunId,
        initiatorRef: input.initiatorRef,
        triggerType: "system",
        triggerRef,
        agentName: input.parentAgentName,
        effectiveAgentName: input.parentAgentName,
        switchCount: batchState.parentRun.switchCount,
        status: "queued",
        createdAt,
        metadata: {
          synthetic: true,
          taskNotificationContinuation: true,
          taskNotificationBatchParentRunId: input.parentRunId,
          delegatedTaskIds: batchState.pendingNotifications.map((notification) => notification.taskId),
          delegatedChildRunIds: batchState.pendingNotifications.map((notification) => notification.childRunId),
          origin: "engine",
          mode: "task-notification",
          runtimeKind: "task_notification"
        }
      });

      await this.#lifecycle.updateRun(batchState.parentRun, {
        metadata: {
          ...(batchState.parentRun.metadata ?? {}),
          taskNotificationContinuationRunId: continuationRun.id
        }
      });

      await this.#lifecycle.appendEvent({
        sessionId: input.parentSessionId,
        runId: continuationRun.id,
        event: "run.queued",
        data: {
          runId: continuationRun.id,
          sessionId: input.parentSessionId,
          parentRunId: input.parentRunId,
          status: continuationRun.status,
          taskNotificationCount: batchState.pendingNotifications.length,
          metadata: continuationRun.metadata
        }
      });
      await this.#lifecycle.enqueueRun(input.parentSessionId, continuationRun.id);
    });
  }

  async #delegatedNotificationBatchState(
    parentSessionId: string,
    parentRunId: string,
    pendingNotifications: AgentTaskNotificationRecord[]
  ): Promise<DelegatedNotificationBatchState> {
    const parentRun = await this.#lifecycle.getRun(parentRunId);
    const records = this.delegatedRunRecords(parentRun).filter((record) => record.notifyParentOnCompletion === true);
    if (records.length === 0) {
      return {
        parentRun,
        records,
        ready: true,
        pendingNotifications
      };
    }

    const childRuns = await Promise.all(records.map(async (record) => this.#persistence.runs.getById(record.childRunId)));
    const allDelegatedRunsTerminal = childRuns.every((run) => run !== null && this.#isRunTerminal(run.status));
    if (!allDelegatedRunsTerminal) {
      return {
        parentRun,
        records,
        ready: false,
        pendingNotifications
      };
    }

    const pendingChildRunIds = new Set(pendingNotifications.map((notification) => notification.childRunId));
    const allTerminalRunsHaveNotifications = records.every((record, index) => {
      const childRun = childRuns[index];
      if (!childRun || !this.#isRunTerminal(childRun.status)) {
        return false;
      }
      return pendingChildRunIds.has(record.childRunId);
    });

    return {
      parentRun,
      records,
      ready: allTerminalRunsHaveNotifications,
      pendingNotifications
    };
  }

  #hasQueuedTaskNotificationContinuation(parentRun: Run): boolean {
    return (
      typeof parentRun.metadata?.taskNotificationContinuationRunId === "string" ||
      typeof parentRun.metadata?.taskNotificationContinuationQueuedAt === "string"
    );
  }

  #taskNotificationContinuationRunId(parentRunId: string): string {
    return `run_task_notification_${parentRunId}`;
  }

  async #ensureAgentTaskTerminalOutput(task: AgentTaskRecord, run: Run): Promise<AgentTaskRecord> {
    if (!this.#persistence.agentTasks) {
      return task;
    }

    if (run.status === "completed") {
      const summary = await this.#collectAwaitedRunSummary(run.id);
      const usage = await this.#summarizeChildRunUsage(run);
      await this.#persistAgentTaskTerminalOutput({
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
        taskState: this.#localAgentTaskState({
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
      const usage = await this.#summarizeChildRunUsage(run);
      await this.#persistAgentTaskTerminalOutput({
        workspaceId: task.workspaceId,
        parentSessionId: task.parentSessionId,
        parentRunId: task.parentRunId,
        childSessionId: task.childSessionId,
        childRunId: task.childRunId,
        targetAgentName: task.targetAgentName,
        parentAgentName: task.parentAgentName,
        taskId: task.taskId,
        ...(task.toolUseId ? { toolUseId: task.toolUseId } : {}),
        status: this.#agentTaskStatusFromRun(run.status),
        outputRef: task.outputRef,
        outputFile: task.outputFile ?? taskOutputPath(task.parentSessionId, task.taskId),
        errorMessage: run.errorMessage ?? task.errorMessage ?? "",
        usage,
        taskState: this.#localAgentTaskState({
          taskId: task.taskId,
          prompt: task.description ?? "",
          agentType: task.targetAgentName,
          existing: task.taskState,
          usage,
          status: this.#agentTaskStatusFromRun(run.status),
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
    if (!this.#persistence.agentTasks || this.#isRunTerminal(run.status)) {
      return task;
    }

    const status: AgentTaskStatus = run.status === "queued" ? "queued" : "running";
    return this.#persistence.agentTasks.update({
      taskId: task.taskId,
      status,
      updatedAt: this.#helpers.nowIso(),
      taskState: this.#localAgentTaskState({
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
      taskState: this.#localAgentTaskState({
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
      if (run && this.#isRunTerminal(run.status)) {
        return this.#ensureAgentTaskTerminalOutput(task, run);
      }
      return task;
    });
  }

  #agentTaskOutputView(task: AgentTaskRecord, run?: Run | undefined): AgentTaskOutputView {
    const status = this.#agentTaskOutputStatus(run?.status, task.status);
    const output = task.finalText ?? task.errorMessage ?? "";
    return {
      taskId: task.taskId,
      taskType: "local_agent",
      childSessionId: task.childSessionId,
      childRunId: task.childRunId,
      status,
      description: task.handoffSummary ?? task.description ?? task.targetAgentName,
      output,
      ...(task.description ? { prompt: task.description } : {}),
      ...(task.finalText !== undefined ? { result: task.finalText } : {}),
      ...(task.errorMessage !== undefined ? { error: task.errorMessage } : {}),
      outputRef: task.outputRef,
      ...(task.outputFile ? { outputFile: task.outputFile } : {}),
      ...(task.usage ? { usage: task.usage } : {}),
      ...(task.taskState ? { taskState: task.taskState } : {})
    };
  }

  async #summarizeChildRunUsage(run: Run): Promise<Record<string, unknown> | undefined> {
    const runSteps = this.#persistence.runSteps;
    if (!runSteps) {
      return undefined;
    }

    const steps = await runSteps.listByRunId(run.id).catch(() => []);
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let toolUses = 0;

    for (const step of steps) {
      if (step.stepType === "tool_call") {
        toolUses += 1;
      }

      const output = isRecord(step.output) ? step.output : undefined;
      const response = isRecord(output?.response) ? output.response : undefined;
      const usage = isRecord(response?.usage) ? response.usage : undefined;
      inputTokens += readNonNegativeInteger(usage?.inputTokens);
      outputTokens += readNonNegativeInteger(usage?.outputTokens);
      totalTokens += readNonNegativeInteger(usage?.totalTokens);

      const toolCalls = Array.isArray(response?.toolCalls) ? response.toolCalls.length : 0;
      const toolResults = Array.isArray(response?.toolResults) ? response.toolResults.length : 0;
      const toolErrors = Array.isArray(response?.toolErrors) ? response.toolErrors.length : 0;
      toolUses += Math.max(toolCalls, toolResults, toolErrors);
    }

    const durationMs = run.startedAt && run.endedAt ? Date.parse(run.endedAt) - Date.parse(run.startedAt) : undefined;
    const usage: Record<string, unknown> = {};
    if (inputTokens > 0) usage.inputTokens = inputTokens;
    if (outputTokens > 0) usage.outputTokens = outputTokens;
    if (totalTokens > 0) usage.totalTokens = totalTokens;
    if (toolUses > 0) usage.toolUses = toolUses;
    if (durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0) usage.durationMs = durationMs;

    return Object.keys(usage).length > 0 ? usage : undefined;
  }

  #agentTaskOutputStatus(
    runStatus: Run["status"] | undefined,
    taskStatus: AgentTaskStatus
  ): AgentTaskOutputView["status"] {
    const status = runStatus ?? taskStatus;
    if (status === "completed") {
      return "completed";
    }
    if (status === "failed") {
      return "failed";
    }
    if (status === "cancelled" || status === "timed_out") {
      return "killed";
    }
    if (status === "queued") {
      return "pending";
    }
    return "running";
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
    const delegatedRecord = parentRun ? this.delegatedRunRecords(parentRun).find((record) => record.childSessionId === taskId) : undefined;
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
          : this.#agentTaskStatusFromRun(childRun.status),
      description: typeof childRun.metadata?.delegatedTask === "string" ? childRun.metadata.delegatedTask : undefined,
      handoffSummary: typeof childRun.metadata?.handoffSummary === "string" ? childRun.metadata.handoffSummary : undefined,
      outputRef: this.#taskOutputRef(taskId),
      outputFile: taskOutputPath(childSession.parentSessionId, taskId),
      taskState: this.#localAgentTaskState({
        taskId,
        prompt: typeof childRun.metadata?.delegatedTask === "string" ? childRun.metadata.delegatedTask : "",
        agentType: delegatedRecord?.targetAgentName ?? childRun.effectiveAgentName,
        status:
          childRun.status === "queued" || childRun.status === "running" || childRun.status === "waiting_tool"
            ? childRun.status === "queued"
              ? "queued"
              : "running"
            : this.#agentTaskStatusFromRun(childRun.status),
        isBackgrounded: delegatedRecord?.notifyParentOnCompletion ?? true,
        notified: false
      }),
      createdAt: childRun.createdAt,
      updatedAt: now
    });

    if (this.#isRunTerminal(childRun.status)) {
      return (
        (await this.#ensureAgentTaskTerminalOutput(recovered, childRun)) ??
        (await this.#persistence.agentTasks.getByTaskId(taskId))
      );
    }

    return recovered;
  }

  async #hasDelegatedRunTerminalMessage(input: {
    parentSessionId: string;
    childRunId: string;
    childSessionId?: string | undefined;
  }): Promise<boolean> {
    const messages = await this.#persistence.messages.listBySessionId(input.parentSessionId);
    return messages.some((message) => {
      const metadata = message.metadata as
        | {
            delegatedUpdate?: unknown;
            delegatedChildRunId?: unknown;
            delegatedChildSessionId?: unknown;
            delegatedTaskId?: unknown;
            taskNotificationPendingModelDelivery?: unknown;
          }
        | undefined;
      const isTerminalUpdate = metadata?.delegatedUpdate === "completed" || metadata?.delegatedUpdate === "failed";
      const isOnlyVisiblePendingNotification = metadata?.taskNotificationPendingModelDelivery === true;
      const sameRun = metadata?.delegatedChildRunId === input.childRunId;
      const sameTask =
        typeof input.childSessionId === "string" &&
        (metadata?.delegatedChildSessionId === input.childSessionId || metadata?.delegatedTaskId === input.childSessionId);
      return (
        (message.role === "tool" || message.role === "user") &&
        isTerminalUpdate &&
        !isOnlyVisiblePendingNotification &&
        (sameRun || sameTask)
      );
    });
  }

  async #persistAgentTaskTerminalOutput(input: {
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
  }): Promise<AgentTaskRecord | undefined> {
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
          this.#localAgentTaskState({
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
        this.#localAgentTaskState({
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

  #localAgentTaskState(input: {
    taskId: string;
    prompt: string;
    agentType: string;
    model?: string | undefined;
    existing?: AgentTaskRecord["taskState"] | undefined;
    status?: AgentTaskStatus | undefined;
    finalText?: string | undefined;
    errorMessage?: string | undefined;
    usage?: Record<string, unknown> | undefined;
    pendingMessage?: string | undefined;
    retrieved?: boolean | undefined;
    isBackgrounded?: boolean | undefined;
    notified?: boolean | undefined;
  }): AgentTaskRecord["taskState"] {
    const existing = input.existing;
    const tokenCount = readNonNegativeInteger(input.usage?.totalTokens);
    const toolCount = readNonNegativeInteger(input.usage?.toolUses);
    const pendingMessages = [...(existing?.pendingMessages ?? [])];
    if (input.pendingMessage?.trim()) {
      pendingMessages.push(input.pendingMessage);
    }
    const isTerminal = input.status === "completed" || input.status === "failed" || input.status === "cancelled" || input.status === "timed_out";
    return {
      type: "local_agent",
      agentId: input.taskId,
      prompt: input.prompt || existing?.prompt || "",
      agentType: input.agentType || existing?.agentType || "general-purpose",
      ...(input.model ?? existing?.model ? { model: input.model ?? existing?.model } : {}),
      retrieved: input.retrieved ?? existing?.retrieved ?? false,
      lastReportedToolCount: Math.max(existing?.lastReportedToolCount ?? 0, toolCount),
      lastReportedTokenCount: Math.max(existing?.lastReportedTokenCount ?? 0, tokenCount),
      isBackgrounded: input.isBackgrounded ?? existing?.isBackgrounded ?? true,
      pendingMessages: isTerminal ? [] : pendingMessages,
      retain: existing?.retain ?? false,
      diskLoaded: existing?.diskLoaded ?? false,
      notified: input.notified ?? existing?.notified ?? false,
      ...(isTerminal && !(existing?.retain ?? false) ? { evictAfter: existing?.evictAfter ?? Date.now() + 300_000 } : {}),
      ...(existing?.evictAfter !== undefined ? { evictAfter: existing.evictAfter } : {})
    };
  }

  async #activeRunForSession(sessionId: string): Promise<Run | null> {
    const runs = await this.#persistence.runs.listBySessionId(sessionId).catch(() => []);
    return (
      runs
        .filter((run) => run.status === "queued" || run.status === "running" || run.status === "waiting_tool")
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ?? null
    );
  }

  #agentTaskStatusFromRun(status: Run["status"]): AgentTaskStatus {
    if (status === "cancelled" || status === "timed_out") {
      return status;
    }

    return status === "completed" ? "completed" : "failed";
  }

  #taskOutputRef(taskId: string): string {
    return `agent-task://${taskId}/output`;
  }

  #taskNotificationId(taskId: string, childRunId: string, updateType: "completed" | "failed"): string {
    return `task_notification_${taskId}_${childRunId}_${updateType}`;
  }
}
