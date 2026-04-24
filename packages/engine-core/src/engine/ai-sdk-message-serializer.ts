import path from "node:path";
import type { ChatMessage, Message } from "@oah/api-contracts";

import { contentToPromptMessage, extractTextFromContent, isMessageContentForRole } from "../execution-message-content.js";
import type { WorkspaceFileSystem, WorkspaceRecord } from "../types.js";
import { WorkspaceFileService } from "../workspace/workspace-files.js";
import type { ModelMessage } from "./message-projections.js";

const MAX_INLINE_WORKSPACE_ATTACHMENTS_PER_MESSAGE = 4;
const MAX_INLINE_WORKSPACE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const IMAGE_FILE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".tif",
  ".tiff",
  ".avif",
  ".heic",
  ".heif"
]);
const TRAILING_PATH_PUNCTUATION = /[)\]}>.,!?;:，。！？；：、）》】]+$/u;
const WORKSPACE_IMPLICIT_ATTACHMENT_PATH_PATTERNS = [
  /!\[[^\]]*\]\((<[^>\n]+>|[^)\n]+)\)/gimu,
  /`([^`\n]+\.[A-Za-z0-9]+)`/gimu,
  /"([^"\n]+\.[A-Za-z0-9]+)"/gimu,
  /'([^'\n]+\.[A-Za-z0-9]+)'/gimu,
  /((?:\.{1,2}\/|\/)?(?:[^\s"'`()\[\]{}<>]+\/)*[^\s"'`()\[\]{}<>]+\.[A-Za-z0-9]+)/gimu
] as const;
const WORKSPACE_EXPLICIT_ATTACHMENT_REFERENCE_PATTERN =
  /(^|[\s([{<"'“‘])@((?:[^@\n])+?\.[A-Za-z0-9]+)/gmu;
const WRAPPER_PAIRS = [
  ["<", ">"],
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["“", "”"],
  ["‘", "’"]
] as const;

type UserMessageContent = Extract<Message, { role: "user" }>["content"];
type UserMessagePart = Extract<UserMessageContent, unknown[]>[number];
type FileMessagePart = Extract<UserMessagePart, { type: "file" }>;
type ImageMessagePart = Extract<UserMessagePart, { type: "image" }>;
type WorkspaceAttachmentPart = ImageMessagePart | FileMessagePart;
type WorkspaceAttachmentCandidate = {
  path: string;
  explicitAttachment: boolean;
};

function isUserTextPart(part: UserMessagePart): part is Extract<UserMessagePart, { type: "text" }> {
  return part.type === "text";
}

function stripWrapper(value: string): string {
  const trimmed = value.trim();
  for (const [start, end] of WRAPPER_PAIRS) {
    if (trimmed.startsWith(start) && trimmed.endsWith(end) && trimmed.length >= start.length + end.length) {
      return trimmed.slice(start.length, trimmed.length - end.length).trim();
    }
  }

  return trimmed;
}

function hasImageFileExtension(value: string): boolean {
  const withoutQuery = value.split(/[?#]/u, 1)[0] ?? value;
  return IMAGE_FILE_EXTENSIONS.has(path.extname(withoutQuery).toLowerCase());
}

function hasFileExtension(value: string): boolean {
  const withoutQuery = value.split(/[?#]/u, 1)[0] ?? value;
  return path.extname(withoutQuery).length > 0;
}

function normalizeWorkspaceAttachmentCandidate(value: string): string | null {
  let candidate = stripWrapper(value);
  candidate = candidate.replace(TRAILING_PATH_PUNCTUATION, "").trim();
  if (!candidate || candidate.startsWith("data:") || /^[a-z][a-z0-9+.-]*:\/\//iu.test(candidate)) {
    return null;
  }

  return hasFileExtension(candidate) ? candidate : null;
}

function toWorkspaceAttachmentCandidate(candidate: string): WorkspaceAttachmentCandidate | null {
  if (!candidate.startsWith("@") || candidate.length <= 1) {
    return {
      path: candidate,
      explicitAttachment: false
    };
  }

  const strippedCandidate = candidate.slice(1).trim();
  if (!strippedCandidate || !hasFileExtension(strippedCandidate)) {
    return null;
  }

  return {
    path: strippedCandidate,
    explicitAttachment: true
  };
}

function collectWorkspaceAttachmentCandidates(text: string): WorkspaceAttachmentCandidate[] {
  const orderedCandidates: WorkspaceAttachmentCandidate[] = [];
  const seenCandidates = new Set<string>();

  for (const match of text.matchAll(WORKSPACE_EXPLICIT_ATTACHMENT_REFERENCE_PATTERN)) {
    const normalized = normalizeWorkspaceAttachmentCandidate(match[2] ?? "");
    const candidate = normalized ? toWorkspaceAttachmentCandidate(`@${normalized}`) : null;
    const dedupeKey = candidate ? `${candidate.explicitAttachment ? "explicit" : "implicit"}:${candidate.path}` : null;
    if (!candidate || !dedupeKey || seenCandidates.has(dedupeKey)) {
      continue;
    }

    seenCandidates.add(dedupeKey);
    orderedCandidates.push(candidate);
  }

  for (const pattern of WORKSPACE_IMPLICIT_ATTACHMENT_PATH_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const capturedValue =
        match.slice(1).find((value): value is string => typeof value === "string" && value.trim().length > 0) ??
        match[0];
      const normalized = normalizeWorkspaceAttachmentCandidate(capturedValue);
      const candidate = normalized ? toWorkspaceAttachmentCandidate(normalized) : null;
      const dedupeKey = candidate ? `${candidate.explicitAttachment ? "explicit" : "implicit"}:${candidate.path}` : null;
      if (!candidate || !dedupeKey || seenCandidates.has(dedupeKey)) {
        continue;
      }

      seenCandidates.add(dedupeKey);
      orderedCandidates.push(candidate);
    }
  }

  return orderedCandidates;
}

export class ModelMessageSerializer {
  readonly #workspaceFiles: WorkspaceFileService | undefined;

  constructor(dependencies?: { workspaceFileSystem?: WorkspaceFileSystem | undefined }) {
    this.#workspaceFiles = dependencies?.workspaceFileSystem
      ? new WorkspaceFileService(dependencies.workspaceFileSystem)
      : undefined;
  }

  async toAiSdkMessages(
    messages: ModelMessage[],
    options?: { workspace?: WorkspaceRecord | undefined }
  ): Promise<ChatMessage[]> {
    return Promise.all(messages.map((message) => this.#toAiSdkMessage(message, options?.workspace)));
  }

  async #toAiSdkMessage(message: ModelMessage, workspace?: WorkspaceRecord): Promise<ChatMessage> {
    if (message.role === "system" && typeof message.content !== "string") {
      return {
        role: "system",
        content: extractTextFromContent(message.content)
      };
    }

    if (message.role !== "user") {
      return contentToPromptMessage(message.role, message.content);
    }

    const userContent = isMessageContentForRole("user", message.content)
      ? message.content
      : extractTextFromContent(message.content);
    const enrichedContent = await this.#enrichUserContentWithWorkspaceFiles(workspace, userContent);
    return contentToPromptMessage("user", enrichedContent);
  }

  async #enrichUserContentWithWorkspaceFiles(
    workspace: WorkspaceRecord | undefined,
    content: UserMessageContent
  ): Promise<UserMessageContent> {
    if (!workspace || !this.#workspaceFiles) {
      return content;
    }

    const textParts =
      typeof content === "string"
        ? [content]
        : content.filter(isUserTextPart).map((part) => part.text).filter((part) => part.trim().length > 0);
    if (textParts.length === 0) {
      return content;
    }

    const candidates = textParts.flatMap((text) => collectWorkspaceAttachmentCandidates(text));
    if (candidates.length === 0) {
      return content;
    }

    const attachmentParts = await this.#loadWorkspaceAttachmentParts(workspace, candidates);
    if (attachmentParts.length === 0) {
      return content;
    }

    if (typeof content === "string") {
      return [
        {
          type: "text",
          text: content
        },
        ...attachmentParts
      ];
    }

    return [...content, ...attachmentParts];
  }

  async #loadWorkspaceAttachmentParts(
    workspace: WorkspaceRecord,
    candidates: WorkspaceAttachmentCandidate[]
  ): Promise<WorkspaceAttachmentPart[]> {
    if (!this.#workspaceFiles) {
      return [];
    }

    const attachmentParts: WorkspaceAttachmentPart[] = [];
    const seenWorkspacePaths = new Set<string>();

    for (const candidate of candidates) {
      if (attachmentParts.length >= MAX_INLINE_WORKSPACE_ATTACHMENTS_PER_MESSAGE) {
        break;
      }

      try {
        const file = await this.#workspaceFiles.getFileDownload(workspace, candidate.path);
        if (file.sizeBytes > MAX_INLINE_WORKSPACE_ATTACHMENT_BYTES || seenWorkspacePaths.has(file.path)) {
          continue;
        }

        const isImage = file.mimeType?.startsWith("image/") ?? hasImageFileExtension(file.path);
        if (!isImage && !candidate.explicitAttachment) {
          continue;
        }

        const content = await this.#workspaceFiles.getFileContent(workspace, {
          path: file.path,
          encoding: "base64"
        });
        if (content.truncated) {
          continue;
        }

        seenWorkspacePaths.add(file.path);
        if (isImage) {
          attachmentParts.push({
            type: "image",
            image: content.content,
            ...(typeof content.mimeType === "string" ? { mediaType: content.mimeType } : {})
          });
          continue;
        }

        attachmentParts.push({
          type: "file",
          data: content.content,
          filename: file.name,
          mediaType:
            typeof content.mimeType === "string" && content.mimeType.trim().length > 0
              ? content.mimeType
              : (typeof file.mimeType === "string" && file.mimeType.trim().length > 0
                  ? file.mimeType
                  : "application/octet-stream")
        });
      } catch {
        continue;
      }
    }

    return attachmentParts;
  }
}
