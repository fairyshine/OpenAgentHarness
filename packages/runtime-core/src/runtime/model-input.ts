import type { ChatMessage, Run, Session } from "@oah/api-contracts";

import { buildAvailableAgentSwitchesMessage, buildAvailableSubagentsMessage } from "../agent-control.js";
import { buildAvailableActionsMessage } from "../action-dispatch.js";
import { AppError } from "../errors.js";
import { buildAvailableSkillsMessage } from "../skill-activation.js";
import {
  buildEnvironmentMessage as composeEnvironmentMessage,
  canDelegateFromAgent,
  visibleLlmActions,
  visibleLlmSkills
} from "../runtime-tooling.js";
import type { ModelDefinition, WorkspaceRecord } from "../types.js";
import { ModelMessageSerializer } from "./ai-sdk-message-serializer.js";
import { RuntimeMessageProjector } from "./message-projections.js";
import type { RuntimeMessage } from "./runtime-messages.js";

export interface ResolvedRunModel {
  model: string;
  canonicalModelRef: string;
  provider?: string | undefined;
  modelDefinition?: ModelDefinition | undefined;
}

export interface ModelExecutionInput {
  model: string;
  canonicalModelRef: string;
  provider?: string | undefined;
  modelDefinition?: ModelDefinition | undefined;
  temperature?: number | undefined;
  topP?: number | undefined;
  maxTokens?: number | undefined;
  messages: ChatMessage[];
}

export interface ModelInputServiceDependencies {
  defaultModel: string;
  platformModels: Record<string, ModelDefinition>;
  applyContextHooks: (
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    eventName: "before_context_build" | "after_context_build",
    messages: ChatMessage[]
  ) => Promise<ChatMessage[]>;
  collapseLeadingSystemMessages: (messages: ChatMessage[]) => ChatMessage[];
}

export class ModelInputService {
  readonly #defaultModel: string;
  readonly #platformModels: Record<string, ModelDefinition>;
  readonly #applyContextHooks: ModelInputServiceDependencies["applyContextHooks"];
  readonly #collapseLeadingSystemMessages: ModelInputServiceDependencies["collapseLeadingSystemMessages"];
  readonly #runtimeMessageProjector: RuntimeMessageProjector;
  readonly #modelMessageSerializer: ModelMessageSerializer;

  constructor(dependencies: ModelInputServiceDependencies) {
    this.#defaultModel = dependencies.defaultModel;
    this.#platformModels = dependencies.platformModels;
    this.#applyContextHooks = dependencies.applyContextHooks;
    this.#collapseLeadingSystemMessages = dependencies.collapseLeadingSystemMessages;
    this.#runtimeMessageProjector = new RuntimeMessageProjector();
    this.#modelMessageSerializer = new ModelMessageSerializer();
  }

