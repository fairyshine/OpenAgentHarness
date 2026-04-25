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

export function normalizeModelMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }

  const normalized: Record<string, unknown> = { ...metadata };
  const contextWindowTokens =
    parsePositiveNumber(metadata.contextWindowTokens) ??
    parsePositiveNumber(metadata.context_window_tokens) ??
    parsePositiveNumber(metadata.max_model_len) ??
    parsePositiveNumber(metadata.maxInputTokens) ??
    parsePositiveNumber(metadata.max_input_tokens) ??
    parsePositiveNumber(metadata.contextWindow) ??
    parsePositiveNumber(metadata.context_window);

  if (contextWindowTokens) {
    normalized.contextWindowTokens = contextWindowTokens;
  }

  delete normalized.context_window_tokens;

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizePlatformModelDefinition(definition: PlatformModelDefinition): PlatformModelDefinition {
  const metadata = normalizeModelMetadata(definition.metadata);
  return {
    ...definition,
    ...(metadata ? { metadata } : {})
  };
}

export function normalizePlatformModelRegistry(registry: PlatformModelRegistry): PlatformModelRegistry {
  return Object.fromEntries(
    Object.entries(registry).map(([name, definition]) => [name, normalizePlatformModelDefinition(definition)])
  );
}

export function readContextWindowTokens(metadata: Record<string, unknown> | undefined): number | undefined {
  return parsePositiveNumber(normalizeModelMetadata(metadata)?.contextWindowTokens);
}
