import { describe, expect, it } from "vitest";

import type { Message, RunStep, SessionEventContract } from "@oah/api-contracts";

import { buildRuntimeViewModel } from "../apps/web/src/app/engine-view-model";
import { hasDisplayableRunMessages } from "../apps/web/src/app/support";

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
        engineToolNames: []
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

function createEvent(input: Partial<SessionEventContract> & Pick<SessionEventContract, "cursor" | "event" | "data">): SessionEventContract {
  return {
    id: `evt_${input.cursor}`,
    sessionId: "ses_1",
    createdAt: "2026-04-07T00:00:00.000Z",
    ...input
  };
}

describe("buildRuntimeViewModel", () => {
  it("treats tool-only subagent output as a displayable completed result", () => {
    const toolResultMessage: Message = {
      id: "msg_tool_result",
      sessionId: "ses_1",
      runId: "run_1",
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tool_1",
          toolName: "Bash",
          output: {
            type: "text",
            value: "subagent-tool-fallback"
          }
        }
      ],
      createdAt: "2026-04-07T00:00:02.000Z"
    };

    expect(hasDisplayableRunMessages([toolResultMessage], "run_1")).toBe(true);
  });

  it("does not wait forever for an empty completed run message", () => {
    const emptyAssistantMessage = createAssistantMessage({
      content: "   "
    });

    expect(hasDisplayableRunMessages([emptyAssistantMessage], "run_1")).toBe(false);
  });

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
      queuedMessageIds: new Set(),
      runSteps: [createModelCallStep()],
      deferredEvents: [],
      liveMessagesByKey: {},
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
      queuedMessageIds: new Set(),
      runSteps: [createModelCallStep()],
      deferredEvents: [],
      liveMessagesByKey: {},
      selectedTraceId: "",
      selectedMessageId: message.id,
      selectedStepId: "",
      selectedEventId: "",
      sessionId: "ses_1"
    });

    expect(viewModel.selectedMessageSystemMessages.map((entry) => entry.content)).toEqual(["trace system prompt"]);
  });

  it("keeps multiple assistant bubbles from the same run when live output belongs to a different message", () => {
    const toolCallMessage = createAssistantMessage({
      id: "msg_tool_call",
      content: [
        {
          type: "tool-call",
          toolCallId: "tool_1",
          toolName: "read_file",
          input: {
            path: "README.md"
          }
        }
      ],
      createdAt: "2026-04-07T00:00:02.000Z"
    });
    const finalAssistantMessageId = "msg_final_assistant";

    const viewModel = buildRuntimeViewModel({
      messages: [toolCallMessage],
      queuedMessageIds: new Set(),
      runSteps: [createModelCallStep()],
      deferredEvents: [],
      liveMessagesByKey: {
        [`message:${finalAssistantMessageId}`]: {
          persistedMessageId: finalAssistantMessageId,
          runId: "run_1",
          sessionId: "ses_1",
          content: "streaming final reply",
          createdAt: "2026-04-07T00:00:04.000Z"
        }
      },
      selectedTraceId: "",
      selectedMessageId: toolCallMessage.id,
      selectedStepId: "",
      selectedEventId: "",
      sessionId: "ses_1"
    });

    expect(viewModel.messageFeed.map((message) => message.id)).toEqual(["msg_tool_call", "live:msg_final_assistant"]);
    expect(viewModel.messageFeed.map((message) => message.role)).toEqual(["assistant", "assistant"]);
  });

  it("replaces the persisted copy when live output is for the same assistant message", () => {
    const persistedAssistantMessage = createAssistantMessage({
      id: "msg_streaming",
      content: "stale persisted reply",
      createdAt: "2026-04-07T00:00:03.000Z"
    });

    const viewModel = buildRuntimeViewModel({
      messages: [persistedAssistantMessage],
      queuedMessageIds: new Set(),
      runSteps: [createModelCallStep()],
      deferredEvents: [],
      liveMessagesByKey: {
        "message:msg_streaming": {
          persistedMessageId: "msg_streaming",
          runId: "run_1",
          sessionId: "ses_1",
          content: "fresh live reply",
          createdAt: "2026-04-07T00:00:05.000Z"
        }
      },
      selectedTraceId: "",
      selectedMessageId: persistedAssistantMessage.id,
      selectedStepId: "",
      selectedEventId: "",
      sessionId: "ses_1"
    });

    expect(viewModel.messageFeed).toHaveLength(1);
    expect(viewModel.messageFeed[0]).toMatchObject({
      id: "live:msg_streaming",
      content: "fresh live reply",
      createdAt: "2026-04-07T00:00:03.000Z"
    });
  });

  it("preserves live assistant metadata for the conversation view", () => {
    const viewModel = buildRuntimeViewModel({
      messages: [],
      queuedMessageIds: new Set(),
      runSteps: [createModelCallStep()],
      deferredEvents: [],
      liveMessagesByKey: {
        "message:msg_streaming": {
          persistedMessageId: "msg_streaming",
          runId: "run_1",
          sessionId: "ses_1",
          content: "fresh live reply",
          metadata: {
            agentName: "plan",
            effectiveAgentName: "plan",
            agentMode: "primary"
          },
          createdAt: "2026-04-07T00:00:05.000Z"
        }
      },
      selectedTraceId: "",
      selectedMessageId: "",
      selectedStepId: "",
      selectedEventId: "",
      sessionId: "ses_1"
    });

    expect(viewModel.messageFeed).toHaveLength(1);
    expect(viewModel.messageFeed[0]).toMatchObject({
      id: "live:msg_streaming",
      metadata: {
        agentName: "plan",
        effectiveAgentName: "plan",
        agentMode: "primary"
      }
    });
  });

  it("renders live tool-call and tool-result messages before persistence catches up", () => {
    const viewModel = buildRuntimeViewModel({
      messages: [],
      queuedMessageIds: new Set(),
      runSteps: [createModelCallStep()],
      deferredEvents: [],
      liveMessagesByKey: {
        "tool-call:call_readme": {
          toolCallId: "call_readme",
          runId: "run_1",
          sessionId: "ses_1",
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_readme",
              toolName: "Read",
              input: {
                path: "README.md"
              }
            }
          ],
          metadata: {
            toolStatus: "running",
            toolSourceType: "native"
          },
          createdAt: "2026-04-07T00:00:03.000Z"
        },
        "tool-result:call_readme": {
          toolCallId: "call_readme",
          runId: "run_1",
          sessionId: "ses_1",
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_readme",
              toolName: "Read",
              output: {
                type: "text",
                value: "README body"
              }
            }
          ],
          metadata: {
            toolStatus: "completed",
            toolSourceType: "native",
            toolDurationMs: 320
          },
          createdAt: "2026-04-07T00:00:04.000Z"
        }
      },
      selectedTraceId: "",
      selectedMessageId: "",
      selectedStepId: "",
      selectedEventId: "",
      sessionId: "ses_1"
    });

    expect(viewModel.messageFeed.map((message) => message.id)).toEqual([
      "live:tool-call:call_readme",
      "live:tool-result:call_readme"
    ]);
    expect(viewModel.messageFeed.map((message) => message.role)).toEqual(["assistant", "tool"]);
    expect(viewModel.messageFeed[0]).toMatchObject({
      metadata: {
        toolStatus: "running",
        toolSourceType: "native"
      }
    });
    expect(viewModel.messageFeed[1]).toMatchObject({
      metadata: {
        toolStatus: "completed",
        toolSourceType: "native",
        toolDurationMs: 320
      }
    });
  });

  it("hides live tool messages once matching persisted messages exist", () => {
    const persistedToolCall = createAssistantMessage({
      id: "msg_tool_call",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_readme",
          toolName: "Read",
          input: {
            path: "README.md"
          }
        }
      ],
      metadata: {
        toolStatus: "completed",
        toolSourceType: "native",
        toolDurationMs: 320
      },
      createdAt: "2026-04-07T00:00:03.000Z"
    });
    const persistedToolResult: Message = {
      id: "msg_tool_result",
      sessionId: "ses_1",
      runId: "run_1",
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_readme",
          toolName: "Read",
          output: {
            type: "text",
            value: "README body"
          }
        }
      ],
      metadata: {
        toolStatus: "completed",
        toolSourceType: "native",
        toolDurationMs: 320
      },
      createdAt: "2026-04-07T00:00:04.000Z"
    };

    const viewModel = buildRuntimeViewModel({
      messages: [persistedToolCall, persistedToolResult],
      queuedMessageIds: new Set(),
      runSteps: [createModelCallStep()],
      deferredEvents: [],
      liveMessagesByKey: {
        "tool-call:call_readme": {
          toolCallId: "call_readme",
          runId: "run_1",
          sessionId: "ses_1",
          role: "assistant",
          content: persistedToolCall.content,
          createdAt: "2026-04-07T00:00:03.000Z"
        },
        "tool-result:call_readme": {
          toolCallId: "call_readme",
          runId: "run_1",
          sessionId: "ses_1",
          role: "tool",
          content: persistedToolResult.content,
          createdAt: "2026-04-07T00:00:04.000Z"
        }
      },
      selectedTraceId: "",
      selectedMessageId: "",
      selectedStepId: "",
      selectedEventId: "",
      sessionId: "ses_1"
    });

    expect(viewModel.messageFeed.map((message) => message.id)).toEqual(["msg_tool_call", "msg_tool_result"]);
    expect(viewModel.messageFeed[0]?.metadata).toMatchObject({
      toolStatus: "completed",
      toolSourceType: "native",
      toolDurationMs: 320
    });
    expect(viewModel.messageFeed[1]?.metadata).toMatchObject({
      toolStatus: "completed",
      toolSourceType: "native",
      toolDurationMs: 320
    });
  });

  it("preserves started status for background tool launch messages", () => {
    const viewModel = buildRuntimeViewModel({
      messages: [],
      queuedMessageIds: new Set(),
      runSteps: [createModelCallStep()],
      deferredEvents: [],
      liveMessagesByKey: {
        "tool-call:call_background": {
          toolCallId: "call_background",
          runId: "run_1",
          sessionId: "ses_1",
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_background",
              toolName: "SubAgent",
              input: {
                description: "Research in background",
                run_in_background: true
              }
            }
          ],
          metadata: {
            toolStatus: "started",
            toolSourceType: "agent",
            toolDurationMs: 120
          },
          createdAt: "2026-04-07T00:00:03.000Z"
        },
        "tool-result:call_background": {
          toolCallId: "call_background",
          runId: "run_1",
          sessionId: "ses_1",
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_background",
              toolName: "SubAgent",
              output: {
                type: "text",
                value: "started: true\nsubagent_name: researcher\ntask_id: ses_child"
              }
            }
          ],
          metadata: {
            toolStatus: "started",
            toolSourceType: "agent",
            toolDurationMs: 120
          },
          createdAt: "2026-04-07T00:00:04.000Z"
        }
      },
      selectedTraceId: "",
      selectedMessageId: "",
      selectedStepId: "",
      selectedEventId: "",
      sessionId: "ses_1"
    });

    expect(viewModel.messageFeed.map((message) => message.id)).toEqual([
      "live:tool-call:call_background",
      "live:tool-result:call_background"
    ]);
    expect(viewModel.messageFeed[0]).toMatchObject({
      metadata: {
        toolStatus: "started",
        toolSourceType: "agent",
        toolDurationMs: 120
      }
    });
    expect(viewModel.messageFeed[1]).toMatchObject({
      metadata: {
        toolStatus: "started",
        toolSourceType: "agent",
        toolDurationMs: 120
      }
    });
  });

  it("anchors a guided queued run by execution time instead of original queue time", () => {
    const activeRunAssistant = createAssistantMessage({
      id: "msg_active_assistant",
      runId: "run_active",
      content: "current run reply",
      createdAt: "2026-04-07T00:00:05.000Z"
    });
    const guidedUserMessage: Message = {
      id: "msg_guided_user",
      sessionId: "ses_1",
      runId: "run_guided",
      role: "user",
      content: "queued then guided",
      createdAt: "2026-04-07T00:00:01.000Z"
    };
    const guidedAssistantMessage = createAssistantMessage({
      id: "msg_guided_assistant",
      runId: "run_guided",
      content: "guided reply",
      createdAt: "2026-04-07T00:00:07.000Z"
    });

    const viewModel = buildRuntimeViewModel({
      messages: [guidedUserMessage, activeRunAssistant, guidedAssistantMessage],
      queuedMessageIds: new Set(),
      runSteps: [createModelCallStep()],
      deferredEvents: [
        createEvent({
          cursor: "1",
          runId: "run_guided",
          event: "run.started",
          data: {
            runId: "run_guided",
            status: "running"
          },
          createdAt: "2026-04-07T00:00:06.000Z"
        })
      ],
      liveMessagesByKey: {},
      selectedTraceId: "",
      selectedMessageId: "",
      selectedStepId: "",
      selectedEventId: "",
      sessionId: "ses_1"
    });

    expect(viewModel.messageFeed.map((message) => message.id)).toEqual([
      "msg_active_assistant",
      "msg_guided_user",
      "msg_guided_assistant"
    ]);
  });

  it("keeps the user message at the start of a run even when assistant messages are projected from events", () => {
    const userMessage: Message = {
      id: "msg_user_run_start",
      sessionId: "ses_1",
      runId: "run_1",
      role: "user",
      content: "tell me more",
      createdAt: "2026-04-07T00:00:00.000Z"
    };
    const assistantMessage = createAssistantMessage({
      id: "msg_assistant_run_body",
      runId: "run_1",
      content: "more detail",
      createdAt: "2026-04-07T00:00:01.000Z"
    });

    const viewModel = buildRuntimeViewModel({
      messages: [userMessage, assistantMessage],
      queuedMessageIds: new Set(),
      runSteps: [createModelCallStep()],
      deferredEvents: [
        createEvent({
          cursor: "1",
          runId: "run_1",
          event: "message.completed",
          data: {
            messageId: assistantMessage.id,
            content: assistantMessage.content
          }
        })
      ],
      liveMessagesByKey: {},
      selectedTraceId: "",
      selectedMessageId: "",
      selectedStepId: "",
      selectedEventId: "",
      sessionId: "ses_1"
    });

    expect(viewModel.messageFeed.map((message) => message.id)).toEqual([
      userMessage.id,
      assistantMessage.id
    ]);
  });

  it("projects interrupted assistant text into separate bubbles using session events", () => {
    const userMessage: Message = {
      id: "msg_user",
      sessionId: "ses_1",
      role: "user",
      content: "hello",
      createdAt: "2026-04-07T00:00:00.000Z"
    };
    const streamedAssistant = createAssistantMessage({
      id: "msg_streamed",
      content: [{ type: "text", text: "first part second part" }],
      createdAt: "2026-04-07T00:00:01.000Z"
    });
    const assistantToolCall = createAssistantMessage({
      id: "msg_tool_call",
      content: [
        {
          type: "tool-call",
          toolCallId: "tool_1",
          toolName: "AgentSwitch",
          input: { to: "plan" }
        }
      ],
      createdAt: "2026-04-07T00:00:02.000Z"
    });
    const toolResult: Message = {
      id: "msg_tool_result",
      sessionId: "ses_1",
      runId: "run_1",
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tool_1",
          toolName: "AgentSwitch",
          output: {
            type: "text",
            value: "switched"
          }
        }
      ],
      createdAt: "2026-04-07T00:00:03.000Z"
    };

    const viewModel = buildRuntimeViewModel({
      messages: [userMessage, streamedAssistant, assistantToolCall, toolResult],
      queuedMessageIds: new Set(),
      runSteps: [createModelCallStep()],
      deferredEvents: [
        createEvent({
          cursor: "2",
          runId: "run_1",
          event: "message.completed",
          data: {
            messageId: "msg_tool_call",
            content: assistantToolCall.content
          }
        }),
        createEvent({
          cursor: "1",
          runId: "run_1",
          event: "message.delta",
          data: {
            messageId: "msg_streamed",
            delta: "first part"
          }
        }),
        createEvent({
          cursor: "3",
          runId: "run_1",
          event: "message.completed",
          data: {
            messageId: "msg_tool_result",
            toolCallId: "tool_1",
            toolName: "AgentSwitch",
            content: toolResult.content
          }
        }),
        createEvent({
          cursor: "4",
          runId: "run_1",
          event: "message.delta",
          data: {
            messageId: "msg_streamed",
            delta: "second part"
          }
        }),
        createEvent({
          cursor: "5",
          runId: "run_1",
          event: "run.completed",
          data: {
            runId: "run_1",
            status: "completed"
          }
        })
      ],
      liveMessagesByKey: {},
      selectedTraceId: "",
      selectedMessageId: streamedAssistant.id,
      selectedStepId: "",
      selectedEventId: "",
      sessionId: "ses_1"
    });

    expect(viewModel.messageFeed.map((message) => message.id)).toEqual([
      "msg_user",
      "segment:msg_streamed:1",
      "msg_tool_call",
      "msg_tool_result",
      "segment:msg_streamed:2"
    ]);
    expect(viewModel.messageFeed.map((message) => message.content)).toEqual([
      "hello",
      "first part",
      assistantToolCall.content,
      toolResult.content,
      "second part"
    ]);
  });

  it("keeps a live interrupted assistant segment in its projected position before completion", () => {
    const userMessage: Message = {
      id: "msg_user",
      sessionId: "ses_1",
      role: "user",
      content: "hello",
      createdAt: "2026-04-07T00:00:00.000Z"
    };
    const assistantToolCall = createAssistantMessage({
      id: "msg_tool_call",
      content: [
        {
          type: "tool-call",
          toolCallId: "tool_1",
          toolName: "AgentSwitch",
          input: { to: "plan" }
        }
      ],
      metadata: {
        agentName: "plan",
        effectiveAgentName: "plan",
        agentMode: "primary"
      },
      createdAt: "2026-04-07T00:00:02.000Z"
    });
    const toolResult: Message = {
      id: "msg_tool_result",
      sessionId: "ses_1",
      runId: "run_1",
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tool_1",
          toolName: "AgentSwitch",
          output: {
            type: "text",
            value: "switched"
          }
        }
      ],
      createdAt: "2026-04-07T00:00:03.000Z"
    };

    const viewModel = buildRuntimeViewModel({
      messages: [userMessage, assistantToolCall, toolResult],
      queuedMessageIds: new Set(),
      runSteps: [createModelCallStep()],
      deferredEvents: [
        createEvent({
          cursor: "1",
          runId: "run_1",
          event: "message.delta",
          data: {
            messageId: "msg_streamed",
            delta: "first part"
          }
        }),
        createEvent({
          cursor: "2",
          runId: "run_1",
          event: "message.completed",
          data: {
            messageId: "msg_tool_call",
            content: assistantToolCall.content
          }
        }),
        createEvent({
          cursor: "3",
          runId: "run_1",
          event: "message.completed",
          data: {
            messageId: "msg_tool_result",
            toolCallId: "tool_1",
            toolName: "AgentSwitch",
            content: toolResult.content
          }
        }),
        createEvent({
          cursor: "4",
          runId: "run_1",
          event: "message.delta",
          data: {
            messageId: "msg_streamed",
            delta: "second part"
          }
        })
      ],
      liveMessagesByKey: {
        "message:msg_streamed": {
          persistedMessageId: "msg_streamed",
          runId: "run_1",
          sessionId: "ses_1",
          content: "first partsecond part",
          metadata: {
            agentName: "plan",
            effectiveAgentName: "plan",
            agentMode: "primary"
          },
          createdAt: "2026-04-07T00:00:01.000Z"
        }
      },
      selectedTraceId: "",
      selectedMessageId: "",
      selectedStepId: "",
      selectedEventId: "",
      sessionId: "ses_1"
    });

    expect(viewModel.messageFeed.map((message) => message.id)).toEqual([
      "msg_user",
      "segment:msg_streamed:1",
      "msg_tool_call",
      "msg_tool_result",
      "segment:msg_streamed:2"
    ]);
    expect(viewModel.messageFeed.map((message) => message.content)).toEqual([
      "hello",
      "first part",
      assistantToolCall.content,
      toolResult.content,
      "second part"
    ]);
    expect(viewModel.messageFeed[4]).toMatchObject({
      metadata: {
        agentName: "plan",
        effectiveAgentName: "plan",
        agentMode: "primary"
      }
    });
  });

  it("keeps the completed assistant message when streamed output also includes reasoning", () => {
    const userMessage: Message = {
      id: "msg_user",
      sessionId: "ses_1",
      role: "user",
      content: "hello",
      createdAt: "2026-04-07T00:00:00.000Z"
    };
    const assistantMessage = createAssistantMessage({
      id: "msg_streamed",
      content: [
        {
          type: "reasoning",
          text: "thinking step"
        },
        {
          type: "text",
          text: "final answer"
        }
      ],
      createdAt: "2026-04-07T00:00:02.000Z"
    });

    const viewModel = buildRuntimeViewModel({
      messages: [userMessage, assistantMessage],
      queuedMessageIds: new Set(),
      runSteps: [createModelCallStep()],
      deferredEvents: [
        createEvent({
          cursor: "1",
          runId: "run_1",
          event: "message.delta",
          data: {
            messageId: "msg_streamed",
            delta: "final "
          }
        }),
        createEvent({
          cursor: "2",
          runId: "run_1",
          event: "message.delta",
          data: {
            messageId: "msg_streamed",
            delta: "answer"
          }
        }),
        createEvent({
          cursor: "3",
          runId: "run_1",
          event: "message.completed",
          data: {
            messageId: "msg_streamed",
            content: assistantMessage.content
          }
        })
      ],
      liveMessagesByKey: {},
      selectedTraceId: "",
      selectedMessageId: "",
      selectedStepId: "",
      selectedEventId: "",
      sessionId: "ses_1"
    });

    expect(viewModel.messageFeed.map((message) => message.id)).toEqual(["msg_user", "msg_streamed"]);
    expect(viewModel.messageFeed[1]?.content).toEqual(assistantMessage.content);
  });

  it("keeps queued user messages out of the main conversation feed until they leave the queue", () => {
    const queuedUserMessage: Message = {
      id: "msg_queued_user",
      sessionId: "ses_1",
      role: "user",
      content: "queued follow-up",
      createdAt: "2026-04-07T00:00:03.000Z"
    };

    const queuedViewModel = buildRuntimeViewModel({
      messages: [queuedUserMessage],
      queuedMessageIds: new Set([queuedUserMessage.id]),
      runSteps: [],
      deferredEvents: [],
      liveMessagesByKey: {},
      selectedTraceId: "",
      selectedMessageId: queuedUserMessage.id,
      selectedStepId: "",
      selectedEventId: "",
      sessionId: "ses_1"
    });

    expect(queuedViewModel.messageFeed).toEqual([]);
    expect(queuedViewModel.selectedSessionMessage).toBeNull();

    const activeViewModel = buildRuntimeViewModel({
      messages: [queuedUserMessage],
      queuedMessageIds: new Set(),
      runSteps: [],
      deferredEvents: [],
      liveMessagesByKey: {},
      selectedTraceId: "",
      selectedMessageId: queuedUserMessage.id,
      selectedStepId: "",
      selectedEventId: "",
      sessionId: "ses_1"
    });

    expect(activeViewModel.messageFeed.map((message) => message.id)).toEqual([queuedUserMessage.id]);
    expect(activeViewModel.selectedSessionMessage?.id).toBe(queuedUserMessage.id);
  });

  it("keeps an optimistic user message ahead of a live assistant reply", () => {
    const viewModel = buildRuntimeViewModel({
      messages: [],
      queuedMessageIds: new Set(),
      runSteps: [createModelCallStep()],
      deferredEvents: [],
      liveMessagesByKey: {
        "pending-user:msg_user_1": {
          persistedMessageId: "msg_user_1",
          runId: "",
          sessionId: "ses_1",
          role: "user",
          content: "hello there",
          createdAt: "2026-04-07T00:00:01.000Z"
        },
        "message:msg_assistant_1": {
          persistedMessageId: "msg_assistant_1",
          runId: "run_1",
          sessionId: "ses_1",
          role: "assistant",
          content: "hi back",
          createdAt: "2026-04-07T00:00:02.000Z"
        }
      },
      selectedTraceId: "",
      selectedMessageId: "",
      selectedStepId: "",
      selectedEventId: "",
      sessionId: "ses_1"
    });

    expect(viewModel.messageFeed.map((message) => `${message.role}:${message.id}`)).toEqual([
      "user:live:msg_user_1",
      "assistant:live:msg_assistant_1"
    ]);
  });
});
