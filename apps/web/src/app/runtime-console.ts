import type {
  EngineLogCategory,
  EngineLogEventData,
  EngineLogLevel,
  SessionEventContract
} from "@oah/api-contracts";

import { isRecord } from "./support-core";
import type { AppRequestErrorSummary, RuntimeConsoleEntry } from "./support-types";

function isEngineLogLevel(value: unknown): value is EngineLogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

function isEngineLogCategory(value: unknown): value is EngineLogCategory {
  return value === "run" || value === "model" || value === "tool" || value === "hook" || value === "agent" || value === "http" || value === "system";
}

function engineLogDataFromEvent(event: SessionEventContract): EngineLogEventData | null {
  if (!isRecord(event.data)) {
    return null;
  }

  const { level, category, message, source, timestamp } = event.data;
  if (
    !isEngineLogLevel(level) ||
    !isEngineLogCategory(category) ||
    typeof message !== "string" ||
    (source !== "server" && source !== "web") ||
    typeof timestamp !== "string"
  ) {
    return null;
  }

  return {
    level,
    category,
    message,
    ...(event.data.details !== undefined ? { details: event.data.details } : {}),
    ...(isRecord(event.data.context) ? { context: event.data.context } : {}),
    source,
    timestamp
  };
}

function levelFromEventName(eventName: SessionEventContract["event"], data: Record<string, unknown>): EngineLogLevel {
  switch (eventName) {
    case "tool.failed":
    case "run.failed":
      return "error";
    case "hook.notice":
    case "run.cancelled":
      return typeof data.errorMessage === "string" || typeof data.errorCode === "string" ? "warn" : "info";
    default:
      return "info";
  }
}

function categoryFromEventName(eventName: SessionEventContract["event"]): EngineLogCategory | null {
  switch (eventName) {
    case "queue.updated":
    case "run.queued":
    case "run.started":
    case "run.completed":
    case "run.failed":
    case "run.cancelled":
      return "run";
    case "tool.started":
    case "tool.completed":
    case "tool.failed":
      return "tool";
    case "hook.notice":
      return "hook";
    case "agent.switch.requested":
    case "agent.switched":
    case "agent.delegate.started":
    case "agent.delegate.completed":
    case "agent.delegate.failed":
      return "agent";
    default:
      return null;
  }
}

function consoleMessageFromEvent(event: SessionEventContract): string {
  switch (event.event) {
    case "queue.updated":
      return `Queue updated${typeof event.data.runId === "string" ? ` · ${event.data.runId}` : ""}`;
    case "run.queued":
      return `Run queued${typeof event.data.runId === "string" ? ` · ${event.data.runId}` : ""}`;
    case "run.started":
      return `Run started${typeof event.data.runId === "string" ? ` · ${event.data.runId}` : ""}`;
    case "run.completed":
      return `Run completed${typeof event.data.runId === "string" ? ` · ${event.data.runId}` : ""}`;
    case "run.failed":
      return typeof event.data.errorMessage === "string" ? event.data.errorMessage : "Run failed.";
    case "run.cancelled":
      return "Run cancelled.";
    case "tool.started":
      return `Tool started: ${typeof event.data.toolName === "string" ? event.data.toolName : "unknown"}`;
    case "tool.completed":
      return `Tool completed: ${typeof event.data.toolName === "string" ? event.data.toolName : "unknown"}`;
    case "tool.failed":
      return typeof event.data.errorMessage === "string"
        ? event.data.errorMessage
        : `Tool failed: ${typeof event.data.toolName === "string" ? event.data.toolName : "unknown"}`;
    case "hook.notice":
      return typeof event.data.errorMessage === "string"
        ? event.data.errorMessage
        : `Hook notice: ${typeof event.data.hookName === "string" ? event.data.hookName : "unknown"}`;
    case "agent.switch.requested":
      return `Agent switch requested${typeof event.data.toAgent === "string" ? ` → ${event.data.toAgent}` : ""}`;
    case "agent.switched":
      return `Agent switched${typeof event.data.toAgent === "string" ? ` → ${event.data.toAgent}` : ""}`;
    case "agent.delegate.started":
      return `Delegation started${typeof event.data.agentName === "string" ? ` · ${event.data.agentName}` : ""}`;
    case "agent.delegate.completed":
      return "Delegation completed.";
    case "agent.delegate.failed":
      return typeof event.data.errorMessage === "string" ? event.data.errorMessage : "Delegation failed.";
    default:
      return event.event;
  }
}

function buildRuntimeConsoleEntries(events: SessionEventContract[], activeError: AppRequestErrorSummary | null): RuntimeConsoleEntry[] {
  const eventEntries = events
    .map((event): RuntimeConsoleEntry | null => {
      if (event.event === "message.delta" || event.event === "message.completed") {
        return null;
      }

      const engineLog = event.event === "engine.log" ? engineLogDataFromEvent(event) : null;
      if (engineLog) {
        return {
          id: `console:${event.id}`,
          timestamp: engineLog.timestamp,
          level: engineLog.level,
          category: engineLog.category,
          message: engineLog.message,
          ...(engineLog.details !== undefined ? { details: engineLog.details } : {}),
          source: engineLog.source,
          eventId: event.id,
          eventName: event.event,
          ...(event.runId ? { runId: event.runId } : {}),
          cursor: event.cursor,
          ...(typeof engineLog.context?.stepId === "string" ? { stepId: engineLog.context.stepId } : {})
        };
      }

      const category = categoryFromEventName(event.event);
      if (!category) {
        return null;
      }

      return {
        id: `console:${event.id}`,
        timestamp: event.createdAt,
        level: levelFromEventName(event.event, event.data),
        category,
        message: consoleMessageFromEvent(event),
        details: event.data,
        source: "server",
        eventId: event.id,
        eventName: event.event,
        ...(event.runId ? { runId: event.runId } : {}),
        cursor: event.cursor,
        ...(typeof event.data.stepId === "string" ? { stepId: event.data.stepId } : {})
      };
    })
    .filter((entry): entry is RuntimeConsoleEntry => entry !== null);

  const errorEntries: RuntimeConsoleEntry[] = activeError
    ? [
        {
          id: "console:active-error",
          timestamp: activeError.timestamp ?? new Date().toISOString(),
          level: "error",
          category: "http",
          message: activeError.message,
          details: {
            ...(activeError.code ? { code: activeError.code } : {}),
            ...(activeError.details ? { details: activeError.details } : {}),
            ...(activeError.statusCode ? { statusCode: activeError.statusCode } : {}),
            ...(activeError.statusText ? { statusText: activeError.statusText } : {})
          },
          source: "web"
        }
      ]
    : [];

  return [...eventEntries, ...errorEntries].sort((left, right) => {
    const timestampCompare = left.timestamp.localeCompare(right.timestamp);
    if (timestampCompare !== 0) {
      return timestampCompare;
    }

    return left.id.localeCompare(right.id);
  });
}

export { buildRuntimeConsoleEntries };
