import type { Message, Run } from "@oah/api-contracts";

import { textContent } from "../execution-message-content.js";
import type { AgentTaskNotificationRecord, WorkspaceRecord } from "../types.js";
import {
  buildDelegatedRunCompletedMessage,
  buildDelegatedRunFailedMessage,
  taskOutputPath
} from "./agent-delegation-messages.js";
import { delegatedRunRecords } from "./agent-coordination-records.js";
import { isRunTerminal } from "./agent-coordination-run-state.js";
import type {
  AgentCoordinationHelpers,
  AgentCoordinationLifecycle,
  AgentCoordinationPersistence,
  AwaitedRunSummary,
  DelegatedNotificationBatchState,
  DelegatedRunRecord
} from "./agent-coordination-types.js";
import { summarizeChildRunUsage } from "./agent-run-usage.js";
import { AgentTaskOutputStore } from "./agent-task-output-store.js";
import {
  agentTaskStatusFromRun,
  hasQueuedTaskNotificationContinuation,
  taskNotificationContinuationRunId,
  taskNotificationId,
  taskOutputRef
} from "./agent-task-state.js";

export class DelegatedRunReporter {
  readonly #persistence: AgentCoordinationPersistence;
  readonly #lifecycle: AgentCoordinationLifecycle;
  readonly #helpers: AgentCoordinationHelpers;
  readonly #taskOutputStore: AgentTaskOutputStore;
  readonly #collectAwaitedRunSummary: (runId: string) => Promise<AwaitedRunSummary>;
  readonly #serializeDelegation: <T>(parentRunId: string, operation: () => Promise<T>) => Promise<T>;

  constructor(dependencies: {
    persistence: AgentCoordinationPersistence;
    lifecycle: AgentCoordinationLifecycle;
    helpers: AgentCoordinationHelpers;
    taskOutputStore: AgentTaskOutputStore;
    collectAwaitedRunSummary: (runId: string) => Promise<AwaitedRunSummary>;
    serializeDelegation: <T>(parentRunId: string, operation: () => Promise<T>) => Promise<T>;
  }) {
    this.#persistence = dependencies.persistence;
    this.#lifecycle = dependencies.lifecycle;
    this.#helpers = dependencies.helpers;
    this.#taskOutputStore = dependencies.taskOutputStore;
    this.#collectAwaitedRunSummary = dependencies.collectAwaitedRunSummary;
    this.#serializeDelegation = dependencies.serializeDelegation;
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

  async persistUnreportedTerminalDelegatedRuns(input: {
    workspace: WorkspaceRecord;
    parentSessionId: string;
    parentRun: Run;
    parentAgentName: string;
  }): Promise<{ childRunIds: string[] }> {
    const latestParentRun = await this.#lifecycle.getRun(input.parentRun.id);
    const records = delegatedRunRecords(latestParentRun);
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
      if (!run || !isRunTerminal(run.status)) {
        continue;
      }

      const alreadyReported = await this.hasDelegatedRunTerminalMessage({
        parentSessionId: input.parentSessionId,
        childRunId: run.id,
        ...(run.sessionId ? { childSessionId: run.sessionId } : {})
      });
      if (!alreadyReported) {
        unreportedTerminalRuns.push({ record, run });
      }
    }

    for (const { record, run } of unreportedTerminalRuns) {
      await this.persistDelegatedRunTerminalUpdate({
        parentSessionId: input.parentSessionId,
        parentRunId: input.parentRun.id,
        parentAgentName: input.parentAgentName,
        ...(record.toolUseId ? { toolUseId: record.toolUseId } : {}),
        childRun: run
      });
    }

    return { childRunIds: unreportedTerminalRuns.map((entry) => entry.run.id) };
  }

