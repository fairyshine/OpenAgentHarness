import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PlatformModelRegistry } from "@oah/config";
import { normalizeModelMetadata, normalizePlatformModelRegistry, readContextWindowTokens } from "./platform-model-metadata.js";

let platformModelsModulePromise:
  | Promise<{
      loadPlatformModels: (
        modelDir: string,
        options?: { onError?: ((input: { filePath: string; error: unknown }) => void) | undefined }
      ) => Promise<PlatformModelRegistry>;
    }>
  | undefined;
let modelMetadataDiscoveryModulePromise: Promise<typeof import("./model-metadata-discovery.js")> | undefined;

function loadPlatformModelsModule(): Promise<{
  loadPlatformModels: (
    modelDir: string,
    options?: { onError?: ((input: { filePath: string; error: unknown }) => void) | undefined }
  ) => Promise<PlatformModelRegistry>;
}> {
  platformModelsModulePromise ??= import("@oah/config/platform-models").catch(() =>
    import("../../../../packages/config/src/platform-models.js")
  );
  return platformModelsModulePromise;
}

function loadModelMetadataDiscoveryModule(): Promise<typeof import("./model-metadata-discovery.js")> {
  modelMetadataDiscoveryModulePromise ??= import("./model-metadata-discovery.js");
  return modelMetadataDiscoveryModulePromise;
}
const PERSISTED_MODEL_METADATA_FILENAME = ".oah-platform-model-metadata.json";

export interface PlatformModelItem {
  id: string;
  provider: string;
  modelName: string;
  url?: string;
  hasKey: boolean;
  contextWindowTokens?: number;
  metadata?: Record<string, unknown>;
  isDefault: boolean;
}

export interface PlatformModelSnapshot {
  revision: number;
  items: PlatformModelItem[];
}

export interface PlatformModelCatalogService {
  readonly definitions: PlatformModelRegistry;
  listModels(): Promise<PlatformModelItem[]>;
  getSnapshot(): Promise<PlatformModelSnapshot>;
  refresh(): Promise<PlatformModelSnapshot>;
  subscribe(listener: (snapshot: PlatformModelSnapshot) => void): () => void;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPositiveNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

function toPlatformModelItems(models: PlatformModelRegistry, defaultModel: string): PlatformModelItem[] {
  return Object.entries(models).map(([id, definition]) => {
    const contextWindowTokens = readContextWindowTokens(definition.metadata);
    return {
      id,
      provider: definition.provider,
      modelName: definition.name,
      ...(definition.url ? { url: definition.url } : {}),
      hasKey: Boolean(definition.key),
      ...(contextWindowTokens ? { contextWindowTokens } : {}),
      ...(definition.metadata ? { metadata: definition.metadata } : {}),
      isDefault: defaultModel === id
    };
  });
}

function replacePlatformModels(target: PlatformModelRegistry, next: PlatformModelRegistry): void {
  for (const modelName of Object.keys(target)) {
    if (!(modelName in next)) {
      delete target[modelName];
    }
  }

  for (const [modelName, definition] of Object.entries(next)) {
    target[modelName] = definition;
  }
}

function serializePlatformModels(models: PlatformModelRegistry): string {
  return JSON.stringify(
    Object.entries(models)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, definition]) => [name, definition])
  );
}

function persistedPlatformModelMetadataPath(modelDir: string): string {
  return path.join(modelDir, PERSISTED_MODEL_METADATA_FILENAME);
}

async function loadPersistedContextWindowTokens(input: {
  modelDir: string;
  onLoadError(input: { filePath: string; error: unknown }): void;
}): Promise<Record<string, number>> {
  const filePath = persistedPlatformModelMetadataPath(input.modelDir);

  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      models?: unknown;
    };

    if (!isRecord(parsed.models)) {
      return {};
    }

    const entries = Object.entries(parsed.models)
      .map(([modelName, entry]) => {
        if (!isRecord(entry)) {
          return undefined;
        }

        const contextWindowTokens = readPositiveNumber(entry.contextWindowTokens);
        return contextWindowTokens ? ([modelName, contextWindowTokens] as const) : undefined;
      })
      .filter((entry): entry is readonly [string, number] => entry !== undefined);

    return Object.fromEntries(entries);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return {};
    }

    input.onLoadError({
      filePath,
      error
    });
    return {};
  }
}

function applyPersistedContextWindowTokens(
  models: PlatformModelRegistry,
  persistedContextWindowTokens: Record<string, number>
): PlatformModelRegistry {
  return normalizePlatformModelRegistry(
    Object.fromEntries(
      Object.entries(models).map(([modelName, definition]) => {
        const contextWindowTokens = persistedContextWindowTokens[modelName];
        if (!contextWindowTokens) {
          return [modelName, definition];
        }

        return [
          modelName,
          {
            ...definition,
            metadata: normalizeModelMetadata({
              ...(definition.metadata ?? {}),
              contextWindowTokens
            })
          }
        ];
      })
    )
  );
}

function serializePersistedContextWindowTokens(models: PlatformModelRegistry): string {
  const persistedModels = Object.fromEntries(
    Object.entries(models)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([modelName, definition]) => {
        const contextWindowTokens = readContextWindowTokens(definition.metadata);
        return contextWindowTokens ? [[modelName, { contextWindowTokens }]] : [];
      })
  );

  return `${JSON.stringify(
    {
      version: 1,
      updatedAt: new Date().toISOString(),
      models: persistedModels
    },
    null,
    2
  )}\n`;
}

