import type { ChatMessage, Message } from "@oah/api-contracts";

import { normalizePersistedMessages } from "../persisted-history-normalization.js";
import {
  contentToPromptMessage,
  isMessageContentForRole,
  isMessageRole
} from "../runtime-message-content.js";
import type { MessageRepository, RuntimeLogger } from "../types.js";

interface SessionHistoryServiceDependencies {
  messageRepository: MessageRepository;
  logger?: RuntimeLogger | undefined;
}

function messagesEqual(left: Message, right: Message): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function messageToolCallIds(message: Message): string[] {
  if (!Array.isArray(message.content)) {
    return [];
  }

  return message.content.flatMap((part) => {
    if (part.type === "tool-call" || part.type === "tool-result") {
      return [part.toolCallId];
    }

    return [];
  });
}

function stringifyMessageDisplayValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function normalizePromptMessages(rawMessages: unknown): ChatMessage[] {
  if (!Array.isArray(rawMessages)) {
    return [];
  }

  return rawMessages.flatMap((message) => {
    if (
      typeof message === "object" &&
      message !== null &&
      isMessageRole((message as { role?: unknown }).role)
    ) {
      const role = (message as { role: Message["role"] }).role;
      const content = (message as { content?: unknown }).content;
      if (isMessageContentForRole(role, content)) {
        return [contentToPromptMessage(role, content)];
      }
    }

    return [];
  });
}

export function extractMessageDisplayText(message: Message): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  return message.content
    .flatMap((part) => {
      if (part.type === "text") {
        return [part.text];
      }

      if (part.type !== "tool-result") {
        return [];
      }

      switch (part.output.type) {
        case "text":
        case "error-text":
          return [part.output.value];
        case "json":
        case "error-json":
        case "content":
          return [stringifyMessageDisplayValue(part.output.value)];
        case "execution-denied":
          return [part.output.reason?.trim() ? part.output.reason : "Execution denied."];
      }
    })
    .join("\n\n");
}

export function hasMeaningfulText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export class SessionHistoryService {
  readonly #messageRepository: MessageRepository;
  readonly #logger?: RuntimeLogger | undefined;

  constructor(dependencies: SessionHistoryServiceDependencies) {
    this.#messageRepository = dependencies.messageRepository;
    this.#logger = dependencies.logger;
  }

  async repairSessionHistoryIfNeeded(sessionId: string, messages: Message[]): Promise<Message[]> {
    const normalized = normalizePersistedMessages(messages);
    if (!normalized.changed) {
      return messages;
    }

    const existingMessagesById = new Map(messages.map((message) => [message.id, message]));
    let createdCount = 0;
    let updatedCount = 0;
    const repairedToolCallIds: string[] = [];

    for (const normalizedMessage of normalized.messages) {
      const existingMessage = existingMessagesById.get(normalizedMessage.id);
      if (!existingMessage) {
        await this.#messageRepository.create(normalizedMessage);
        createdCount += 1;
        repairedToolCallIds.push(...messageToolCallIds(normalizedMessage));
        continue;
      }

      if (!messagesEqual(existingMessage, normalizedMessage)) {
        await this.#messageRepository.update(normalizedMessage);
        updatedCount += 1;
      }
    }

    this.#logger?.warn?.("Runtime auto-repaired persisted session history before model execution.", {
      sessionId,
      createdCount,
      updatedCount,
      repairedToolCallIds
    });

    return normalized.messages;
  }
}