  async persistDelegatedRunUpdate(input: {
    parentSessionId: string;
    parentRunId: string;
    parentAgentName: string;
    toolUseId?: string | undefined;
    childSummary: AwaitedRunSummary;
  }): Promise<void> {
    if (
      await this.hasDelegatedRunTerminalMessage({
        parentSessionId: input.parentSessionId,
        childRunId: input.childSummary.run.id,
        ...(input.childSummary.run.sessionId ? { childSessionId: input.childSummary.run.sessionId } : {})
      })
    ) {
      return;
    }

    const taskId = input.childSummary.run.sessionId ?? input.childSummary.run.id;
    const outputRef = taskOutputRef(taskId);
    const outputFile = taskOutputPath(input.parentSessionId, taskId);
    const createdAt = this.#helpers.nowIso();
    const usage = await summarizeChildRunUsage(input.childSummary.run, this.#persistence.runSteps);
    const agentTask = await this.#taskOutputStore.persistTerminalOutput({
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
    const message = buildDelegatedRunCompletedMessage({
      messageId: taskNotificationId(taskId, input.childSummary.run.id, "completed"),
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
    if (!isRunTerminal(parentRun.status)) {
      return;
    }

    await this.#enqueueParentContinuationIfReady({
      workspaceId: input.childSummary.run.workspaceId,
      parentSessionId: input.parentSessionId,
      parentRunId: input.parentRunId,
      parentAgentName: input.parentAgentName,
      initiatorRef: input.childSummary.run.initiatorRef
    });
  }

  async persistDelegatedRunFailure(input: {
    parentSessionId: string;
    parentRunId: string;
    parentAgentName: string;
    toolUseId?: string | undefined;
    childRun: Run;
  }): Promise<void> {
    if (
      await this.hasDelegatedRunTerminalMessage({
        parentSessionId: input.parentSessionId,
        childRunId: input.childRun.id,
        ...(input.childRun.sessionId ? { childSessionId: input.childRun.sessionId } : {})
      })
    ) {
      return;
    }

    const taskId = input.childRun.sessionId ?? input.childRun.id;
    const outputRef = taskOutputRef(taskId);
    const outputFile = taskOutputPath(input.parentSessionId, taskId);
    const createdAt = this.#helpers.nowIso();
    const usage = await summarizeChildRunUsage(input.childRun, this.#persistence.runSteps);
    const agentTask = await this.#taskOutputStore.persistTerminalOutput({
      workspaceId: input.childRun.workspaceId,
      parentSessionId: input.parentSessionId,
      parentRunId: input.parentRunId,
      childSessionId: taskId,
      childRunId: input.childRun.id,
      targetAgentName: input.childRun.effectiveAgentName,
      parentAgentName: input.parentAgentName,
      taskId,
      ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
      status: agentTaskStatusFromRun(input.childRun.status),
      outputRef,
      outputFile,
      errorMessage: input.childRun.errorMessage ?? "",
      ...(usage ? { usage } : {}),
      updatedAt: createdAt,
      notifiedAt: createdAt
    });
    const parentRun = await this.#lifecycle.getRun(input.parentRunId);
    const message = buildDelegatedRunFailedMessage({
      messageId: taskNotificationId(taskId, input.childRun.id, "failed"),
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
    if (!isRunTerminal(parentRun.status)) {
      return;
    }

    await this.#enqueueParentContinuationIfReady({
      workspaceId: input.childRun.workspaceId,
      parentSessionId: input.parentSessionId,
      parentRunId: input.parentRunId,
      parentAgentName: input.parentAgentName,
      initiatorRef: input.childRun.initiatorRef
    });
  }

  async persistDelegatedRunTerminalUpdate(input: {
    parentSessionId: string;
    parentRunId: string;
    parentAgentName: string;
    toolUseId?: string | undefined;
    childRun: Run;
  }): Promise<void> {
    if (input.childRun.status === "completed") {
      await this.persistDelegatedRunUpdate({
        parentSessionId: input.parentSessionId,
        parentRunId: input.parentRunId,
        parentAgentName: input.parentAgentName,
        ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
        childSummary: await this.#collectAwaitedRunSummary(input.childRun.id)
      });
      return;
    }

    await this.persistDelegatedRunFailure({
      parentSessionId: input.parentSessionId,
      parentRunId: input.parentRunId,
      parentAgentName: input.parentAgentName,
      ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
      childRun: input.childRun
    });
  }

  async hasDelegatedRunTerminalMessage(input: {
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
    const notificationId = taskNotificationId(input.taskId, input.childRunId, input.updateType);
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
      if (!batchState.ready || hasQueuedTaskNotificationContinuation(batchState.parentRun)) {
        return;
      }

      const createdAt = this.#helpers.nowIso();
      const continuationRunId = taskNotificationContinuationRunId(input.parentRunId);
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
    const records = delegatedRunRecords(parentRun).filter((record) => record.notifyParentOnCompletion === true);
    if (records.length === 0) {
      return {
        parentRun,
        records,
        ready: true,
        pendingNotifications
      };
    }

    const childRuns = await Promise.all(records.map(async (record) => this.#persistence.runs.getById(record.childRunId)));
    const allDelegatedRunsTerminal = childRuns.every((run) => run !== null && isRunTerminal(run.status));
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
      if (!childRun || !isRunTerminal(childRun.status)) {
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
}
