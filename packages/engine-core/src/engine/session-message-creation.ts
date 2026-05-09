import type { Message, Run } from "@oah/api-contracts";

import type {
  CreateSessionMessageParams,
  EngineServiceOptions,
  MessageAcceptedResult,
  SessionQueuedRunListResult
} from "../types.js";
import { createId, nowIso } from "../utils.js";
import { SessionRecordService } from "./session-records.js";

const RESERVED_MESSAGE_METADATA_KEYS = new Set([
  "runtimeKind",
  "origin",
  "mode",
  "source",
  "synthetic",
  "taskNotification",
  "pendingTaskNotificationId",
  "delegatedUpdate",
  "delegatedChildRunId",
  "delegatedChildSessionId",
  "delegatedTaskId",
  "delegatedToolUseId",
  "outputRef",
  "outputFile"
]);

function sanitizeUserMessageMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }

  const sanitized = Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !RESERVED_MESSAGE_METADATA_KEYS.has(key))
  );
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export interface SessionMessageCreationServiceDependencies {
  messageRepository: EngineServiceOptions["messageRepository"];
  runRepository: EngineServiceOptions["runRepository"];
  sessionPendingRunQueueRepository: EngineServiceOptions["sessionPendingRunQueueRepository"];
  sessionRecords: SessionRecordService;
  appendEvent: (input: {
    sessionId: string;
    runId: string;
    event: "run.queued" | "queue.updated";
    data: Record<string, unknown>;
  }) => Promise<unknown>;
  enqueueRun: (sessionId: string, runId: string) => Promise<void>;
  requestRunCancellation: (runId: string) => Promise<void>;
}

export class SessionMessageCreationService {
  readonly #messageRepository: EngineServiceOptions["messageRepository"];
  readonly #runRepository: EngineServiceOptions["runRepository"];
  readonly #sessionPendingRunQueueRepository: EngineServiceOptions["sessionPendingRunQueueRepository"];
  readonly #sessionRecords: SessionRecordService;
  readonly #appendEvent: SessionMessageCreationServiceDependencies["appendEvent"];
  readonly #enqueueRun: SessionMessageCreationServiceDependencies["enqueueRun"];
  readonly #requestRunCancellation: SessionMessageCreationServiceDependencies["requestRunCancellation"];

  constructor(dependencies: SessionMessageCreationServiceDependencies) {
    this.#messageRepository = dependencies.messageRepository;
    this.#runRepository = dependencies.runRepository;
    this.#sessionPendingRunQueueRepository = dependencies.sessionPendingRunQueueRepository;
    this.#sessionRecords = dependencies.sessionRecords;
    this.#appendEvent = dependencies.appendEvent;
    this.#enqueueRun = dependencies.enqueueRun;
    this.#requestRunCancellation = dependencies.requestRunCancellation;
  }

