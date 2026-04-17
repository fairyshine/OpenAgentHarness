import type { Message, Run, RunStep, Session } from "@oah/api-contracts";

import { createId, nowIso } from "../utils.js";
import { toolRetryPolicy as resolveToolRetryPolicy, toolSourceType as resolveToolSourceType } from "../runtime-tooling.js";
import type {
  RunQueuePriority,
  RuntimeServiceOptions,
  SessionEvent,
  WorkspaceCommandExecutor,
  WorkspaceFileSystem,
  WorkspaceRecord
} from "../types.js";
import { ActionRunService } from "./action-runs.js";
import { AgentCoordinationService } from "./agent-coordination.js";
import { buildGeneratedMessageMetadata, normalizeJsonObject } from "./execution-support.js";
import { HookApplicationService } from "./hook-application.js";
import { HookService } from "./hooks.js";
import {
  applyModelRequestPatch,
  applyModelResponsePatch,
  collapseLeadingSystemMessages,
  previewValue,
  serializeModelRequest
} from "./model-call-serialization.js";
import type { ModelExecutionInput, ModelInputService } from "./model-input.js";
import { RunFinalizationService } from "./run-finalization.js";
import type { RunStateService } from "./run-state.js";
import type { RunStepService } from "./run-steps.js";
import { extractMessageDisplayText, hasMeaningfulText } from "./session-history.js";
import { ToolAuditService } from "./tool-audit.js";
import { ToolExecutionService } from "./tool-execution.js";
import { ToolMessageService } from "./tool-messages.js";
import { createAbortError, isAbortError, timeoutMsFromSeconds, withTimeout } from "./internal-helpers.js";

export interface RuntimeExecutionServices {
  hooks: HookService;
  hookApplications: HookApplicationService<ModelExecutionInput>;
  toolAudit: ToolAuditService;
  toolExecution: ToolExecutionService;
  toolMessages: ToolMessageService;
  actions: ActionRunService;
  agentCoordination: AgentCoordinationService;
  runFinalization: RunFinalizationService;
}

export interface CreateRuntimeExecutionServicesDependencies {
  defaultModel: string;
  modelGateway: RuntimeServiceOptions["modelGateway"];
  logger: RuntimeServiceOptions["logger"];
  workspaceCommandExecutor: WorkspaceCommandExecutor;
  workspaceFileSystem: WorkspaceFileSystem;
  hookRunAuditRepository: RuntimeServiceOptions["hookRunAuditRepository"];
  toolCallAuditRepository: RuntimeServiceOptions["toolCallAuditRepository"];
  sessionRepository: RuntimeServiceOptions["sessionRepository"];
  messageRepository: RuntimeServiceOptions["messageRepository"];
  runRepository: RuntimeServiceOptions["runRepository"];
  startRunStep: RunStepService["startRunStep"];
  completeRunStep: RunStepService["completeRunStep"];
  recordSystemStep: RunStepService["recordSystemStep"];
  setRunStatus: RunStateService["setRunStatus"];
  setRunStatusIfPossible: RunStateService["setRunStatusIfPossible"];
  updateRun: RunStateService["updateRun"];
  markRunTimedOut: RunStateService["markRunTimedOut"];
  markRunCancelled: RunStateService["markRunCancelled"];
  resolveModelForRun: ModelInputService["resolveModelForRun"];
  appendEvent: (input: Omit<SessionEvent, "id" | "cursor" | "createdAt">) => Promise<SessionEvent>;
  getRun: (runId: string) => Promise<Run>;
  enqueueRun: (
    sessionId: string,
    runId: string,
    options?: { priority?: RunQueuePriority | undefined }
  ) => Promise<void>;
}

