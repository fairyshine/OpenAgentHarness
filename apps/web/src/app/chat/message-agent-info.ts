import type { Message, Run, RunStep, Session, SessionEventContract, WorkspaceCatalog } from "@oah/api-contracts";

import { readMessageAgentSnapshot, type AgentMode } from "../support";

export interface MessageAgentInfo {
  name: string;
  mode?: AgentMode;
}

interface ResolveMessageAgentInfoParams {
  message: Message;
  catalog: WorkspaceCatalog | null | undefined;
  runSteps: RunStep[];
  run: Run | null;
  session: Session | null;
  sessionEvents: SessionEventContract[];
}

interface BuildMessageAgentInfoIndexParams extends Omit<ResolveMessageAgentInfoParams, "message"> {
  messages: Message[];
}

interface RunAgentEventTimeline {
  anchorCursorByMessageId: Map<string, number>;
  switchEvents: Array<{ cursor: number; toAgent: string }>;
}

function readEventCursorValue(cursor: string) {
  const numericCursor = Number.parseInt(cursor, 10);
  return Number.isFinite(numericCursor) ? numericCursor : Number.MAX_SAFE_INTEGER;
}

function resolveUnderlyingMessageId(messageId: string) {
  if (messageId.startsWith("live:")) {
    return messageId.slice("live:".length);
  }

  if (messageId.startsWith("segment:")) {
    const prefixLength = "segment:".length;
    const suffixIndex = messageId.lastIndexOf(":");
    return suffixIndex > prefixLength ? messageId.slice(prefixLength, suffixIndex) : messageId.slice(prefixLength);
  }

  return messageId;
}

function resolveAgentNameFromEvents(message: Message, events: SessionEventContract[]) {
  if (!message.runId) {
    return undefined;
  }

  const runEvents = events.filter((event) => event.runId === message.runId);
  if (runEvents.length === 0) {
    return undefined;
  }

  const switchEvents = runEvents
    .filter(
      (event): event is SessionEventContract & { data: { toAgent: string } } =>
        event.event === "agent.switched" && typeof event.data.toAgent === "string" && event.data.toAgent.trim().length > 0
    )
    .sort((left, right) => readEventCursorValue(left.cursor) - readEventCursorValue(right.cursor));

  if (switchEvents.length === 0) {
    return undefined;
  }

  const sourceMessageId = resolveUnderlyingMessageId(message.id);
  const deltaEvents = runEvents
    .filter(
      (event): event is SessionEventContract & { data: { messageId: string } } =>
        event.event === "message.delta" && typeof event.data.messageId === "string" && event.data.messageId === sourceMessageId
    )
    .sort((left, right) => readEventCursorValue(left.cursor) - readEventCursorValue(right.cursor));

  const anchorEvent =
    deltaEvents[0] ??
    runEvents.find(
      (event) => event.event === "message.completed" && typeof event.data.messageId === "string" && event.data.messageId === sourceMessageId
    );

  if (!anchorEvent) {
    return switchEvents.at(-1)?.data.toAgent;
  }

  const anchorCursor = readEventCursorValue(anchorEvent.cursor);
  for (let index = switchEvents.length - 1; index >= 0; index -= 1) {
    const event = switchEvents[index];
    if (event && readEventCursorValue(event.cursor) <= anchorCursor) {
      return event.data.toAgent;
    }
  }

  return undefined;
}

function buildRunAgentEventTimelines(sessionEvents: SessionEventContract[]) {
  const eventsByRunId = new Map<string, SessionEventContract[]>();
  for (const event of sessionEvents) {
    if (!event.runId) {
      continue;
    }

    const current = eventsByRunId.get(event.runId) ?? [];
    current.push(event);
    eventsByRunId.set(event.runId, current);
  }

  const timelines = new Map<string, RunAgentEventTimeline>();
  for (const [runId, runEvents] of eventsByRunId) {
    const orderedEvents = [...runEvents].sort((left, right) => readEventCursorValue(left.cursor) - readEventCursorValue(right.cursor));
    const anchorCursorByMessageId = new Map<string, number>();
    const switchEvents: Array<{ cursor: number; toAgent: string }> = [];

    for (const event of orderedEvents) {
      if (event.event === "agent.switched" && typeof event.data.toAgent === "string" && event.data.toAgent.trim().length > 0) {
        switchEvents.push({
          cursor: readEventCursorValue(event.cursor),
          toAgent: event.data.toAgent
        });
      }

      if (
        (event.event === "message.delta" || event.event === "message.completed") &&
        typeof event.data.messageId === "string" &&
        !anchorCursorByMessageId.has(event.data.messageId)
      ) {
        anchorCursorByMessageId.set(event.data.messageId, readEventCursorValue(event.cursor));
      }
    }

    timelines.set(runId, {
      anchorCursorByMessageId,
      switchEvents
    });
  }

  return timelines;
}