async function persistContextWindowTokens(input: {
  modelDir: string;
  models: PlatformModelRegistry;
  onLoadError(input: { filePath: string; error: unknown }): void;
}): Promise<void> {
  const filePath = persistedPlatformModelMetadataPath(input.modelDir);
  const nextContent = serializePersistedContextWindowTokens(input.models);

  try {
    await mkdir(input.modelDir, { recursive: true });
    const currentContent = await readFile(filePath, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        return undefined;
      }

      throw error;
    });

    if (currentContent === nextContent) {
      return;
    }

    await writeFile(filePath, nextContent, "utf8");
  } catch (error) {
    input.onLoadError({
      filePath,
      error
    });
  }
}

export async function createPlatformModelCatalogService(options: {
  modelDir: string;
  stateDir: string;
  defaultModel: string;
  onLoadError(input: { filePath: string; error: unknown }): void;
  onModelsChanged?: ((models: PlatformModelRegistry) => Promise<void> | void) | undefined;
  metadataDiscovery?: "eager" | "background" | "disabled" | undefined;
}): Promise<PlatformModelCatalogService> {
  async function loadDefinitions(input?: { discoverMetadata?: boolean | undefined }): Promise<PlatformModelRegistry> {
    const { loadPlatformModels } = await loadPlatformModelsModule();
    const loadedModels = normalizePlatformModelRegistry(
      await loadPlatformModels(options.modelDir, {
        onError: options.onLoadError
      })
    );
    const persistedContextWindowTokens = await loadPersistedContextWindowTokens({
      modelDir: options.stateDir,
      onLoadError: options.onLoadError
    });
    const mergedModels = applyPersistedContextWindowTokens(loadedModels, persistedContextWindowTokens);
    if (!input?.discoverMetadata) {
      return mergedModels;
    }

    const enrichedModels = await (await loadModelMetadataDiscoveryModule()).enrichModelRegistryWithDiscoveredMetadata(
      mergedModels
    );
    await persistContextWindowTokens({
      modelDir: options.stateDir,
      models: enrichedModels,
      onLoadError: options.onLoadError
    });
    return enrichedModels;
  }

  const metadataDiscoveryMode = options.metadataDiscovery ?? "eager";
  const definitions = await loadDefinitions({
    discoverMetadata: metadataDiscoveryMode === "eager"
  });
  const listeners = new Set<(snapshot: PlatformModelSnapshot) => void>();
  let revision = 0;
  let reloadPromise: Promise<void> | undefined;
  let backgroundHydrationStarted = false;
  let backgroundHydrationPromise: Promise<void> | undefined;
  let closed = false;

  async function getSnapshot(): Promise<PlatformModelSnapshot> {
    startBackgroundHydration();
    return {
      revision,
      items: toPlatformModelItems(definitions, options.defaultModel)
    };
  }

  async function publishSnapshot(): Promise<void> {
    if (listeners.size === 0) {
      return;
    }

    const snapshot = await getSnapshot();
    for (const listener of listeners) {
      listener(snapshot);
    }
  }

  async function reloadDefinitions(input?: { discoverMetadata?: boolean | undefined }): Promise<PlatformModelSnapshot> {
    const currentSnapshot = serializePlatformModels(definitions);
    const nextModels = await loadDefinitions(input);
    const nextSnapshot = serializePlatformModels(nextModels);

    if (currentSnapshot !== nextSnapshot) {
      replacePlatformModels(definitions, nextModels);
      await options.onModelsChanged?.(definitions);
      revision += 1;
      await publishSnapshot();
    }

    return getSnapshot();
  }

  function startBackgroundHydration(): void {
    if (metadataDiscoveryMode !== "background" || backgroundHydrationStarted || closed) {
      return;
    }

    backgroundHydrationStarted = true;
    const hydrationTask =
      reloadPromise ??
      (async () => {
        await reloadDefinitions({
          discoverMetadata: true
        }).catch(() => undefined);
      })().finally(() => {
        if (reloadPromise === hydrationTask) {
          reloadPromise = undefined;
        }
      });

    reloadPromise = hydrationTask;
    backgroundHydrationPromise = hydrationTask.finally(() => {
      backgroundHydrationPromise = undefined;
    });
  }

  async function refresh(): Promise<PlatformModelSnapshot> {
    if (reloadPromise) {
      await reloadPromise;
      return getSnapshot();
    }

    reloadPromise = (async () => {
      await reloadDefinitions({
        discoverMetadata: metadataDiscoveryMode !== "disabled"
      });
    })().finally(() => {
      reloadPromise = undefined;
    });

    await reloadPromise;
    return getSnapshot();
  }

  return {
    definitions,
    async listModels() {
      startBackgroundHydration();
      return toPlatformModelItems(definitions, options.defaultModel);
    },
    getSnapshot,
    refresh,
    subscribe(listener) {
      startBackgroundHydration();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      closed = true;
      await reloadPromise;
      await backgroundHydrationPromise;
    }
  };
}
