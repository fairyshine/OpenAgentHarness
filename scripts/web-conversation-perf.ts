import { performance } from "node:perf_hooks";

import type { Message, RunStep, Session, SessionEventContract } from "@oah/api-contracts";

import { buildMessageAgentInfoIndex } from "../apps/web/src/app/chat/message-agent-info";
import { buildRuntimeViewModel } from "../apps/web/src/app/engine-view-model";
import type { LiveConversationMessageRecord } from "../apps/web/src/app/support";

const SESSION_ID = "ses_perf";
const BASE_TIME_MS = Date.parse("2026-04-22T09:00:00.000Z");
const RUN_COUNT = 1200;
const LIVE_RUN_COUNT = 48;
const ITERATIONS = 12;
const WARMUP_ITERATIONS = 4;

function iso(offsetMs: number) {
  return new Date(BASE_TIME_MS + offsetMs).toISOString();
}

function createPerfDataset() {
  const messages: Message[] = [];
  const runSteps: RunStep[] = [];
  const deferredEvents: SessionEventContract[] = [];
  const liveMessagesByKey: Record<string, LiveConversationMessageRecord> = {};
  const queuedMessageIds = new Set<string>();

  for (let index = 0; index < RUN_COUNT; index += 1) {
    const runId = `run_${index}`;
    const userMessageId = `msg_user_${index}`;
    const assistantMessageId = `msg_assistant_${index}`;
    const runOffsetMs = index * 4_000;
    const userCreatedAt = iso(runOffsetMs);
    const assistantCreatedAt = iso(runOffsetMs + 2_200);
    const isLiveOnlyRun = index >= RUN_COUNT - LIVE_RUN_COUNT;

    messages.push({
      id: userMessageId,
      sessionId: SESSION_ID,
      runId,
      role: "user",
      content: `Explain the state of synthetic request #${index}.`,
      createdAt: userCreatedAt
    });

    if (!isLiveOnlyRun) {
      messages.push({
        id: assistantMessageId,
        sessionId: SESSION_ID,
        runId,
        role: "assistant",
        content:
          `Synthetic assistant response #${index}\n\n` +
          `- summarizes a longer conversation slice\n` +
          `- includes follow-up context\n` +
          `- keeps enough text to exercise markdown and sorting paths`,
        metadata: {
          agentName: index % 3 === 0 ? "planner" : index % 3 === 1 ? "coder" : "researcher",
          effectiveAgentName: index % 3 === 0 ? "planner" : index % 3 === 1 ? "coder" : "researcher",
          agentMode: index % 3 === 2 ? "subagent" : "primary",
          modelCallStepId: `step_${index}`,
          modelCallStepSeq: index + 1
        },
        createdAt: assistantCreatedAt
      });
    } else {
      liveMessagesByKey[`message:${assistantMessageId}`] = {
        persistedMessageId: assistantMessageId,
        runId,
        sessionId: SESSION_ID,
        role: "assistant",
        content:
          `Live synthetic assistant response #${index}\n\n` +
          `This message remains in-memory to exercise the live merge path.`,
        metadata: {
          agentName: "researcher",
          effectiveAgentName: "researcher",
          agentMode: "subagent"
        },
        createdAt: assistantCreatedAt
      };
    }

    runSteps.push({
      id: `step_${index}`,
      runId,
      seq: index + 1,
      stepType: "model_call",
      status: "completed",
      agentName: index % 2 === 0 ? "planner" : "coder",
      input: {
        request: {
          model: "openai-default",
          canonicalModelRef: "platform/openai-default",
          messages: [
            { role: "system", content: `Synthetic system prompt #${index}` },
            { role: "user", content: `Prompt #${index}` }
          ]
        },
        runtime: {
          messageCount: 2,
          activeToolNames: [],
          engineToolNames: []
        }
      },
      output: {
        response: {
          text: `ok:${index}`,
          finishReason: "stop",
          toolCalls: [],
          toolResults: []
        },
        runtime: {
          toolCallsCount: 0,
          toolResultsCount: 0
        }
      },
      startedAt: iso(runOffsetMs + 400),
      endedAt: iso(runOffsetMs + 1_800)
    });

    deferredEvents.push(
      {
        id: `evt_run_started_${index}`,
        sessionId: SESSION_ID,
        runId,
        cursor: String(index * 10 + 1),
        event: "run.started",
        createdAt: iso(runOffsetMs + 100),
        data: {}
      },
      {
        id: `evt_agent_switched_${index}`,
        sessionId: SESSION_ID,
        runId,
        cursor: String(index * 10 + 2),
        event: "agent.switched",
        createdAt: iso(runOffsetMs + 150),
        data: {
          toAgent: index % 2 === 0 ? "planner" : "coder"
        }
      },
      {
        id: `evt_message_delta_a_${index}`,
        sessionId: SESSION_ID,
        runId,
        cursor: String(index * 10 + 3),
        event: "message.delta",
        createdAt: iso(runOffsetMs + 500),
        data: {
          messageId: assistantMessageId,
          delta: `Synthetic delta A for ${index}. `
        }
      },
      {
        id: `evt_message_delta_b_${index}`,
        sessionId: SESSION_ID,
        runId,
        cursor: String(index * 10 + 4),
        event: "message.delta",
        createdAt: iso(runOffsetMs + 650),
        data: {
          messageId: assistantMessageId,
          delta: `Synthetic delta B for ${index}.`
        }
      },
      {
        id: `evt_message_completed_${index}`,
        sessionId: SESSION_ID,
        runId,
        cursor: String(index * 10 + 5),
        event: "message.completed",
        createdAt: iso(runOffsetMs + 1_900),
        data: {
          messageId: assistantMessageId
        }
      },
      {
        id: `evt_run_completed_${index}`,
        sessionId: SESSION_ID,
        runId,
        cursor: String(index * 10 + 6),
        event: "run.completed",
        createdAt: iso(runOffsetMs + 2_300),
        data: {}
      }
    );

    if (index % 17 === 0) {
      queuedMessageIds.add(userMessageId);
    }
  }

  const session: Session = {
    id: SESSION_ID,
    workspaceId: "ws_perf",
    title: "Perf Session",
    createdAt: iso(0),
    updatedAt: iso(RUN_COUNT * 4_000),
    activeAgentName: "planner"
  };

  return {
    messages,
    runSteps,
    deferredEvents,
    liveMessagesByKey,
    queuedMessageIds,
    session
  };
}