function resolveAgentNameFromTimeline(message: Message, timeline: RunAgentEventTimeline | undefined) {
  if (!message.runId || !timeline || timeline.switchEvents.length === 0) {
    return undefined;
  }

  const sourceMessageId = resolveUnderlyingMessageId(message.id);
  const anchorCursor = timeline.anchorCursorByMessageId.get(sourceMessageId);
  if (anchorCursor === undefined) {
    return timeline.switchEvents.at(-1)?.toAgent;
  }

  for (let index = timeline.switchEvents.length - 1; index >= 0; index -= 1) {
    const switchEvent = timeline.switchEvents[index];
    if (switchEvent && switchEvent.cursor <= anchorCursor) {
      return switchEvent.toAgent;
    }
  }

  return undefined;
}

function buildLatestStepAgentByRunId(runSteps: RunStep[]) {
  const latestStepAgentByRunId = new Map<string, string>();
  for (const step of runSteps) {
    if (typeof step.agentName === "string" && step.agentName.trim().length > 0) {
      latestStepAgentByRunId.set(step.runId, step.agentName);
    }
  }

  return latestStepAgentByRunId;
}

export function buildMessageAgentInfoIndex(params: BuildMessageAgentInfoIndexParams) {
  const { messages, catalog, runSteps, run, session, sessionEvents } = params;
  const agentModeByName = new Map((catalog?.agents ?? []).map((agent) => [agent.name, agent.mode]));
  const latestStepAgentByRunId = buildLatestStepAgentByRunId(runSteps);
  const runAgentTimelines = buildRunAgentEventTimelines(sessionEvents);

  const infoByMessageId = new Map<string, MessageAgentInfo>();
  for (const message of messages) {
    if (message.role !== "assistant" && message.role !== "tool") {
      continue;
    }

    const snapshot = readMessageAgentSnapshot(message);
    const eventAgentName = resolveAgentNameFromTimeline(message, message.runId ? runAgentTimelines.get(message.runId) : undefined);
    const latestStepAgentName = message.runId ? latestStepAgentByRunId.get(message.runId) : undefined;
    const agentName =
      snapshot?.name ??
      eventAgentName ??
      latestStepAgentName ??
      (message.runId && run?.id === message.runId ? run.effectiveAgentName ?? run.agentName : undefined) ??
      session?.activeAgentName ??
      undefined;

    if (!agentName) {
      continue;
    }

    const mode = snapshot?.mode ?? agentModeByName.get(agentName);
    infoByMessageId.set(message.id, {
      name: agentName,
      ...(mode ? { mode } : {})
    });
  }

  return infoByMessageId;
}

export function resolveMessageAgentInfo(params: ResolveMessageAgentInfoParams): MessageAgentInfo | null {
  const { message, catalog, runSteps, run, session, sessionEvents } = params;
  if (message.role !== "assistant" && message.role !== "tool") {
    return null;
  }

  const agentModeByName = new Map((catalog?.agents ?? []).map((agent) => [agent.name, agent.mode]));
  const latestStepAgentByRunId = buildLatestStepAgentByRunId(runSteps);
  const eventAgentName = resolveAgentNameFromEvents(message, sessionEvents);
  const latestStepAgentName = message.runId ? latestStepAgentByRunId.get(message.runId) : undefined;
  const snapshot = readMessageAgentSnapshot(message);
  const agentName =
    snapshot?.name ??
    eventAgentName ??
    latestStepAgentName ??
    (message.runId && run?.id === message.runId ? run.effectiveAgentName ?? run.agentName : undefined) ??
    session?.activeAgentName ??
    undefined;

  if (!agentName) {
    return null;
  }

  const mode = snapshot?.mode ?? agentModeByName.get(agentName);
  return { name: agentName, ...(mode ? { mode } : {}) };
}