  async createSessionMessage({ sessionId, caller, input }: CreateSessionMessageParams): Promise<MessageAcceptedResult> {
    const session = await this.#sessionRecords.getSession(sessionId);
    const now = nowIso();
    const messageId = createId("msg");
    const runId = createId("run");
    const userMetadata = sanitizeUserMessageMetadata(input.metadata);

    const message: Message = {
      id: messageId,
      sessionId,
      runId,
      role: "user",
      origin: "user",
      mode: "prompt",
      content: input.content,
      ...(userMetadata ? { metadata: userMetadata } : {}),
      createdAt: now
    };

    const run: Run = {
      id: runId,
      workspaceId: session.workspaceId,
      sessionId: session.id,
      initiatorRef: caller.subjectRef,
      triggerType: "message",
      triggerRef: messageId,
      agentName: session.activeAgentName,
      effectiveAgentName: session.activeAgentName,
      switchCount: 0,
      status: "queued",
      createdAt: now
    };

    await this.#runRepository.create(run);
    await this.#messageRepository.create(message);
    await this.#appendEvent({
      sessionId: session.id,
      runId: run.id,
      event: "run.queued",
      data: {
        runId: run.id,
        sessionId: session.id,
        status: "queued"
      }
    });

    const runningRunBehavior = input.runningRunBehavior ?? "queue";
    const sessionQueueState = await this.#getSessionQueueState(session.id, {
      excludeRunIds: [run.id]
    });

    if (runningRunBehavior === "interrupt") {
      if (sessionQueueState.hasActiveRun || sessionQueueState.pendingRunIds.size > 0) {
        const queuedEntry = await this.#sessionPendingRunQueueRepository.enqueue({
          sessionId: session.id,
          runId: run.id,
          createdAt: now
        });
        await this.#sessionPendingRunQueueRepository.promote(run.id);
        await this.#appendQueueUpdatedEvent(session.id, run.id, "promoted", queuedEntry.position);
        const nextPendingRunIds = new Set(sessionQueueState.pendingRunIds);
        nextPendingRunIds.add(run.id);
        if (sessionQueueState.hasActiveRun) {
          await this.#interruptActiveSessionRuns(session.id, nextPendingRunIds);
        } else {
          await this.dispatchNextQueuedRun(session.id);
        }
        return {
          messageId: message.id,
          runId: run.id,
          status: "queued",
          delivery: "session_queue",
          queuedPosition: queuedEntry.position,
          createdAt: now
        };
      } else {
        await this.#enqueueRun(session.id, run.id);
      }
    } else if (sessionQueueState.hasActiveRun || sessionQueueState.pendingRunIds.size > 0) {
      const queuedEntry = await this.#sessionPendingRunQueueRepository.enqueue({
        sessionId: session.id,
        runId: run.id,
        createdAt: now
      });
      await this.#appendQueueUpdatedEvent(session.id, run.id, "enqueued", queuedEntry.position);
      return {
        messageId: message.id,
        runId: run.id,
        status: "queued",
        delivery: "session_queue",
        queuedPosition: queuedEntry.position,
        createdAt: now
      };
    } else {
      await this.#enqueueRun(session.id, run.id);
    }

    return {
      messageId: message.id,
      runId: run.id,
      status: "queued",
      delivery: "active_run",
      createdAt: now
    };
  }

  async dispatchNextQueuedRun(sessionId: string): Promise<string | undefined> {
    const sessionQueueState = await this.#getSessionQueueState(sessionId);
    if (sessionQueueState.hasActiveRun) {
      return undefined;
    }

    const nextQueuedRun = await this.#sessionPendingRunQueueRepository.dequeueNext(sessionId);
    if (!nextQueuedRun) {
      return undefined;
    }

    const dispatchAt = nowIso();
    await this.#retimestampQueuedMessageForDispatch(nextQueuedRun.runId, sessionId, dispatchAt);
    await this.#appendQueueUpdatedEvent(sessionId, nextQueuedRun.runId, "dequeued", nextQueuedRun.position);
    await this.#enqueueRun(sessionId, nextQueuedRun.runId);
    return nextQueuedRun.runId;
  }

  async appendQueueUpdatedEvent(
    sessionId: string,
    runId: string,
    action: "enqueued" | "promoted" | "dequeued" | "removed",
    queuedPosition?: number
  ): Promise<void> {
    await this.#appendQueueUpdatedEvent(sessionId, runId, action, queuedPosition);
  }

  async #appendQueueUpdatedEvent(
    sessionId: string,
    runId: string,
    action: "enqueued" | "promoted" | "dequeued" | "removed",
    queuedPosition?: number
  ): Promise<void> {
    const items = await this.#sessionRecords.collectSessionQueuedRuns(sessionId, { healStaleEntries: false });
    await this.#appendEvent({
      sessionId,
      runId,
      event: "queue.updated",
      data: {
        runId,
        action,
        items,
        ...(typeof queuedPosition === "number" ? { queuedPosition } : {})
      }
    });
  }

  async #interruptActiveSessionRuns(sessionId: string, pendingRunIds?: ReadonlySet<string>): Promise<void> {
    const runs = await this.#runRepository.listBySessionId(sessionId);
    const queuedRunIds =
      pendingRunIds ??
      new Set((await this.#sessionPendingRunQueueRepository.listBySessionId(sessionId)).map((entry) => entry.runId));
    const activeRuns = runs.filter(
      (run) =>
        (run.status === "queued" || run.status === "running" || run.status === "waiting_tool") &&
        !queuedRunIds.has(run.id) &&
        !run.cancelRequestedAt
    );

    await Promise.all(activeRuns.map((run) => this.#requestRunCancellation(run.id)));
  }

  async #getSessionQueueState(
    sessionId: string,
    options?: {
      excludeRunIds?: string[] | undefined;
    }
  ): Promise<{
    hasActiveRun: boolean;
    pendingRunIds: Set<string>;
  }> {
    const [runs, pendingRuns] = await Promise.all([
      this.#runRepository.listBySessionId(sessionId),
      this.#sessionPendingRunQueueRepository.listBySessionId(sessionId)
    ]);
    const excludedRunIds = new Set(options?.excludeRunIds ?? []);
    const pendingRunIds = new Set(pendingRuns.map((entry) => entry.runId));
    const hasActiveRun = runs.some(
      (run) =>
        (run.status === "queued" || run.status === "running" || run.status === "waiting_tool") &&
        !excludedRunIds.has(run.id) &&
        !pendingRunIds.has(run.id) &&
        !run.cancelRequestedAt
    );

    return {
      hasActiveRun,
      pendingRunIds
    };
  }

  async #retimestampQueuedMessageForDispatch(runId: string, sessionId: string, dispatchAt: string): Promise<void> {
    const run = await this.#runRepository.getById(runId).catch(() => null);
    if (!run || run.sessionId !== sessionId || run.triggerType !== "message" || !run.triggerRef) {
      return;
    }

    const message = await this.#messageRepository.getById(run.triggerRef).catch(() => null);
    if (!message || message.sessionId !== sessionId) {
      return;
    }

    await this.#messageRepository.update({
      ...message,
      runId,
      createdAt: dispatchAt
    });
  }
}
