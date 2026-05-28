import type { Message, Run, Session } from "@oah/api-contracts";

import { AppError } from "../errors.js";
import { textContent } from "../execution-message-content.js";
import { canDelegateFromAgent } from "../capabilities/engine-capabilities.js";
import {
  buildDelegatedTaskMessage,
  renderAwaitedRunSummary,
  taskOutputPath
} from "./agent-delegation-messages.js";
import { extractRunOutputContent } from "./agent-output-content.js";
import type { WorkspaceRecord } from "../types.js";
import {
  delegatedOutputFollowUpPrompt,
  delegatedRunRecords
} from "./agent-coordination-records.js";
import {
  isRunTerminal,
  waitForAnyRunTerminalState,
  waitForRunTerminalState
} from "./agent-coordination-run-state.js";
import { AgentTaskOutputStore } from "./agent-task-output-store.js";
import { DelegatedRunReporter } from "./delegated-run-reporter.js";
import {
  localAgentTaskState,
  taskOutputRef
} from "./agent-task-state.js";
import type {
  AgentCoordinationHelpers,
  AgentCoordinationLifecycle,
  AgentCoordinationPersistence,
  AgentCoordinationServiceDependencies,
  AgentTaskOutputReadResult,
  AwaitedRunSummary,
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

export class AgentCoordinationService {
  readonly #persistence: AgentCoordinationPersistence;
  readonly #lifecycle: AgentCoordinationLifecycle;
  readonly #helpers: AgentCoordinationHelpers;
  readonly #taskOutputStore: AgentTaskOutputStore;
  readonly #delegatedRunReporter: DelegatedRunReporter;
  readonly #delegationQueues = new Map<string, Promise<void>>();
  readonly #delegatedRunMonitors = new Map<string, DelegatedRunMonitorState>();

  constructor(dependencies: AgentCoordinationServiceDependencies) {
    this.#persistence = dependencies.persistence;
    this.#lifecycle = dependencies.lifecycle;
    this.#helpers = dependencies.helpers;
    this.#taskOutputStore = new AgentTaskOutputStore({
      persistence: dependencies.persistence,
      lifecycle: dependencies.lifecycle,
      helpers: dependencies.helpers,
      collectAwaitedRunSummary: async (runId) => this.#collectAwaitedRunSummary(runId)
    });
    this.#delegatedRunReporter = new DelegatedRunReporter({
      persistence: dependencies.persistence,
      lifecycle: dependencies.lifecycle,
      helpers: dependencies.helpers,
      taskOutputStore: this.#taskOutputStore,
      collectAwaitedRunSummary: async (runId) => this.#collectAwaitedRunSummary(runId)
    });
  }

  delegatedRunRecords(run: Run): DelegatedRunRecord[] {
    return delegatedRunRecords(run);
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

    let childSessionId = "";
    let childRunId = "";
    let targetAgentName = resolvedTargetAgentName;
    let outputRef = "";
    let outputFile = "";
    let canReadOutputFile = input.canReadOutputFile ?? false;
    let shouldQueueChildRun = false;
    let createdAt = "";

    await this.#serializeDelegation(input.parentRun.id, async () => {
      const latestParentRun = await this.#lifecycle.getRun(input.parentRun.id);
      await this.#enforceSubagentConcurrencyLimit(input.workspace, latestParentRun, input.currentAgentName);
      const resumedSessionQueueState = resumedSession
        ? await this.#sessionQueueState(resumedSession.id)
        : { hasActiveRun: false, hasPendingRuns: false };
      shouldQueueChildRun = resumedSessionQueueState.hasActiveRun || resumedSessionQueueState.hasPendingRuns;

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
      createdAt = now;
      childSessionId = resumedSession?.id ?? this.#helpers.createId("ses");
      childRunId = this.#helpers.createId("run");
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

      outputRef = taskOutputRef(childSessionId);
      outputFile = taskOutputPath(input.parentSession.id, childSessionId);
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
        taskState: localAgentTaskState({
          taskId: childSessionId,
          prompt: input.task,
          agentType: resolvedTargetAgentName,
          model: targetAgent.modelRef ?? parentModelRef,
          existing: existingAgentTask?.taskState,
          pendingMessage: shouldQueueChildRun ? input.task : undefined,
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

      return undefined;
    });

    await this.#enqueueChildRunRespectingSessionQueue({
      childSessionId,
      childRunId,
      createdAt,
      shouldQueue: shouldQueueChildRun
    });
    void this.#startDelegatedRunMonitor({
      parentSessionId: input.parentSession.id,
      parentRunId: input.parentRun.id,
      parentAgentName: input.currentAgentName,
      targetAgentName,
      childRunId,
      ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
      notifyParentOnCompletion: input.notifyParentOnCompletion ?? false
    });

    return {
      childSessionId,
      childRunId,
      targetAgentName,
      outputRef,
      outputFile,
      canReadOutputFile
    };
  }

  async #enqueueChildRunRespectingSessionQueue(input: {
    childSessionId: string;
    childRunId: string;
    createdAt: string;
    shouldQueue: boolean;
  }): Promise<"active_run" | "session_queue"> {
    if (input.shouldQueue && this.#persistence.sessionPendingRuns) {
      const queuedEntry = await this.#persistence.sessionPendingRuns.enqueue({
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
          source: "subagent_pending_message",
          queuedPosition: queuedEntry.position
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
        ? [await waitForAnyRunTerminalState(this.#lifecycle, runIds)]
        : await Promise.all(runIds.map(async (runId) => waitForRunTerminalState(this.#lifecycle, runId)));
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
    return this.#taskOutputStore.read(input);
  }

  async drainPendingTaskNotifications(input: {
    parentSessionId: string;
    runId: string;
    parentAgentName: string;
  }): Promise<{ messageIds: string[] }> {
    return this.#delegatedRunReporter.drainPendingTaskNotifications(input);
  }

  async persistUnreportedTerminalDelegatedRuns(input: {
    workspace: WorkspaceRecord;
    parentSessionId: string;
    parentRun: Run;
    parentAgentName: string;
  }): Promise<{ childRunIds: string[] }> {
    return this.#delegatedRunReporter.persistUnreportedTerminalDelegatedRuns(input);
  }

  async enqueueParentTaskNotificationContinuationIfReady(input: {
    workspaceId: string;
    parentSessionId: string;
    parentRunId: string;
    parentAgentName: string;
    initiatorRef?: string | undefined;
  }): Promise<void> {
    return this.#delegatedRunReporter.enqueueParentContinuationIfReady(input);
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
    const childRun = await waitForRunTerminalState(this.#lifecycle, input.childRunId);
    const childSummary = await this.#collectAwaitedRunSummary(input.childRunId);
    const alreadyReported = await this.#delegatedRunReporter.hasDelegatedRunTerminalMessage({
      parentSessionId: input.parentSessionId,
      childRunId: input.childRunId,
      childSessionId: childRun.sessionId
    });
    if (alreadyReported) {
      await this.#dispatchNextQueuedChildRun(childRun.sessionId);
      return;
    }

    if (childRun.status === "completed") {
      if (state?.notifyParentOnCompletion ?? input.notifyParentOnCompletion) {
        await this.#delegatedRunReporter.persistDelegatedRunUpdate({
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
      await this.#dispatchNextQueuedChildRun(childRun.sessionId);
      return;
    }

    if (state?.notifyParentOnCompletion ?? input.notifyParentOnCompletion) {
      await this.#delegatedRunReporter.persistDelegatedRunFailure({
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
    await this.#dispatchNextQueuedChildRun(childRun.sessionId);
  }

  async #dispatchNextQueuedChildRun(sessionId: string | undefined): Promise<void> {
    if (!sessionId || !this.#persistence.sessionPendingRuns) {
      return;
    }

    const queueState = await this.#sessionQueueState(sessionId);
    if (queueState.hasActiveRun) {
      return;
    }

    const nextQueuedRun = await this.#persistence.sessionPendingRuns.dequeueNext(sessionId);
    if (!nextQueuedRun) {
      return;
    }

    await this.#lifecycle.appendEvent({
      sessionId,
      runId: nextQueuedRun.runId,
      event: "queue.updated",
      data: {
        runId: nextQueuedRun.runId,
        action: "dequeued",
        source: "subagent_pending_message",
        queuedPosition: nextQueuedRun.position
      }
    });
    await this.#lifecycle.enqueueRun(sessionId, nextQueuedRun.runId, {
      priority: "subagent"
    });
  }

  async #sessionQueueState(
    sessionId: string,
    options?: { excludeRunIds?: string[] | undefined }
  ): Promise<{ hasActiveRun: boolean; hasPendingRuns: boolean }> {
    const excludedRunIds = new Set(options?.excludeRunIds ?? []);
    const pendingRuns = this.#persistence.sessionPendingRuns
      ? await this.#persistence.sessionPendingRuns.listBySessionId(sessionId)
      : [];
    const pendingRunIds = new Set(pendingRuns.map((entry) => entry.runId));
    const runs = await this.#persistence.runs.listBySessionId(sessionId).catch(() => []);
    const hasActiveRun = runs.some(
      (run) =>
        (run.status === "queued" || run.status === "running" || run.status === "waiting_tool") &&
        !excludedRunIds.has(run.id) &&
        !pendingRunIds.has(run.id) &&
        !run.cancelRequestedAt
    );
    const hasPendingRuns = pendingRuns.some((entry) => !excludedRunIds.has(entry.runId));

    return { hasActiveRun, hasPendingRuns };
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
    const outputContent = extractRunOutputContent({
      messages,
      runId: run.id,
      extractMessageDisplayText: (message) => this.#helpers.extractMessageDisplayText(message),
      hasMeaningfulText: (content) => this.#helpers.hasMeaningfulText(content)
    });
    if (this.#helpers.hasMeaningfulText(outputContent)) {
      return { run, outputContent };
    }

    if (run.status === "completed" && options.allowOutputFollowUp !== false) {
      const followUpRun = await this.#ensureDelegatedOutputFollowUpRun(run, messages);
      const completedFollowUpRun = await waitForRunTerminalState(this.#lifecycle, followUpRun.id);
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

}
