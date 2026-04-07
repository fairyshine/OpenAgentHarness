import type { Message, RunStep, SessionEventContract } from "@oah/api-contracts";

import {
  countMessagesByRole,
  readMessageModelCallStepRef,
  readMessageSystemPromptSnapshot,
  toModelCallTrace,
  uniqueStrings,
  type ModelCallTrace,
  type ModelCallTraceMessage
} from "./support";

function resolveMessageSystemMessages(message: Message | null, traces: ModelCallTrace[]): ModelCallTraceMessage[] {
  if (!message) {
    return [];
  }

  const snapshot = readMessageSystemPromptSnapshot(message);
  if (snapshot.length > 0) {
    return snapshot;
  }

  const stepRef = readMessageModelCallStepRef(message);
  if (stepRef?.stepId) {
    const matchedTrace = traces.find((trace) => trace.id === stepRef.stepId);
    if (matchedTrace) {
      return matchedTrace.input.messages.filter((traceMessage) => traceMessage.role === "system");
    }
  }

  if (stepRef?.stepSeq !== undefined) {
    const matchedTrace = traces.find((trace) => trace.seq === stepRef.stepSeq);
    if (matchedTrace) {
      return matchedTrace.input.messages.filter((traceMessage) => traceMessage.role === "system");
    }
  }

  return [];
}

export function buildRuntimeViewModel(params: {
  messages: Message[];
  runSteps: RunStep[];
  deferredEvents: SessionEventContract[];
  liveOutput: Record<string, string>;
  selectedTraceId: string;
  selectedMessageId: string;
  selectedStepId: string;
  selectedEventId: string;
  sessionId: string;
}) {
  const modelCallTraces = params.runSteps.map(toModelCallTrace).filter((trace): trace is ModelCallTrace => trace !== null);
  const firstModelCallTrace = modelCallTraces[0] ?? null;
  const latestModelCallTrace = modelCallTraces.at(-1) ?? null;
  const selectedModelCallTrace = modelCallTraces.find((trace) => trace.id === params.selectedTraceId) ?? firstModelCallTrace;
  const composedSystemMessages = firstModelCallTrace?.input.messages.filter((message) => message.role === "system") ?? [];
  const storedMessageCounts = countMessagesByRole(params.messages);
  const latestModelMessageCounts = countMessagesByRole(latestModelCallTrace?.input.messages ?? []);
  const selectedSessionMessage = params.messages.find((message) => message.id === params.selectedMessageId) ?? params.messages[0] ?? null;
  const selectedMessageSystemMessages = resolveMessageSystemMessages(selectedSessionMessage, modelCallTraces);
  const selectedRunStep = params.runSteps.find((step) => step.id === params.selectedStepId) ?? params.runSteps[0] ?? null;
  const selectedSessionEvent =
    params.deferredEvents.find((event) => event.id === params.selectedEventId) ?? params.deferredEvents[0] ?? null;
  const allRuntimeToolNames = uniqueStrings(modelCallTraces.flatMap((trace) => trace.input.runtimeToolNames));
  const allAdvertisedToolNames = uniqueStrings(modelCallTraces.flatMap((trace) => trace.input.activeToolNames));
  const allRuntimeTools = [
    ...new Map(modelCallTraces.flatMap((trace) => trace.input.runtimeTools).map((tool) => [tool.name, tool])).values()
  ];
  const allToolServers = [...new Map(modelCallTraces.flatMap((trace) => trace.input.toolServers).map((server) => [server.name, server])).values()];
  const resolvedModelNames = uniqueStrings(modelCallTraces.map((trace) => trace.input.model).filter((value): value is string => Boolean(value)));
  const resolvedModelRefs = uniqueStrings(
    modelCallTraces.map((trace) => trace.input.canonicalModelRef).filter((value): value is string => Boolean(value))
  );
  const persistedAssistantRunIds = new Set(
    params.messages.flatMap((message) => (message.role === "assistant" && message.runId ? [message.runId] : []))
  );
  const messageFeed = [
    ...params.messages,
    ...Object.entries(params.liveOutput).flatMap(([runId, content]) => {
      if (!content || persistedAssistantRunIds.has(runId)) {
        return [];
      }

      return [
        {
          id: `live:${runId}`,
          sessionId: params.sessionId || "live",
          runId,
          role: "assistant" as const,
          content,
          createdAt: new Date().toISOString()
        }
      ];
    })
  ];

  return {
    modelCallTraces,
    firstModelCallTrace,
    latestModelCallTrace,
    selectedModelCallTrace,
    composedSystemMessages,
    storedMessageCounts,
    latestModelMessageCounts,
    selectedSessionMessage,
    selectedMessageSystemMessages,
    selectedRunStep,
    selectedSessionEvent,
    allRuntimeToolNames,
    allAdvertisedToolNames,
    allRuntimeTools,
    allToolServers,
    resolvedModelNames,
    resolvedModelRefs,
    messageFeed
  };
}
