import type { CreateMessageRequest } from "@oah/api-contracts";

export interface DraftImageAttachment {
  id: string;
  name: string;
  mediaType: string;
  previewUrl: string;
  base64Data: string;
  size: number;
}

export function buildComposerMessageContent(
  text: string,
  attachments: DraftImageAttachment[]
): CreateMessageRequest["content"] | null {
  const trimmedText = text.trim();

  if (attachments.length === 0) {
    return trimmedText.length > 0 ? trimmedText : null;
  }

  const parts: Exclude<CreateMessageRequest["content"], string> = [];
  if (trimmedText.length > 0) {
    parts.push({
      type: "text",
      text: trimmedText
    });
  }

  for (const attachment of attachments) {
    parts.push({
      type: "image",
      image: attachment.base64Data,
      mediaType: attachment.mediaType
    });
  }

  return parts.length > 0 ? parts : null;
}

export function summarizeComposerMessageContent(content: CreateMessageRequest["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  const text = content
    .filter((part) => part.type === "text")
    .map((part) => part.text.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
  const imageCount = content.filter((part) => part.type === "image").length;
  const fileCount = content.filter((part) => part.type === "file").length;
  const attachmentSummary = [
    ...(imageCount > 0 ? [`${imageCount} image${imageCount === 1 ? "" : "s"}`] : []),
    ...(fileCount > 0 ? [`${fileCount} file${fileCount === 1 ? "" : "s"}`] : [])
  ].join(", ");

  if (text && attachmentSummary) {
    return `${text}\n\n${attachmentSummary}`;
  }

  return text || attachmentSummary;
}
