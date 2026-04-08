import type { ChatMessage, ModelGenerateResponse, Run, Session } from "@oah/api-contracts";

import { collapseLeadingSystemMessages, type ModelExecutionInputSnapshot } from "./model-call-serialization.js";
import { ensureHookCanContinue, selectHooks, type HookEnvelope, type HookResult } from "./hooks.js";
import { normalizePromptMessages } from "./session-history.js";
import type { WorkspaceRecord } from "../types.js";

export interface HookApplicationServiceDependencies<TModelInput extends ModelExecutionInputSnapshot> {
  executeHook: (
    workspace: WorkspaceRecord,
    session: Session | undefined,
    run: Run,
    hook: WorkspaceRecord["hooks"][string],
    envelope: HookEnvelope
  ) => Promise<HookResult | undefined>;
  serializeModelRequest: (modelInput: TModelInput) => Record<string, unknown>;
  applyModelRequestPatch: (
    workspace: WorkspaceRecord,
    current: TModelInput,
    patch: Record<string, unknown>
  ) => TModelInput;
  applyModelResponsePatch: (response: ModelGenerateResponse, patch: Record<string, unknown>) => ModelGenerateResponse;
}

export class HookApplicationService<TModelInput extends ModelExecutionInputSnapshot> {
  readonly #executeHook: HookApplicationServiceDependencies<TModelInput>["executeHook"];
  readonly #serializeModelRequest: HookApplicationServiceDependencies<TModelInput>["serializeModelRequest"];
  readonly #applyModelRequestPatch: HookApplicationServiceDependencies<TModelInput>["applyModelRequestPatch"];
  readonly #applyModelResponsePatch: HookApplicationServiceDependencies<TModelInput>["applyModelResponsePatch"];

  constructor(dependencies: HookApplicationServiceDependencies<TModelInput>) {
    this.#executeHook = dependencies.executeHook;
    this.#serializeModelRequest = dependencies.serializeModelRequest;
    this.#applyModelRequestPatch = dependencies.applyModelRequestPatch;
    this.#applyModelResponsePatch = dependencies.applyModelResponsePatch;
  }

  async applyBeforeModelHooks(
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    modelInput: TModelInput
  ): Promise<TModelInput> {
    let current = modelInput;
    const additionalMessages: Array<{ role: "system"; content: string }> = [];

    for (const hook of selectHooks(workspace, "before_model_call", modelInput.canonicalModelRef)) {
      const result = await this.#executeHook(workspace, session, run, hook, {
        workspace_id: workspace.id,
        session_id: session.id,
        run_id: run.id,
        cwd: workspace.rootPath,
        hook_event_name: "before_model_call",
        agent_name: run.agentName,
        effective_agent_name: run.effectiveAgentName,
        trigger_type: run.triggerType,
        run_status: run.status,
        model_ref: current.canonicalModelRef,
        model_request: this.#serializeModelRequest(current)
      });

      ensureHookCanContinue(result, hook.name);
      if (result?.systemMessage) {
        additionalMessages.push({ role: "system", content: result.systemMessage });
      }
      if (result?.hookSpecificOutput?.additionalContext) {
        additionalMessages.push({ role: "system", content: result.hookSpecificOutput.additionalContext });
      }