function percentile(values: number[], ratio: number) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

function formatMs(value: number) {
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ms`;
}

function measure(label: string, iterations: number, run: () => number) {
  for (let index = 0; index < WARMUP_ITERATIONS; index += 1) {
    run();
  }

  const durations: number[] = [];
  let checksum = 0;
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    checksum += run();
    durations.push(performance.now() - startedAt);
  }

  const average = durations.reduce((sum, value) => sum + value, 0) / Math.max(1, durations.length);
  return {
    label,
    checksum,
    min: Math.min(...durations),
    avg: average,
    p95: percentile(durations, 0.95),
    max: Math.max(...durations)
  };
}

const dataset = createPerfDataset();
const viewModel = buildRuntimeViewModel({
  messages: dataset.messages,
  queuedMessageIds: dataset.queuedMessageIds,
  runSteps: dataset.runSteps,
  deferredEvents: dataset.deferredEvents,
  liveMessagesByKey: dataset.liveMessagesByKey,
  selectedTraceId: "",
  selectedMessageId: "",
  selectedStepId: "",
  selectedEventId: "",
  sessionId: SESSION_ID
});

const agentInfoIndex = buildMessageAgentInfoIndex({
  messages: viewModel.messageFeed,
  catalog: null,
  runSteps: dataset.runSteps,
  run: null,
  session: dataset.session,
  sessionEvents: dataset.deferredEvents
});

const combinedMetrics = measure("runtime+agent-index", ITERATIONS, () => {
  const nextViewModel = buildRuntimeViewModel({
    messages: dataset.messages,
    queuedMessageIds: dataset.queuedMessageIds,
    runSteps: dataset.runSteps,
    deferredEvents: dataset.deferredEvents,
    liveMessagesByKey: dataset.liveMessagesByKey,
    selectedTraceId: "",
    selectedMessageId: "",
    selectedStepId: "",
    selectedEventId: "",
    sessionId: SESSION_ID
  });
  const nextAgentInfoIndex = buildMessageAgentInfoIndex({
    messages: nextViewModel.messageFeed,
    catalog: null,
    runSteps: dataset.runSteps,
    run: null,
    session: dataset.session,
    sessionEvents: dataset.deferredEvents
  });

  return nextViewModel.messageFeed.length + nextAgentInfoIndex.size;
});

const projectionMetrics = measure("runtime-view-model", ITERATIONS, () => {
  const nextViewModel = buildRuntimeViewModel({
    messages: dataset.messages,
    queuedMessageIds: dataset.queuedMessageIds,
    runSteps: dataset.runSteps,
    deferredEvents: dataset.deferredEvents,
    liveMessagesByKey: dataset.liveMessagesByKey,
    selectedTraceId: "",
    selectedMessageId: "",
    selectedStepId: "",
    selectedEventId: "",
    sessionId: SESSION_ID
  });

  return nextViewModel.messageFeed.length;
});

const agentIndexMetrics = measure("message-agent-index", ITERATIONS, () => {
  const nextAgentInfoIndex = buildMessageAgentInfoIndex({
    messages: viewModel.messageFeed,
    catalog: null,
    runSteps: dataset.runSteps,
    run: null,
    session: dataset.session,
    sessionEvents: dataset.deferredEvents
  });

  return nextAgentInfoIndex.size;
});

console.log("Synthetic conversation perf smoke");
console.log(
  [
    `runs=${RUN_COUNT}`,
    `messages=${dataset.messages.length}`,
    `events=${dataset.deferredEvents.length}`,
    `runSteps=${dataset.runSteps.length}`,
    `liveMessages=${Object.keys(dataset.liveMessagesByKey).length}`,
    `feed=${viewModel.messageFeed.length}`,
    `agentInfo=${agentInfoIndex.size}`
  ].join(" | ")
);
for (const metric of [projectionMetrics, agentIndexMetrics, combinedMetrics]) {
  console.log(
    `${metric.label.padEnd(20)} min=${formatMs(metric.min)} avg=${formatMs(metric.avg)} p95=${formatMs(metric.p95)} max=${formatMs(metric.max)} checksum=${metric.checksum}`
  );
}
