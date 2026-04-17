import type { Message } from "@oah/api-contracts";

import type { MessageRepository, RuntimeMessageRepository, SessionEventStore } from "../types.js";
import type { RuntimeMessage } from "./runtime-messages.js";
import { buildSessionRuntimeMessages } from "./runtime-messages.js";

export interface RuntimeMessageSyncServiceDependencies {
  messageRepository: MessageRepository;
  sessionEventStore: SessionEventStore;
  runtimeMessageRepository?: RuntimeMessageRepository | undefined;
}

export class RuntimeMessageSyncService {
  readonly #messageRepository: MessageRepository;
  readonly #sessionEventStore: SessionEventStore;
  readonly #runtimeMessageRepository: RuntimeMessageRepository | undefined;
  readonly #runtimeMessageSyncChains = new Map<string, Promise<void>>();

  constructor(dependencies: RuntimeMessageSyncServiceDependencies) {
    this.#messageRepository = dependencies.messageRepository;
    this.#sessionEventStore = dependencies.sessionEventStore;
    this.#runtimeMessageRepository = dependencies.runtimeMessageRepository;
  }

  async scheduleRuntimeMessageSync(sessionId: string): Promise<void> {
    if (!this.#runtimeMessageRepository) {
      return;
    }

    const previous = this.#runtimeMessageSyncChains.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const [messages, events, storedRuntimeMessages] = await Promise.all([
          this.#messageRepository.listBySessionId(sessionId),
          this.#sessionEventStore.listSince(sessionId),
          this.#runtimeMessageRepository?.listBySessionId(sessionId) ?? Promise.resolve([])
        ]);
        const runtimeMessages = buildSessionRuntimeMessages({
          messages,
          events
        });
        if (this.#runtimeMessagesEqual(storedRuntimeMessages, runtimeMessages)) {
          return;
        }

        await this.#runtimeMessageRepository?.replaceBySessionId(sessionId, runtimeMessages);
      })
      .finally(() => {
        if (this.#runtimeMessageSyncChains.get(sessionId) === next) {
          this.#runtimeMessageSyncChains.delete(sessionId);
        }
      });

    this.#runtimeMessageSyncChains.set(sessionId, next);
    await next;
  }

  async loadSessionRuntimeMessages(sessionId: string, persistedMessages?: Message[]): Promise<RuntimeMessage[]> {
    if (persistedMessages) {
      return this.buildRuntimeMessagesForSession(sessionId, persistedMessages);
    }

    if (this.#runtimeMessageRepository) {
      const storedRuntimeMessages = await this.#runtimeMessageRepository.listBySessionId(sessionId);
      if (storedRuntimeMessages.length > 0) {
        return storedRuntimeMessages;
      }
    }

    return this.buildRuntimeMessagesForSession(sessionId);
  }

  async buildRuntimeMessagesForSession(sessionId: string, persistedMessages?: Message[]): Promise<RuntimeMessage[]> {
    const [messages, events] = await Promise.all([
      persistedMessages ? Promise.resolve(persistedMessages) : this.#messageRepository.listBySessionId(sessionId),
      this.#sessionEventStore.listSince(sessionId)
    ]);

    return buildSessionRuntimeMessages({
      messages,
      events
    });
  }

  #runtimeMessagesEqual(left: RuntimeMessage[], right: RuntimeMessage[]): boolean {
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
