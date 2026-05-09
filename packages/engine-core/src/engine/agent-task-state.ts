import type { Run } from "@oah/api-contracts";

import type { AgentTaskRecord, AgentTaskStatus } from "../types.js";
import type { AgentTaskOutputView } from "./agent-coordination-types.js";
import { readNonNegativeInteger } from "./agent-coordination-records.js";

export function agentTaskOutputView(task: AgentTaskRecord, run?: Run | undefined): AgentTaskOutputView {
  const status = agentTaskOutputStatus(run?.status, task.status);
  const output = task.finalText ?? task.errorMessage ?? "";
  return {
    taskId: task.taskId,
    taskType: "local_agent",
    childSessionId: task.childSessionId,
    childRunId: task.childRunId,
    status,
    description: task.handoffSummary ?? task.description ?? task.targetAgentName,
    output,
    ...(task.description ? { prompt: task.description } : {}),
    ...(task.finalText !== undefined ? { result: task.finalText } : {}),
    ...(task.errorMessage !== undefined ? { error: task.errorMessage } : {}),
    outputRef: task.outputRef,
    ...(task.outputFile ? { outputFile: task.outputFile } : {}),
    ...(task.usage ? { usage: task.usage } : {}),
    ...(task.taskState ? { taskState: task.taskState } : {})
  };
}

export function agentTaskOutputStatus(
  runStatus: Run["status"] | undefined,
  taskStatus: AgentTaskStatus
): AgentTaskOutputView["status"] {
  const status = runStatus ?? taskStatus;
  if (status === "completed") {
    return "completed";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "cancelled" || status === "timed_out") {
    return "killed";
  }
  if (status === "queued") {
    return "pending";
  }
  return "running";
}

export function localAgentTaskState(input: {
  taskId: string;
  prompt: string;
  agentType: string;
  model?: string | undefined;
  existing?: AgentTaskRecord["taskState"] | undefined;
  status?: AgentTaskStatus | undefined;
  finalText?: string | undefined;
  errorMessage?: string | undefined;
  usage?: Record<string, unknown> | undefined;
  pendingMessage?: string | undefined;
  retrieved?: boolean | undefined;
  isBackgrounded?: boolean | undefined;
  notified?: boolean | undefined;
}): AgentTaskRecord["taskState"] {
  const existing = input.existing;
  const tokenCount = readNonNegativeInteger(input.usage?.totalTokens);
  const toolCount = readNonNegativeInteger(input.usage?.toolUses);
  const pendingMessages = [...(existing?.pendingMessages ?? [])];
  if (input.pendingMessage?.trim()) {
    pendingMessages.push(input.pendingMessage);
  }
  const isTerminal =
    input.status === "completed" ||
    input.status === "failed" ||
    input.status === "cancelled" ||
    input.status === "timed_out";
  return {
    type: "local_agent",
    agentId: input.taskId,
    prompt: input.prompt || existing?.prompt || "",
    agentType: input.agentType || existing?.agentType || "general-purpose",
    ...(input.model ?? existing?.model ? { model: input.model ?? existing?.model } : {}),
    retrieved: input.retrieved ?? existing?.retrieved ?? false,
    lastReportedToolCount: Math.max(existing?.lastReportedToolCount ?? 0, toolCount),
    lastReportedTokenCount: Math.max(existing?.lastReportedTokenCount ?? 0, tokenCount),
    isBackgrounded: input.isBackgrounded ?? existing?.isBackgrounded ?? true,
    pendingMessages: isTerminal ? [] : pendingMessages,
    retain: existing?.retain ?? false,
    diskLoaded: existing?.diskLoaded ?? false,
    notified: input.notified ?? existing?.notified ?? false,
    ...(isTerminal && !(existing?.retain ?? false) ? { evictAfter: existing?.evictAfter ?? Date.now() + 300_000 } : {}),
    ...(existing?.evictAfter !== undefined ? { evictAfter: existing.evictAfter } : {})
  };
}

export function agentTaskStatusFromRun(status: Run["status"]): AgentTaskStatus {
  if (status === "cancelled" || status === "timed_out") {
    return status;
  }

  return status === "completed" ? "completed" : "failed";
}

export function hasQueuedTaskNotificationContinuation(parentRun: Run): boolean {
  return (
    typeof parentRun.metadata?.taskNotificationContinuationRunId === "string" ||
    typeof parentRun.metadata?.taskNotificationContinuationQueuedAt === "string"
  );
}

export function taskNotificationContinuationRunId(parentRunId: string): string {
  return `run_task_notification_${parentRunId}`;
}

export function taskOutputRef(taskId: string): string {
  return `agent-task://${taskId}/output`;
}

export function taskNotificationId(taskId: string, childRunId: string, updateType: "completed" | "failed"): string {
  return `task_notification_${taskId}_${childRunId}_${updateType}`;
}
