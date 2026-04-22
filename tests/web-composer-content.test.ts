import { describe, expect, it } from "vitest";

import {
  buildComposerMessageContent,
  summarizeComposerMessageContent,
  type DraftImageAttachment
} from "../apps/web/src/app/chat/composer-content";

function buildAttachment(overrides?: Partial<DraftImageAttachment>): DraftImageAttachment {
  return {
    id: "att-1",
    name: "photo.png",
    mediaType: "image/png",
    previewUrl: "data:image/png;base64,AAAA",
    base64Data: "AAAA",
    size: 4,
    ...overrides
  };
}

describe("web composer content helpers", () => {
  it("keeps pure text messages as strings", () => {
    expect(buildComposerMessageContent("  hello world  ", [])).toBe("hello world");
  });

  it("builds multimodal content when images are attached", () => {
    expect(buildComposerMessageContent("  describe this  ", [buildAttachment()])).toEqual([
      {
        type: "text",
        text: "describe this"
      },
      {
        type: "image",
        image: "AAAA",
        mediaType: "image/png"
      }
    ]);
  });

  it("supports image-only submissions and generates readable summaries", () => {
    const content = buildComposerMessageContent("", [buildAttachment(), buildAttachment({ id: "att-2" })]);
    expect(content).toEqual([
      {
        type: "image",
        image: "AAAA",
        mediaType: "image/png"
      },
      {
        type: "image",
        image: "AAAA",
        mediaType: "image/png"
      }
    ]);
    expect(summarizeComposerMessageContent(content!)).toBe("2 images");
  });
});
