import { describe, expect, it } from "vitest";

import { ModelMessageSerializer } from "../packages/engine-core/src/engine/ai-sdk-message-serializer";
import { EngineMessageProjector } from "../packages/engine-core/src/engine/message-projections";
import {
  buildSessionEngineMessages,
  type EngineMessage
} from "../packages/engine-core/src/engine/engine-messages";
import type { Message } from "@oah/api-contracts";
import type { SessionEvent } from "../packages/engine-core/src/types";

describe("runtime message projections", () => {
  it("builds segmented runtime messages from interrupted assistant output", () => {
    const messages: Message[] = [
      {
        id: "msg_user",
        sessionId: "sess_1",
        role: "user",
        content: "hello",
        createdAt: "2026-04-08T00:00:00.000Z"
      },
      {
        id: "msg_streamed",
        sessionId: "sess_1",
        runId: "run_1",
        role: "assistant",
        content: "first partsecond part",
        createdAt: "2026-04-08T00:00:01.000Z"
      },
      {
        id: "msg_tool_call",
        sessionId: "sess_1",
        runId: "run_1",
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tool_1",
            toolName: "AgentSwitch",
            input: {
              to: "plan"
            }
          }
        ],
        createdAt: "2026-04-08T00:00:02.000Z"
      },
      {
        id: "msg_tool_result",
        sessionId: "sess_1",
        runId: "run_1",
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tool_1",
            toolName: "AgentSwitch",
            output: {
              type: "text",
              value: "switched_to: plan"
            }
          }
        ],
        createdAt: "2026-04-08T00:00:03.000Z"
      }
    ];
    const events: SessionEvent[] = [
      {
        id: "evt_1",
        cursor: "1",
        sessionId: "sess_1",
        runId: "run_1",
        event: "message.delta",
        data: {
          messageId: "msg_streamed",
          delta: "first part"
        },
        createdAt: "2026-04-08T00:00:01.100Z"
      },
      {
        id: "evt_2",
        cursor: "2",
        sessionId: "sess_1",
        runId: "run_1",
        event: "message.completed",
        data: {
          messageId: "msg_tool_call",
          content: messages[2]!.content
        },
        createdAt: "2026-04-08T00:00:02.100Z"
      },
      {
        id: "evt_3",
        cursor: "3",
        sessionId: "sess_1",
        runId: "run_1",
        event: "message.completed",
        data: {
          messageId: "msg_tool_result",
          toolCallId: "tool_1",
          toolName: "AgentSwitch",
          content: messages[3]!.content
        },
        createdAt: "2026-04-08T00:00:03.100Z"
      },
      {
        id: "evt_4",
        cursor: "4",
        sessionId: "sess_1",
        runId: "run_1",
        event: "message.delta",
        data: {
          messageId: "msg_streamed",
          delta: "second part"
        },
        createdAt: "2026-04-08T00:00:04.100Z"
      },
      {
        id: "evt_5",
        cursor: "5",
        sessionId: "sess_1",
        runId: "run_1",
        event: "run.completed",
        data: {
          runId: "run_1",
          status: "completed"
        },
        createdAt: "2026-04-08T00:00:05.000Z"
      }
    ];

    const engineMessages = buildSessionEngineMessages({
      messages,
      events
    });

    expect(engineMessages.map((message) => message.id)).toEqual([
      "msg_user",
      "msg_streamed:segment:1",
      "msg_tool_call",
      "msg_tool_result",
      "msg_streamed:segment:2"
    ]);
    expect(engineMessages.map((message) => message.kind)).toEqual([
      "user_input",
      "assistant_text",
      "tool_call",
      "tool_result",
      "assistant_text"
    ]);
    expect(engineMessages.map((message) => message.content)).toEqual([
      "hello",
      "first part",
      messages[2]!.content,
      messages[3]!.content,
      "second part"
    ]);
  });

  it("replaces compacted tool results with a stub in model projection", () => {
    const projector = new EngineMessageProjector();
    const engineMessages: EngineMessage[] = [
      {
        id: "msg_1",
        sessionId: "sess_1",
        role: "user",
        kind: "user_input",
        content: "Inspect src/auth.ts",
        createdAt: "2026-04-08T00:00:00.000Z"
      },
      {
        id: "msg_2",
        sessionId: "sess_1",
        role: "tool",
        kind: "tool_result",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "Read",
            output: {
              type: "text",
              value: "very long file body"
            }
          }
        ],
        createdAt: "2026-04-08T00:00:01.000Z",
        metadata: {
          compactedAt: "2026-04-08T00:00:02.000Z"
        }
      }
    ];

    const result = projector.projectToModel(engineMessages, {
      sessionId: "sess_1",
      activeAgentName: "default"
    });

    expect(result.messages).toHaveLength(2);
    expect(result.diagnostics.truncatedMessageIds).toEqual(["msg_2"]);
    expect(result.messages[1]).toMatchObject({
      role: "tool",
      semanticType: "tool_result",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "Read",
          output: {
            type: "text",
            value: "[Old tool result content cleared]"
          }
        }
      ]
    });
  });

  it("applies the latest compact boundary when projecting model messages", () => {
    const projector = new EngineMessageProjector();
    const engineMessages: EngineMessage[] = [
      {
        id: "msg_old",
        sessionId: "sess_1",
        role: "user",
        kind: "user_input",
        content: "old request",
        createdAt: "2026-04-08T00:00:00.000Z"
      },
      {
        id: "boundary_1",
        sessionId: "sess_1",
        role: "system",
        kind: "compact_boundary",
        content: "Conversation compacted",
        createdAt: "2026-04-08T00:00:01.000Z"
      },
      {
        id: "summary_1",
        sessionId: "sess_1",
        role: "system",
        kind: "compact_summary",
        content: "Summary of previous work",
        createdAt: "2026-04-08T00:00:02.000Z"
      },
      {
        id: "msg_new",
        sessionId: "sess_1",
        role: "user",
        kind: "user_input",
        content: "continue from here",
        createdAt: "2026-04-08T00:00:03.000Z"
      }
    ];

    const result = projector.projectToModel(engineMessages, {
      sessionId: "sess_1",
      activeAgentName: "default"
    });

    expect(result.diagnostics.appliedCompactBoundaryId).toBe("boundary_1");
    expect(result.messages.map((message) => message.sourceMessageIds[0])).toEqual(["summary_1", "msg_new"]);
  });

  it("reconstructs summary plus recent messages when compact artifacts are appended at the end", () => {
    const projector = new EngineMessageProjector();
    const engineMessages: EngineMessage[] = [
      {
        id: "msg_old",
        sessionId: "sess_1",
        role: "user",
        kind: "user_input",
        content: "old request",
        createdAt: "2026-04-08T00:00:00.000Z"
      },
      {
        id: "msg_recent_user",
        sessionId: "sess_1",
        role: "user",
        kind: "user_input",
        content: "recent request",
        createdAt: "2026-04-08T00:00:01.000Z"
      },
      {
        id: "msg_recent_reply",
        sessionId: "sess_1",
        role: "assistant",
        kind: "assistant_text",
        content: "recent reply",
        createdAt: "2026-04-08T00:00:02.000Z",
        metadata: {
          modelCallStepSeq: 1
        }
      },
      {
        id: "boundary_2",
        sessionId: "sess_1",
        role: "system",
        kind: "compact_boundary",
        content: "Conversation compacted",
        createdAt: "2026-04-08T00:00:03.000Z",
        metadata: {
          extra: {
            compactThroughMessageId: "msg_old"
          }
        }
      },
      {
        id: "summary_2",
        sessionId: "sess_1",
        role: "system",
        kind: "compact_summary",
        content: "Summary of earlier work",
        createdAt: "2026-04-08T00:00:04.000Z",
        metadata: {
          summaryForBoundaryId: "boundary_2"
        }
      }
    ];

    const result = projector.projectToModel(engineMessages, {
      sessionId: "sess_1",
      activeAgentName: "default"
    });

    expect(result.diagnostics.appliedCompactBoundaryId).toBe("boundary_2");
    expect(result.messages.map((message) => message.sourceMessageIds[0])).toEqual([
      "summary_2",
      "msg_recent_user",
      "msg_recent_reply"
    ]);
  });

  it("hoists transient memory notes into the leading system context for model projection", () => {
    const projector = new EngineMessageProjector();
    const engineMessages: EngineMessage[] = [
      {
        id: "msg_system",
        sessionId: "sess_1",
        role: "system",
        kind: "system_note",
        content: "Base system guidance",
        createdAt: "2026-04-08T00:00:00.000Z"
      },
      {
        id: "msg_user",
        sessionId: "sess_1",
        role: "user",
        kind: "user_input",
        content: "How should I continue?",
        createdAt: "2026-04-08T00:00:01.000Z"
      },
      {
        id: "msg_memory",
        sessionId: "sess_1",
        role: "system",
        kind: "system_note",
        content: "<workspace_memory>durable guidance</workspace_memory>",
        createdAt: "2026-04-08T00:00:02.000Z",
        metadata: {
          synthetic: true,
          eligibleForModelContext: true,
          tags: ["workspace-memory"]
        }
      },
      {
        id: "msg_reply",
        sessionId: "sess_1",
        role: "assistant",
        kind: "assistant_text",
        content: "reply",
        createdAt: "2026-04-08T00:00:03.000Z"
      }
    ];

    const result = projector.projectToModel(engineMessages, {
      sessionId: "sess_1",
      activeAgentName: "default"
    });

    expect(result.messages.map((message) => message.sourceMessageIds[0])).toEqual([
      "msg_system",
      "msg_memory",
      "msg_user",
      "msg_reply"
    ]);
  });

  it("serializes model messages into AI SDK-compatible messages", () => {
    const serializer = new ModelMessageSerializer();

    const serialized = serializer.toAiSdkMessages([
      {
        view: "model",
        role: "system",
        semanticType: "system_note",
        sourceMessageIds: ["msg_1"],
        content: "Workspace root is /repo"
      },
      {
        view: "model",
        role: "tool",
        semanticType: "tool_result",
        sourceMessageIds: ["msg_2"],
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "Read",
            output: {
              type: "text",
              value: "[Old tool result content cleared]"
            }
          }
        ]
      }
    ]);

    expect(serialized).toEqual([
      {
        role: "system",
        content: "Workspace root is /repo"
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "Read",
            output: {
              type: "text",
              value: "[Old tool result content cleared]"
            }
          }
        ]
      }
    ]);
  });
});
