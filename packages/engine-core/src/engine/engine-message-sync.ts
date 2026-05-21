import type { Message } from "@oah/api-contracts";

import type { MessageRepository, EngineMessageRepository, SessionEventStore } from "../types.js";
import type { EngineMessage } from "./engine-messages.js";
import { buildSessionEngineMessages } from "./engine-messages.js";

export interface EngineMessageSyncServiceDependencies {
  messageRepository: MessageRepository;
  sessionEventStore: SessionEventStore;
  engineMessageRepository?: EngineMessageRepository | undefined;
}

export class EngineMessageSyncService {
  readonly #messageRepository: MessageRepository;
  readonly #sessionEventStore: SessionEventStore;
  readonly #engineMessageRepository: EngineMessageRepository | undefined;
  readonly #engineMessageSyncChains = new Map<string, Promise<void>>();

  constructor(dependencies: EngineMessageSyncServiceDependencies) {
    this.#messageRepository = dependencies.messageRepository;
    this.#sessionEventStore = dependencies.sessionEventStore;
    this.#engineMessageRepository = dependencies.engineMessageRepository;
  }

  async scheduleEngineMessageSync(sessionId: string): Promise<void> {
    if (!this.#engineMessageRepository) {
      return;
    }

    const previous = this.#engineMessageSyncChains.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const [messages, events, storedEngineMessages] = await Promise.all([
          this.#messageRepository.listBySessionId(sessionId),
          this.#sessionEventStore.listSince(sessionId),
          this.#engineMessageRepository?.listBySessionId(sessionId) ?? Promise.resolve([])
        ]);
        const engineMessages = buildSessionEngineMessages({
          messages,
          events
        });
        if (this.#engineMessagesEqual(storedEngineMessages, engineMessages)) {
          return;
        }

        await this.#engineMessageRepository?.replaceBySessionId(sessionId, engineMessages);
      })
      .finally(() => {
        if (this.#engineMessageSyncChains.get(sessionId) === next) {
          this.#engineMessageSyncChains.delete(sessionId);
        }
      });

    this.#engineMessageSyncChains.set(sessionId, next);
    await next;
  }

  async loadSessionEngineMessages(sessionId: string, persistedMessages?: Message[]): Promise<EngineMessage[]> {
    if (persistedMessages) {
      return this.buildEngineMessagesForSession(sessionId, persistedMessages);
    }

    if (this.#engineMessageRepository) {
      const storedEngineMessages = await this.#engineMessageRepository.listBySessionId(sessionId);
      if (storedEngineMessages.length > 0) {
        return storedEngineMessages;
      }
    }

    const engineMessages = await this.buildEngineMessagesForSession(sessionId);
    if (this.#engineMessageRepository && engineMessages.length > 0) {
      await this.#engineMessageRepository.replaceBySessionId(sessionId, engineMessages);
    }
    return engineMessages;
  }

  async buildEngineMessagesForSession(sessionId: string, persistedMessages?: Message[]): Promise<EngineMessage[]> {
    const [messages, events] = await Promise.all([
      persistedMessages ? Promise.resolve(persistedMessages) : this.#messageRepository.listBySessionId(sessionId),
      this.#sessionEventStore.listSince(sessionId)
    ]);

    return buildSessionEngineMessages({
      messages,
      events
    });
  }

  #engineMessagesEqual(left: EngineMessage[], right: EngineMessage[]): boolean {
    if (left.length !== right.length) {
      return false;
    }

    return left.every((message, index) => {
      const candidate = right[index];
      if (!candidate) {
        return false;
      }

      return (
        message.id === candidate.id &&
        message.sessionId === candidate.sessionId &&
        message.runId === candidate.runId &&
        message.role === candidate.role &&
        message.kind === candidate.kind &&
        message.createdAt === candidate.createdAt &&
        JSON.stringify(message.content) === JSON.stringify(candidate.content) &&
        JSON.stringify(message.metadata ?? null) === JSON.stringify(candidate.metadata ?? null)
      );
    });
  }
}
