import type { RuntimeService } from "./runtime-service.js";

type ExecutionRuntimeKernel = Pick<
  RuntimeService,
  "processQueuedRun" | "getRun" | "recoverRunAfterDrainTimeout" | "recoverStaleRuns"
>;

export interface ExecutionRuntimeOperations extends ExecutionRuntimeKernel {}

export class ExecutionRuntimeService implements ExecutionRuntimeOperations {
  readonly processQueuedRun: RuntimeService["processQueuedRun"];
  readonly getRun: RuntimeService["getRun"];
  readonly recoverRunAfterDrainTimeout: RuntimeService["recoverRunAfterDrainTimeout"];
  readonly recoverStaleRuns: RuntimeService["recoverStaleRuns"];

  constructor(kernel: ExecutionRuntimeKernel) {
    this.processQueuedRun = kernel.processQueuedRun.bind(kernel);
    this.getRun = kernel.getRun.bind(kernel);
    this.recoverRunAfterDrainTimeout = kernel.recoverRunAfterDrainTimeout.bind(kernel);
    this.recoverStaleRuns = kernel.recoverStaleRuns.bind(kernel);
  }
}
