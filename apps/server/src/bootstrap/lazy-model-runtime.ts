import type { PlatformModelRegistry } from "@oah/config";
import type { ModelGenerateResponse } from "@oah/api-contracts";
import type {
  EngineLogger,
  GenerateModelInput,
  ModelGateway,
  ModelStreamOptions,
  StreamedModelResponse
} from "../../../../packages/engine-core/src/types.js";

type RuntimeAiSdkModelRuntime = ModelGateway & {
  clearModelCache?(modelNames?: string[]): void;
};

export interface LazyModelRuntimeOptions {
  defaultModelName: string;
  models: PlatformModelRegistry;
  logger?: EngineLogger | undefined;
}

export class LazyModelRuntime implements ModelGateway {
  readonly #options: LazyModelRuntimeOptions;
  #runtime: RuntimeAiSdkModelRuntime | undefined;
  #runtimePromise: Promise<RuntimeAiSdkModelRuntime> | undefined;

  constructor(options: LazyModelRuntimeOptions) {
    this.#options = options;
  }

  clearModelCache(modelNames?: string[]): void {
    this.#runtime?.clearModelCache?.(modelNames);
  }

  async generate(input: GenerateModelInput, options?: { signal?: AbortSignal }): Promise<ModelGenerateResponse> {
    return (await this.#resolveRuntime()).generate(input, options);
  }

  async stream(input: GenerateModelInput, options?: ModelStreamOptions): Promise<StreamedModelResponse> {
    return (await this.#resolveRuntime()).stream(input, options);
  }

  async #resolveRuntime(): Promise<RuntimeAiSdkModelRuntime> {
    if (this.#runtime) {
      return this.#runtime;
    }

    this.#runtimePromise ??= import("@oah/model-runtime").then(({ AiSdkModelRuntime }) => {
      const runtime = new AiSdkModelRuntime(this.#options) as RuntimeAiSdkModelRuntime;
      this.#runtime = runtime;
      return runtime;
    });

    return this.#runtimePromise;
  }
}