      const patch = result?.hookSpecificOutput?.patch?.model_request;
      if (patch && hook.capabilities.includes("rewrite_model_request") && typeof patch === "object") {
        current = this.#applyModelRequestPatch(workspace, current, patch as Record<string, unknown>);
      }
    }

    return additionalMessages.length === 0
      ? {
          ...current,
          messages: current.messages
        }
      : {
          ...current,
          messages: this.#insertSystemMessages(current.messages, additionalMessages)
        };
  }

  async applyAfterModelHooks(
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    modelInput: TModelInput,
    response: ModelGenerateResponse
  ): Promise<ModelGenerateResponse> {
    let currentResponse = response;

    for (const hook of selectHooks(workspace, "after_model_call", modelInput.canonicalModelRef)) {
      const result = await this.#executeHook(workspace, session, run, hook, {
        workspace_id: workspace.id,
        session_id: session.id,
        run_id: run.id,
        cwd: workspace.rootPath,
        hook_event_name: "after_model_call",
        agent_name: run.agentName,
        effective_agent_name: run.effectiveAgentName,
        trigger_type: run.triggerType,
        run_status: run.status,
        model_ref: modelInput.canonicalModelRef,
        model_request: this.#serializeModelRequest(modelInput),
        model_response: {
          model: currentResponse.model,
          text: currentResponse.text,
          finishReason: currentResponse.finishReason
        }
      });

      ensureHookCanContinue(result, hook.name);
      const patch = result?.hookSpecificOutput?.patch?.model_response;
      if (patch && hook.capabilities.includes("rewrite_model_response") && typeof patch === "object") {
        currentResponse = this.#applyModelResponsePatch(currentResponse, patch as Record<string, unknown>);
      }

      const trailingNotes = [result?.systemMessage, result?.hookSpecificOutput?.additionalContext].filter(
        (value): value is string => typeof value === "string" && value.length > 0
      );
      if (trailingNotes.length > 0) {
        currentResponse = {
          ...currentResponse,
          text: [currentResponse.text, ...trailingNotes].join("\n\n")
        };
      }
    }

    return currentResponse;
  }

  async applyContextHooks(
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    eventName: "before_context_build" | "after_context_build",
    messages: ChatMessage[]
  ): Promise<ChatMessage[]> {
    let currentMessages = messages;

    for (const hook of selectHooks(workspace, eventName)) {
      const result = await this.#executeHook(workspace, session, run, hook, {
        workspace_id: workspace.id,
        session_id: session.id,
        run_id: run.id,
        cwd: workspace.rootPath,
        hook_event_name: eventName,
        agent_name: run.agentName,
        effective_agent_name: run.effectiveAgentName,
        trigger_type: run.triggerType,
        run_status: run.status,
        context: {
          messages: currentMessages
        }
      });

      ensureHookCanContinue(result, hook.name);
      const patch = result?.hookSpecificOutput?.patch?.context;
      if (patch && hook.capabilities.includes("rewrite_context") && typeof patch === "object") {
        currentMessages = this.#applyContextPatch(currentMessages, patch as Record<string, unknown>);
      }

      const notes = [result?.systemMessage, result?.hookSpecificOutput?.additionalContext].filter(
        (value): value is string => typeof value === "string" && value.length > 0
      );
      if (notes.length > 0) {
        currentMessages = this.#insertSystemMessages(
          currentMessages,
          notes.map((content) => ({
            role: "system",
            content
          }))
        );
      }
    }

    return currentMessages;
  }

  async applyBeforeToolDispatchHooks(
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    activeAgentName: string,
    toolName: string,
    toolCallId: string | undefined,
    input: unknown
  ): Promise<unknown> {
    let currentInput = input;

    for (const hook of selectHooks(workspace, "before_tool_dispatch", toolName)) {
      const result = await this.#executeHook(workspace, session, run, hook, {
        workspace_id: workspace.id,
        session_id: session.id,
        run_id: run.id,
        cwd: workspace.rootPath,
        hook_event_name: "before_tool_dispatch",
        agent_name: run.agentName,
        effective_agent_name: activeAgentName,
        trigger_type: run.triggerType,
        run_status: run.status,
        tool_name: toolName,
        tool_input: currentInput,
        ...(toolCallId ? { tool_call_id: toolCallId } : {})
      });

      ensureHookCanContinue(result, hook.name);
      const patch = result?.hookSpecificOutput?.patch?.tool_input;
      if (patch !== undefined && hook.capabilities.includes("rewrite_tool_request")) {
        currentInput = this.#applyToolPatch(currentInput, patch);
      }
    }

    return currentInput;
  }

  async applyAfterToolDispatchHooks(
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    activeAgentName: string,
    toolName: string,
    toolCallId: string | undefined,
    input: unknown,
    output: unknown
  ): Promise<unknown> {
    let currentOutput = output;

    for (const hook of selectHooks(workspace, "after_tool_dispatch", toolName)) {
      const result = await this.#executeHook(workspace, session, run, hook, {
        workspace_id: workspace.id,
        session_id: session.id,
        run_id: run.id,
        cwd: workspace.rootPath,
        hook_event_name: "after_tool_dispatch",
        agent_name: run.agentName,
        effective_agent_name: activeAgentName,
        trigger_type: run.triggerType,
        run_status: run.status,
        tool_name: toolName,
        tool_input: input,
        tool_output: currentOutput,
        ...(toolCallId ? { tool_call_id: toolCallId } : {})
      });

      ensureHookCanContinue(result, hook.name);
      const patch = result?.hookSpecificOutput?.patch?.tool_output;
      if (patch !== undefined && hook.capabilities.includes("rewrite_tool_response")) {
        currentOutput = this.#applyToolPatch(currentOutput, patch);
      }
      if (result?.suppressOutput && hook.capabilities.includes("suppress_output")) {
        currentOutput = "";
      }

      const notes = [result?.systemMessage, result?.hookSpecificOutput?.additionalContext].filter(
        (value): value is string => typeof value === "string" && value.length > 0
      );
      if (notes.length > 0) {
        currentOutput = this.#appendToolOutputNotes(currentOutput, notes);
      }
    }

    return currentOutput;
  }

  async runLifecycleHooks(
    workspace: WorkspaceRecord,
    session: Session | undefined,
    run: Run,
    eventName: "run_completed" | "run_failed"
  ): Promise<void> {
    const hooks = selectHooks(workspace, eventName, run.triggerType);
    for (const hook of hooks) {
      try {
        await this.#executeHook(workspace, session, run, hook, {
          workspace_id: workspace.id,
          ...(session ? { session_id: session.id } : {}),
          run_id: run.id,
          cwd: workspace.rootPath,
          hook_event_name: eventName,
          agent_name: run.agentName,
          effective_agent_name: run.effectiveAgentName,
          trigger_type: run.triggerType,
          run_status: run.status
        });
      } catch {
        continue;
      }
    }
  }

  #applyContextPatch(currentMessages: ChatMessage[], patch: Record<string, unknown>): ChatMessage[] {
    if (Array.isArray(patch.messages)) {
      return normalizePromptMessages(patch.messages);
    }

    return currentMessages;
  }

  #applyToolPatch(currentValue: unknown, patch: unknown): unknown {
    if (
      currentValue &&
      typeof currentValue === "object" &&
      !Array.isArray(currentValue) &&
      patch &&
      typeof patch === "object" &&
      !Array.isArray(patch)
    ) {
      return {
        ...(currentValue as Record<string, unknown>),
        ...(patch as Record<string, unknown>)
      };
    }

    return patch;
  }

  #appendToolOutputNotes(currentValue: unknown, notes: string[]): unknown {
    if (typeof currentValue === "string") {
      return [currentValue, ...notes].filter((value) => value.length > 0).join("\n\n");
    }

    if (currentValue && typeof currentValue === "object" && !Array.isArray(currentValue)) {
      const existingNotes = Array.isArray((currentValue as { hookNotes?: unknown }).hookNotes)
        ? ((currentValue as { hookNotes: unknown[] }).hookNotes.filter((value): value is string => typeof value === "string") ??
          [])
        : [];
      return {
        ...(currentValue as Record<string, unknown>),
        hookNotes: [...existingNotes, ...notes]
      };
    }

    return notes.join("\n\n");
  }

  #insertSystemMessages(
    messages: ChatMessage[],
    extraSystemMessages: Array<{ role: "system"; content: string }>
  ): ChatMessage[] {
    const firstNonSystemIndex = messages.findIndex((message) => message.role !== "system");
    if (firstNonSystemIndex === -1) {
      return collapseLeadingSystemMessages([...messages, ...extraSystemMessages]);
    }

    return collapseLeadingSystemMessages([
      ...messages.slice(0, firstNonSystemIndex),
      ...extraSystemMessages,
      ...messages.slice(firstNonSystemIndex)
    ]);
  }
}
