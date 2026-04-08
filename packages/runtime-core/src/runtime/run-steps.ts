import type { Run, RunStep } from "@oah/api-contracts";

import type { RunStepRepository, RunStepStatus, RunStepType } from "../types.js";

export interface RunStepServiceDependencies {
  runStepRepository: RunStepRepository;
  createId: (prefix: string) => string;
  nowIso: () => string;
}

export class RunStepService {
  readonly #runStepRepository: RunStepRepository;
  readonly #createId: RunStepServiceDependencies["createId"];
  readonly #nowIso: RunStepServiceDependencies["nowIso"];

  constructor(dependencies: RunStepServiceDependencies) {
    this.#runStepRepository = dependencies.runStepRepository;
    this.#createId = dependencies.createId;
    this.#nowIso = dependencies.nowIso;
  }

  async startRunStep(input: {
    runId: string;
    stepType: RunStepType;
    name?: string | undefined;
    agentName?: string | undefined;
    input?: Record<string, unknown> | undefined;
  }): Promise<RunStep> {
    const existingSteps = await this.#runStepRepository.listByRunId(input.runId);
    return this.#runStepRepository.create({
      id: this.#createId("step"),
      runId: input.runId,
      seq: existingSteps.length + 1,
      stepType: input.stepType,
      ...(input.name ? { name: input.name } : {}),
      ...(input.agentName ? { agentName: input.agentName } : {}),
      status: "running",
      ...(input.input ? { input: input.input } : {}),
      startedAt: this.#nowIso()
    });
  }

  async completeRunStep(
    step: RunStep,
    status: Extract<RunStepStatus, "completed" | "failed" | "cancelled">,
    output?: Record<string, unknown> | undefined
  ): Promise<RunStep> {
    return this.#runStepRepository.update({
      ...step,
      status,
      ...(output ? { output } : {}),
      endedAt: this.#nowIso()
    });
  }

  async recordSystemStep(
    run: Run,
    name: string,
    output?: Record<string, unknown> | undefined
  ): Promise<RunStep> {
    const step = await this.startRunStep({
      runId: run.id,
      stepType: "system",
      name,
      ...(run.effectiveAgentName ? { agentName: run.effectiveAgentName } : {})
    });

    return this.completeRunStep(step, "completed", output);
  }
}