export function createRuntimeExecutionServices(
  dependencies: CreateRuntimeExecutionServicesDependencies
): RuntimeExecutionServices {
  const hooks = new HookService({
    defaultModel: dependencies.defaultModel,
    modelGateway: dependencies.modelGateway,
    commandExecutor: dependencies.workspaceCommandExecutor,
    fileSystem: dependencies.workspaceFileSystem,
    hookRunAuditRepository: dependencies.hookRunAuditRepository,
    startRunStep: (input) => dependencies.startRunStep(input),
    completeRunStep: (step, status, output) => dependencies.completeRunStep(step, status, output),
    appendEvent: (input) => dependencies.appendEvent(input),
    resolveModelForRun: (workspace, modelRef) => dependencies.resolveModelForRun(workspace, modelRef),
    createId,
    timeoutMsFromSeconds,
    withTimeout,
    isAbortError
  });
  const hookApplications = new HookApplicationService<ModelExecutionInput>({
    executeHook: (workspace, session, run, hook, envelope) => hooks.executeHook(workspace, session, run, hook, envelope),
    serializeModelRequest: (modelInput) => serializeModelRequest(modelInput),
    applyModelRequestPatch: (workspace, current, patch) =>
      applyModelRequestPatch(workspace, current, patch, {
        resolveModelForRun: (targetWorkspace, modelRef) => dependencies.resolveModelForRun(targetWorkspace, modelRef),
        collapseLeadingSystemMessages: (messages) => collapseLeadingSystemMessages(messages),
        createModelExecutionInput: (input) => ({ ...input })
      }),
    applyModelResponsePatch: (response, patch) => applyModelResponsePatch(response, patch)
  });
  const toolAudit = new ToolAuditService({
    toolCallAuditRepository: dependencies.toolCallAuditRepository,
    createId,
    resolveToolSourceType
  });
  const toolExecution = new ToolExecutionService({
    logger: dependencies.logger,
    startRunStep: (input) => dependencies.startRunStep(input),
    completeRunStep: (step, status, output) => dependencies.completeRunStep(step, status, output),
    recordToolCallAuditFromStep: (step, toolName, status) =>
      toolAudit.recordToolCallAuditFromStep(step, toolName, status),
    appendEvent: (input) => dependencies.appendEvent(input),
    setRunStatusIfPossible: (runId, nextStatus) => dependencies.setRunStatusIfPossible(runId, nextStatus),
    applyBeforeToolDispatchHooks: (workspace, session, run, activeAgentName, toolName, toolCallId, input) =>
      hookApplications.applyBeforeToolDispatchHooks(
        workspace,
        session,
        run,
        activeAgentName,
        toolName,
        toolCallId,
        input
      ),
    applyAfterToolDispatchHooks: (workspace, session, run, activeAgentName, toolName, toolCallId, input, output) =>
      hookApplications.applyAfterToolDispatchHooks(
        workspace,
        session,
        run,
        activeAgentName,
        toolName,
        toolCallId,
        input,
        output
      ),
    resolveToolRetryPolicy,
    resolveToolSourceType,
    timeoutMsFromSeconds,
    createAbortError,
    normalizeJsonObject: (value) => normalizeJsonObject(value),
    previewValue: (value, maxLength) => previewValue(value, maxLength)
  });
  const toolMessages = new ToolMessageService({
    messageRepository: dependencies.messageRepository,
    logger: dependencies.logger,
    appendEvent: (input) => dependencies.appendEvent(input),
    createId,
    nowIso,
    previewValue: (value, maxLength) => previewValue(value, maxLength)
  });
  const actions = new ActionRunService({
    defaultModel: dependencies.defaultModel,
    commandExecutor: dependencies.workspaceCommandExecutor,
    sessionRepository: dependencies.sessionRepository,
    toolMessages,
    startRunStep: (input) => dependencies.startRunStep(input),
    completeRunStep: (step, status, output) => dependencies.completeRunStep(step, status, output),
    setRunStatus: (run, nextStatus, patch) => dependencies.setRunStatus(run, nextStatus, patch),
    getRun: (runId) => dependencies.getRun(runId),
    recordSystemStep: (run, name, output) => dependencies.recordSystemStep(run, name, output),
    recordToolCallAuditFromStep: (step, toolName, status) =>
      toolAudit.recordToolCallAuditFromStep(step, toolName, status),
    appendEvent: (input) => dependencies.appendEvent(input),
    nowIso,
    normalizeJsonObject: (value) => normalizeJsonObject(value)
  });
  const agentCoordination = new AgentCoordinationService({
    sessionRepository: dependencies.sessionRepository,
    messageRepository: dependencies.messageRepository,
    runRepository: dependencies.runRepository,
    getRun: (runId) => dependencies.getRun(runId),
    startRunStep: (input) => dependencies.startRunStep(input),
    completeRunStep: (step, status, output) => dependencies.completeRunStep(step, status, output),
    updateRun: (run, patch) => dependencies.updateRun(run, patch),
    appendEvent: (input) => dependencies.appendEvent(input),
    enqueueRun: (sessionId, runId, options) => dependencies.enqueueRun(sessionId, runId, options),
    resolveModelForRun: (workspace, modelRef) => dependencies.resolveModelForRun(workspace, modelRef),
    extractMessageDisplayText: (message) => extractMessageDisplayText(message),
    hasMeaningfulText: (value) => hasMeaningfulText(value),
    createId,
    nowIso
  });
  const runFinalization = new RunFinalizationService({
    sessionRepository: dependencies.sessionRepository,
    getRun: (runId) => dependencies.getRun(runId),
    ensureAssistantMessage: (session, run, currentMessage, allMessages, content, metadata) =>
      toolMessages.ensureAssistantMessage(session, run, currentMessage, allMessages, content, metadata),
    updateAssistantMessage: (message, content) =>
      dependencies.messageRepository.update({
        ...message,
        content
      }) as Promise<Extract<Message, { role: "assistant" }>>,
    appendEvent: (input) => dependencies.appendEvent(input),
    setRunStatus: (run, nextStatus, patch) => dependencies.setRunStatus(run, nextStatus, patch),
    markRunTimedOut: (run, runTimeoutMs) => dependencies.markRunTimedOut(run, runTimeoutMs),
    markRunCancelled: (sessionId, run) => dependencies.markRunCancelled(sessionId, run),
    recordSystemStep: (run, name, output) => dependencies.recordSystemStep(run, name, output),
    runLifecycleHooks: (workspace, session, run, eventName) => hookApplications.runLifecycleHooks(workspace, session, run, eventName),
    buildGeneratedMessageMetadata: (workspace, agentName, modelInput) =>
      buildGeneratedMessageMetadata(workspace, agentName, modelInput),
    nowIso
  });

  return {
    hooks,
    hookApplications,
    toolAudit,
    toolExecution,
    toolMessages,
    actions,
    agentCoordination,
    runFinalization
  };
}