  async buildModelInput(
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    runtimeMessages: RuntimeMessage[],
    activeAgentName: string,
    forceSystemReminder = false
  ): Promise<ModelExecutionInput> {
    const activeAgent = workspace.agents[activeAgentName];
    const inheritedModelRef =
      typeof run.metadata?.inheritedModelRef === "string" ? run.metadata.inheritedModelRef : undefined;
    const resolvedModel = this.resolveModelForRun(
      workspace,
      session.modelRef ?? activeAgent?.modelRef ?? inheritedModelRef
    );
    const modelProjection = this.#runtimeMessageProjector.projectToModel(runtimeMessages, {
      sessionId: session.id,
      activeAgentName,
      ...(session.modelRef ? { modelRef: session.modelRef } : {}),
      ...(resolvedModel.provider ? { provider: resolvedModel.provider } : {}),
      includeReasoning: true,
      includeToolResults: true,
      applyCompactBoundary: true
    });
    let contextMessages = await this.#applyContextHooks(
      workspace,
      session,
      run,
      "before_context_build",
      this.#modelMessageSerializer.toAiSdkMessages(modelProjection.messages)
    );
    const promptMessages: Array<{ role: "system"; content: string }> = this.#buildStaticPromptMessages(
      workspace,
      activeAgentName,
      resolvedModel
    );

    if (
      activeAgent?.systemReminder &&
      this.#shouldInjectSystemReminder(runtimeMessages, activeAgentName, forceSystemReminder)
    ) {
      contextMessages = this.#withInjectedSystemReminder(contextMessages, activeAgent.systemReminder);
    }

    contextMessages = await this.#applyContextHooks(workspace, session, run, "after_context_build", [
      ...promptMessages,
      ...contextMessages
    ]);

    return {
      model: resolvedModel.model,
      canonicalModelRef: resolvedModel.canonicalModelRef,
      ...(resolvedModel.provider ? { provider: resolvedModel.provider } : {}),
      ...(resolvedModel.modelDefinition ? { modelDefinition: resolvedModel.modelDefinition } : {}),
      ...(activeAgent?.temperature !== undefined ? { temperature: activeAgent.temperature } : {}),
      ...(activeAgent?.topP !== undefined ? { topP: activeAgent.topP } : {}),
      ...(activeAgent?.maxTokens !== undefined ? { maxTokens: activeAgent.maxTokens } : {}),
      messages: this.#collapseLeadingSystemMessages(contextMessages)
    };
  }

  resolveModelForRun(workspace: WorkspaceRecord, modelRef?: string | undefined): ResolvedRunModel {
    if (!modelRef || modelRef.length === 0) {
      const defaultPlatformModel = this.#platformModels[this.#defaultModel];
      return {
        model: this.#defaultModel,
        canonicalModelRef: `platform/${this.#defaultModel}`,
        ...(defaultPlatformModel ? { provider: defaultPlatformModel.provider, modelDefinition: defaultPlatformModel } : {})
      };
    }

    if (modelRef.startsWith("platform/")) {
      const platformModelName = modelRef.slice("platform/".length);
      const platformModel = this.#platformModels[platformModelName];
      return {
        model: platformModelName,
        canonicalModelRef: modelRef,
        ...(platformModel ? { provider: platformModel.provider, modelDefinition: platformModel } : {})
      };
    }

    if (modelRef.startsWith("workspace/")) {
      const workspaceModelName = modelRef.slice("workspace/".length);
      const workspaceModel = workspace.workspaceModels[workspaceModelName];
      if (!workspaceModel) {
        throw new AppError(
          404,
          "model_not_found",
          `Workspace model ${workspaceModelName} was not found in workspace ${workspace.id}.`
        );
      }

      return {
        model: modelRef,
        canonicalModelRef: modelRef,
        provider: workspaceModel.provider,
        modelDefinition: workspaceModel
      };
    }

    if (workspace.workspaceModels[modelRef]) {
      return {
        model: `workspace/${modelRef}`,
        canonicalModelRef: `workspace/${modelRef}`,
        provider: workspace.workspaceModels[modelRef].provider,
        modelDefinition: workspace.workspaceModels[modelRef]
      };
    }

    if (this.#platformModels[modelRef]) {
      return {
        model: modelRef,
        canonicalModelRef: `platform/${modelRef}`,
        provider: this.#platformModels[modelRef].provider,
        modelDefinition: this.#platformModels[modelRef]
      };
    }

    return {
      model: modelRef,
      canonicalModelRef: modelRef
    };
  }

  normalizeSessionModelRef(workspace: WorkspaceRecord, modelRef?: string): string | undefined {
    const candidate = modelRef?.trim();
    if (!candidate) {
      return undefined;
    }

    if (candidate.startsWith("platform/")) {
      const platformModelName = candidate.slice("platform/".length);
      if (!this.#platformModels[platformModelName]) {
        throw new AppError(404, "model_not_found", `Platform model ${platformModelName} was not found.`);
      }

      return candidate;
    }

    if (candidate.startsWith("workspace/")) {
      const workspaceModelName = candidate.slice("workspace/".length);
      if (!workspace.workspaceModels[workspaceModelName]) {
        throw new AppError(
          404,
          "model_not_found",
          `Workspace model ${workspaceModelName} was not found in workspace ${workspace.id}.`
        );
      }

      return candidate;
    }

    if (workspace.workspaceModels[candidate]) {
      return `workspace/${candidate}`;
    }

    if (this.#platformModels[candidate]) {
      return `platform/${candidate}`;
    }

    throw new AppError(404, "model_not_found", `Model ${candidate} was not found in workspace ${workspace.id}.`);
  }

  #latestMessageAgentName(messages: RuntimeMessage[]): string | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || message.role === "system") {
        continue;
      }

      if (index === messages.length - 1 && message.role === "user") {
        continue;
      }

      const metadata =
        typeof message.metadata === "object" && message.metadata !== null && !Array.isArray(message.metadata)
          ? message.metadata
          : undefined;
      if (typeof metadata?.effectiveAgentName === "string" && metadata.effectiveAgentName.length > 0) {
        return metadata.effectiveAgentName;
      }

      if (typeof metadata?.agentName === "string" && metadata.agentName.length > 0) {
        return metadata.agentName;
      }
    }

    return undefined;
  }

  #shouldInjectSystemReminder(messages: RuntimeMessage[], activeAgentName: string, forceSystemReminder = false): boolean {
    if (forceSystemReminder) {
      return true;
    }

    const latestAgentName = this.#latestMessageAgentName(messages);
    return latestAgentName !== undefined && latestAgentName !== activeAgentName;
  }

  #withInjectedSystemReminder(messages: ChatMessage[], reminder: string): ChatMessage[] {
    let lastUserMessageIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "user") {
        lastUserMessageIndex = index;
        break;
      }
    }

    if (lastUserMessageIndex === -1) {
      return messages;
    }

    const userMessage = messages[lastUserMessageIndex];
    if (!userMessage || userMessage.role !== "user") {
      return messages;
    }

    const reminderBlock = this.#formatSystemReminder(reminder);
    const updatedMessages = [...messages];
    updatedMessages[lastUserMessageIndex] = {
      ...userMessage,
      content:
        typeof userMessage.content === "string"
          ? userMessage.content.trim().length > 0
            ? `${reminderBlock}\n\n${userMessage.content}`
            : reminderBlock
          : [{ type: "text", text: reminderBlock }, ...userMessage.content]
    };

    return updatedMessages;
  }

  #formatSystemReminder(reminder: string): string {
    return `<system_reminder>\n${reminder}\n</system_reminder>`;
  }

  #buildStaticPromptMessages(
    workspace: WorkspaceRecord,
    activeAgentName: string,
    resolvedModel: ResolvedRunModel
  ): Array<{ role: "system"; content: string }> {
    const activeAgent = workspace.agents[activeAgentName];
    const systemPromptSettings = workspace.settings.systemPrompt;
    const compose = systemPromptSettings?.compose ?? {
      order: [
        "base",
        "llm_optimized",
        "agent",
        "actions",
        "project_agents_md",
        "skills",
        "agent_switches",
        "subagents",
        "environment"
      ] as const,
      includeEnvironment: false
    };
    const visibleActions = activeAgent ? visibleLlmActions(workspace, activeAgentName) : [];
    const visibleSkills = activeAgent ? visibleLlmSkills(workspace, activeAgentName) : [];
    const agentSwitchMessage = this.#buildAgentSwitchMessage(workspace, activeAgentName);
    const availableSubagentsMessage = this.#buildAvailableSubagentsMessage(workspace, activeAgentName);
    const environmentMessage =
      compose.includeEnvironment && workspace.kind === "project"
        ? composeEnvironmentMessage(workspace, activeAgentName)
        : undefined;
    const orderedMessages: Array<{ role: "system"; content: string }> = [];

    for (const segment of compose.order) {
      switch (segment) {
        case "base":
          if (systemPromptSettings?.base?.content) {
            orderedMessages.push({
              role: "system",
              content: systemPromptSettings.base.content
            });
          }
          break;
        case "llm_optimized": {
          const optimizedPrompt = this.#resolveLlmOptimizedPrompt(workspace, resolvedModel);
          if (optimizedPrompt) {
            orderedMessages.push({
              role: "system",
              content: optimizedPrompt
            });
          }
          break;
        }
        case "agent":
          if (activeAgent) {
            orderedMessages.push({
              role: "system",
              content: activeAgent.prompt
            });
          }
          break;
        case "actions":
          if (visibleActions.length > 0) {
            orderedMessages.push({
              role: "system",
              content: buildAvailableActionsMessage(visibleActions)
            });
          }
          break;
        case "project_agents_md":
          if (workspace.projectAgentsMd) {
            orderedMessages.push({
              role: "system",
              content: workspace.projectAgentsMd
            });
          }
          break;
        case "skills":
          if (visibleSkills.length > 0) {
            orderedMessages.push({
              role: "system",
              content: buildAvailableSkillsMessage(visibleSkills)
            });
          }
          break;
        case "agent_switches":
          if (agentSwitchMessage) {
            orderedMessages.push({
              role: "system",
              content: agentSwitchMessage
            });
          }
          break;
        case "subagents":
          if (availableSubagentsMessage) {
            orderedMessages.push({
              role: "system",
              content: availableSubagentsMessage
            });
          }
          break;
        case "environment":
          if (environmentMessage) {
            orderedMessages.push({
              role: "system",
              content: environmentMessage
            });
          }
          break;
      }
    }

    return orderedMessages;
  }

  #resolveLlmOptimizedPrompt(workspace: WorkspaceRecord, resolvedModel: ResolvedRunModel): string | undefined {
    const llmOptimized = workspace.settings.systemPrompt?.llmOptimized;
    if (!llmOptimized) {
      return undefined;
    }

    return (
      llmOptimized.models?.[resolvedModel.canonicalModelRef]?.content ??
      (resolvedModel.provider ? llmOptimized.providers?.[resolvedModel.provider]?.content : undefined)
    );
  }

  #buildAgentSwitchMessage(workspace: WorkspaceRecord, activeAgentName: string): string | undefined {
    const currentAgent = workspace.agents[activeAgentName];
    const message = buildAvailableAgentSwitchesMessage(activeAgentName, currentAgent, workspace.agents);
    return message.length > 0 ? message : undefined;
  }

  #buildAvailableSubagentsMessage(workspace: WorkspaceRecord, activeAgentName: string): string | undefined {
    if (!canDelegateFromAgent(workspace, activeAgentName)) {
      return undefined;
    }

    const currentAgent = workspace.agents[activeAgentName];
    const message = buildAvailableSubagentsMessage(activeAgentName, currentAgent, workspace.agents);
    return message.length > 0 ? message : undefined;
  }
}
