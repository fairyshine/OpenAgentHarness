import type { Message, Run, Session } from "@oah/api-contracts";

import type { WorkspaceRecord } from "../types.js";
import type { EngineMessage } from "./engine-messages.js";

export interface ContextPreparationModuleInput {
  workspace: WorkspaceRecord;
  session: Session;
  run: Run;
  activeAgentName: string;
  messages: Message[];
  engineMessages: EngineMessage[];
  abortSignal?: AbortSignal | undefined;
  modelTimeoutMs?: number | undefined;
}

export interface ContextPreparationModule {
  readonly name: string;
  isEnabled(workspace: WorkspaceRecord): boolean;
  prepareMessagesForModelInput(input: ContextPreparationModuleInput): Promise<EngineMessage[]>;
}

export interface ContextPreparationPipelineDependencies {
  buildEngineMessagesForSession: (sessionId: string, persistedMessages?: Message[]) => Promise<EngineMessage[]>;
  modules?: ContextPreparationModule[] | undefined;
}

export class ContextPreparationPipeline {
  readonly #buildEngineMessagesForSession: ContextPreparationPipelineDependencies["buildEngineMessagesForSession"];
  readonly #modules: ContextPreparationModule[];

  constructor(dependencies: ContextPreparationPipelineDependencies) {
    this.#buildEngineMessagesForSession = dependencies.buildEngineMessagesForSession;
    this.#modules = dependencies.modules ?? [];
  }

  async prepareMessagesForModelInput(input: {
    workspace: WorkspaceRecord;
    session: Session;
    run: Run;
    activeAgentName: string;
    messages: Message[];
    abortSignal?: AbortSignal | undefined;
    modelTimeoutMs?: number | undefined;
  }): Promise<EngineMessage[]> {
    let engineMessages = await this.#buildEngineMessagesForSession(input.session.id, input.messages);

    for (const module of this.#modules) {
      if (!module.isEnabled(input.workspace)) {
        continue;
      }

      engineMessages = await module.prepareMessagesForModelInput({
        ...input,
        engineMessages
      });
    }

    return engineMessages;
  }
}
