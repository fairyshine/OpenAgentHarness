import { describe, expect, it } from "vitest";

import type { Message, RunStep } from "@oah/api-contracts";

import { buildRuntimeViewModel } from "../apps/web/src/app/runtime-view-model";

function createModelCallStep(input: Partial<RunStep> = {}): RunStep {
  return {
    id: "step_model_1",
    runId: "run_1",
    seq: 2,
    stepType: "model_call",
    status: "completed",
    input: {
      request: {
        model: "openai-default",
        canonicalModelRef: "platform/openai-default",
        messages: [
          {
            role: "system",
            content: "trace system prompt"
          },
          {
            role: "user",
            content: "hello"
          }
        ]
      },
      runtime: {
        messageCount: 2,
        activeToolNames: [],
        runtimeToolNames: []
      }
    },
    output: {
      response: {
        text: "done",
        finishReason: "stop",
        toolCalls: [],
        toolResults: []
      },
      runtime: {
        toolCallsCount: 0,
        toolResultsCount: 0
      }
    },
    startedAt: "2026-04-07T00:00:00.000Z",
    endedAt: "2026-04-07T00:00:01.000Z",
    ...input
  };
}

function createAssistantMessage(input: Partial<Message> = {}): Message {
  return {
    id: "msg_1",
    sessionId: "ses_1",
    runId: "run_1",
    role: "assistant",
    content: "reply",
    createdAt: "2026-04-07T00:00:02.000Z",
    ...input
  };
}

describe("buildRuntimeViewModel", () => {
  it("prefers the persisted message system prompt snapshot for the selected message", () => {
    const message = createAssistantMessage({
      metadata: {
        systemMessages: [
          {
            role: "system",
            content: "persisted message prompt"
          }
        ],
        modelCallStepId: "step_model_1",
        modelCallStepSeq: 2
      }
    });

    const viewModel = buildRuntimeViewModel({
      messages: [message],
      runSteps: [createModelCallStep()],
      deferredEvents: [],
      liveOutput: {},
      selectedTraceId: "",
      selectedMessageId: message.id,
      selectedStepId: "",
      selectedEventId: "",
      sessionId: "ses_1"
    });

    expect(viewModel.composedSystemMessages.map((entry) => entry.content)).toEqual(["trace system prompt"]);
    expect(viewModel.selectedMessageSystemMessages.map((entry) => entry.content)).toEqual(["persisted message prompt"]);
  });

  it("falls back to the referenced model-call trace when the message snapshot is missing", () => {
    const message = createAssistantMessage({
      metadata: {
        modelCallStepId: "step_model_1",
        modelCallStepSeq: 2
      }
    });

    const viewModel = buildRuntimeViewModel({
      messages: [message],
      runSteps: [createModelCallStep()],
      deferredEvents: [],
      liveOutput: {},
      selectedTraceId: "",
      selectedMessageId: message.id,
      selectedStepId: "",
      selectedEventId: "",
      sessionId: "ses_1"
    });

    expect(viewModel.selectedMessageSystemMessages.map((entry) => entry.content)).toEqual(["trace system prompt"]);
  });
});
