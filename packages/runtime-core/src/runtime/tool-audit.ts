import type { RunStep } from "@oah/api-contracts";

import type { ToolCallAuditRepository } from "../types.js";

export interface ToolAuditServiceDependencies {
  toolCallAuditRepository?: ToolCallAuditRepository | undefined;
  createId: (prefix: string) => string;
  resolveToolSourceType: (toolName: string) => "action" | "skill" | "agent" | "tool" | "native";
}

function asJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

function toolCallAuditSourceType(
  inputPayload: Record<string, unknown> | undefined,
  toolName: string,
  resolveToolSourceType: ToolAuditServiceDependencies["resolveToolSourceType"]
) {
  const sourceType = inputPayload?.sourceType;
  if (
    sourceType === "action" ||
    sourceType === "skill" ||
    sourceType === "agent" ||
    sourceType === "mcp" ||
    sourceType === "tool" ||
    sourceType === "native"
  ) {
    return sourceType === "mcp" ? "tool" : sourceType;
  }

  return resolveToolSourceType(toolName);
}

export class ToolAuditService {
  readonly #toolCallAuditRepository?: ToolCallAuditRepository | undefined;
  readonly #createId: ToolAuditServiceDependencies["createId"];
  readonly #resolveToolSourceType: ToolAuditServiceDependencies["resolveToolSourceType"];

  constructor(dependencies: ToolAuditServiceDependencies) {
    this.#toolCallAuditRepository = dependencies.toolCallAuditRepository;
    this.#createId = dependencies.createId;
    this.#resolveToolSourceType = dependencies.resolveToolSourceType;
  }

  async recordToolCallAuditFromStep(
    step: RunStep,
    toolName: string,
    status: "completed" | "failed" | "cancelled"
  ): Promise<void> {
    if (!this.#toolCallAuditRepository || !step.endedAt) {
      return;
    }

    const inputPayload = asJsonRecord(step.input);
    const outputPayload = asJsonRecord(step.output);
    const rawDurationMs =
      outputPayload && typeof outputPayload.durationMs === "number" ? outputPayload.durationMs : undefined;

    await this.#toolCallAuditRepository.create({
      id: this.#createId("tool"),
      runId: step.runId,
      stepId: step.id,
      sourceType: toolCallAuditSourceType(inputPayload, toolName, this.#resolveToolSourceType),
      toolName,
      ...(inputPayload ? { request: inputPayload } : {}),
      ...(outputPayload ? { response: outputPayload } : {}),
      status,
      ...(rawDurationMs !== undefined ? { durationMs: rawDurationMs } : {}),
      startedAt: step.startedAt ?? step.endedAt,
      endedAt: step.endedAt
    });
  }
}
