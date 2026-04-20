import { loadPlatformModels } from "@oah/config";
import { enrichModelRegistryWithDiscoveredMetadata } from "./model-metadata-discovery.js";

export type PlatformModelRegistry = Awaited<ReturnType<typeof loadPlatformModels>>;

export interface PlatformModelItem {
  id: string;
  provider: string;
  modelName: string;
  url?: string;
  hasKey: boolean;
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

function toPlatformModelItems(models: PlatformModelRegistry, defaultModel: string): PlatformModelItem[] {
  return Object.entries(models).map(([id, definition]) => ({
    id,
    provider: definition.provider,
    modelName: definition.name,
    ...(definition.url ? { url: definition.url } : {}),
    hasKey: Boolean(definition.key),
    ...(definition.metadata ? { metadata: definition.metadata } : {}),
    isDefault: defaultModel === id
  }));
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

export async function createPlatformModelCatalogService(options: {
  modelDir: string;
  defaultModel: string;
  onLoadError(input: { filePath: string; error: unknown }): void;
  onModelsChanged?: ((models: PlatformModelRegistry) => Promise<void> | void) | undefined;
}): Promise<PlatformModelCatalogService> {
  const definitions = await enrichModelRegistryWithDiscoveredMetadata(
    await loadPlatformModels(options.modelDir, {
      onError: options.onLoadError
    })
  );
  const listeners = new Set<(snapshot: PlatformModelSnapshot) => void>();
  let revision = 0;
  let reloadPromise: Promise<void> | undefined;

  async function getSnapshot(): Promise<PlatformModelSnapshot> {
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

  async function refresh(): Promise<PlatformModelSnapshot> {
    if (reloadPromise) {
      await reloadPromise;
      return getSnapshot();
    }

    reloadPromise = (async () => {
      const currentSnapshot = serializePlatformModels(definitions);
      const nextModels = await enrichModelRegistryWithDiscoveredMetadata(
        await loadPlatformModels(options.modelDir, {
          onError: options.onLoadError
        })
      );
      const nextSnapshot = serializePlatformModels(nextModels);

      if (currentSnapshot === nextSnapshot) {
        return;
      }

      replacePlatformModels(definitions, nextModels);
      await options.onModelsChanged?.(definitions);
      revision += 1;
      await publishSnapshot();
    })().finally(() => {
      reloadPromise = undefined;
    });

    await reloadPromise;
    return getSnapshot();
  }

  return {
    definitions,
    async listModels() {
      return toPlatformModelItems(definitions, options.defaultModel);
    },
    getSnapshot,
    refresh,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      return undefined;
    }
  };
}
