import type { PlatformModelDefinition, PlatformModelRegistry } from "@oah/config";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePositiveNumber(value: unknown): number | undefined {
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

function resolveModelDiscoveryUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/u, "");
  if (trimmed.endsWith("/models")) {
    return trimmed;
  }

  return trimmed.endsWith("/v1") ? `${trimmed}/models` : `${trimmed}/v1/models`;
}

function shouldProbeModel(definition: PlatformModelDefinition): boolean {
  return (
    definition.provider === "openai-compatible" &&
    typeof definition.url === "string" &&
    definition.url.trim().length > 0
  );
}

async function discoverContextWindowMetadata(definition: PlatformModelDefinition): Promise<Record<string, number> | undefined> {
  const modelUrl = definition.url;
  if (!shouldProbeModel(definition) || typeof modelUrl !== "string") {
    return undefined;
  }

  const response = await fetch(resolveModelDiscoveryUrl(modelUrl), {
    headers: {
      accept: "application/json",
      ...(definition.key ? { authorization: `Bearer ${definition.key}` } : {})
    }
  });
  if (!response.ok) {
    return undefined;
  }

  const payload = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return undefined;
  }

  const modelCard = payload.data.find((candidate) => {
    if (!isRecord(candidate)) {
      return false;
    }

    return candidate.id === definition.name || candidate.name === definition.name;
  });
  if (!isRecord(modelCard)) {
    return undefined;
  }

  const maxModelLen = parsePositiveNumber(modelCard.max_model_len);
  return maxModelLen ? { max_model_len: maxModelLen } : undefined;
}

export async function enrichModelRegistryWithDiscoveredMetadata(
  models: PlatformModelRegistry
): Promise<PlatformModelRegistry> {
  const entries = await Promise.all(
    Object.entries(models).map(async ([modelName, definition]) => {
      try {
        const discoveredMetadata = await discoverContextWindowMetadata(definition);
        if (!discoveredMetadata) {
          return [modelName, definition] as const;
        }

        return [
          modelName,
          {
            ...definition,
            metadata: {
              ...(definition.metadata ?? {}),
              ...discoveredMetadata
            }
          }
        ] as const;
      } catch {
        return [modelName, definition] as const;
      }
    })
  );

  return Object.fromEntries(entries);
}

export async function enrichWorkspaceModelsWithDiscoveredMetadata<
  TWorkspace extends {
    workspaceModels: PlatformModelRegistry;
  }
>(workspace: TWorkspace): Promise<TWorkspace> {
  const workspaceModels = await enrichModelRegistryWithDiscoveredMetadata(workspace.workspaceModels);
  return {
    ...workspace,
    workspaceModels
  };
}
