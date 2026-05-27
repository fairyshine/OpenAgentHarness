import { describe, expect, it } from "vitest";

import { serializeModelCallStepInput } from "../packages/engine-core/src/engine/model-call-serialization.ts";
import { normalizePersistedRunStep } from "../packages/engine-core/src/persisted-history-normalization.ts";

describe("model call serialization", () => {
  it("keeps small request snapshots intact", () => {
    const input = serializeModelCallStepInput(
      {
        model: "openai-default",
        canonicalModelRef: "platform/openai-default",
        messages: [{ role: "user", content: "hello" }]
      },
      undefined,
      [],
      []
    );

    expect(input).toMatchObject({
      request: {
        model: "openai-default",
        canonicalModelRef: "platform/openai-default",
        messages: [{ role: "user", content: "hello" }]
      },
      runtime: {
        messageCount: 1,
        maxRetries: 5
      }
    });
  });

  it("compacts oversized request snapshots instead of persisting full context repeatedly", () => {
    const messages = Array.from({ length: 24 }, (_, index) => ({
      role: index === 0 ? ("system" as const) : ("user" as const),
      content: `${index}:${"x".repeat(12000)}`
    }));

    const input = serializeModelCallStepInput(
      {
        model: "deepseek-v4",
        canonicalModelRef: "platform/deepseek-v4",
        messages
      },
      undefined,
      [],
      []
    );
    const request = input.request as Record<string, unknown>;

    expect(request.messagesCompacted).toMatchObject({
      originalCount: 24,
      retainedCount: 16
    });
    expect(JSON.stringify(request).length).toBeLessThan(90_000);
    expect(request.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "system", content: expect.stringContaining("[truncated") }),
        expect.objectContaining({ role: "user", content: expect.stringContaining("[truncated") })
      ])
    );
    expect(input.runtime).toMatchObject({
      messageCount: 24,
      maxRetries: 5
    });
  });

  it("compacts oversized legacy model_call steps during persisted history normalization", () => {
    const normalized = normalizePersistedRunStep({
      id: "step_big",
      runId: "run_big",
      seq: 1,
      stepType: "model_call",
      status: "completed",
      input: {
        request: {
          model: "deepseek-v4",
          canonicalModelRef: "platform/deepseek-v4",
          messages: Array.from({ length: 24 }, (_, index) => ({
            role: "user",
            content: `${index}:${"x".repeat(12000)}`
          }))
        },
        runtime: {
          messageCount: 24
        }
      }
    });

    expect(normalized.changed).toBe(true);
    expect(JSON.stringify(normalized.step.input).length).toBeLessThan(90_000);
    expect(normalized.step.input).toMatchObject({
      request: {
        messagesCompacted: {
          originalCount: 24,
          retainedCount: 16
        }
      },
      runtime: {
        messageCount: 24
      }
    });
  });
});
