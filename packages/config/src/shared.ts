import { access, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  ActionCatalogItem,
  AgentCatalogItem,
  HookCatalogItem,
  ModelCatalogItem,
  SkillCatalogItem,
  ToolCatalogItem
} from "@oah/api-contracts";
import type { ErrorObject } from "ajv";
import type { ValidateFunction } from "ajv";
import YAML from "yaml";
import type {
  DiscoveredAction,
  DiscoveredAgent,
  DiscoveredHook,
  DiscoveredSkill,
  DiscoveredToolServer,
  DiscoveredWorkspaceCatalog,
  PlatformModelDefinition,
  PlatformModelRegistry,
  PromptSource,
  ResolvedPromptSource,
  ServerConfig,
  WorkspaceModelPreset,
  WorkspaceSystemPromptSettings
} from "./types.js";

const ajv2020Module = await import("ajv/dist/2020.js");
const Ajv2020 = (ajv2020Module.Ajv2020 ?? ajv2020Module.default) as typeof import("ajv/dist/2020.js")["Ajv2020"];
const addFormats = (await import("ajv-formats")).default as unknown as typeof import("ajv-formats").default;

export function createAjv() {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false
  });

  addFormats(ajv);
  return ajv;
}

const schemaCache = new Map<string, Promise<unknown>>();
const schemaValidatorCache = new Map<string, Promise<ValidateFunction<unknown>>>();

function resolveRuntimeAssetFileUrl(relativePath: string): URL {
  const normalizedRelativePath = path.posix.normalize(relativePath.replaceAll("\\", "/")).replace(/^(\.\.\/)+/u, "");
  const configuredRoot = process.env.OAH_DOCS_ROOT?.trim();
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidateRoots = [
    configuredRoot,
    process.cwd(),
    path.resolve(moduleDir, "../../..")
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const root of candidateRoots) {
    const candidatePath = path.join(root, normalizedRelativePath);
    if (existsSync(candidatePath)) {
      return pathToFileURL(candidatePath);
    }
  }

  return new URL(relativePath, import.meta.url);
}

export function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

export async function loadSchema<T>(relativePath: string): Promise<T> {
  const fileUrl = resolveRuntimeAssetFileUrl(relativePath);
  const cacheKey = fileUrl.toString();
  let cached = schemaCache.get(cacheKey);
  if (!cached) {
    cached = readFile(fileUrl, "utf8").then((fileContent) => JSON.parse(fileContent));
    schemaCache.set(cacheKey, cached);
  }

  return cached as Promise<T>;
}

export async function loadSchemaValidator<T>(relativePath: string): Promise<ValidateFunction<T>> {
  const fileUrl = resolveRuntimeAssetFileUrl(relativePath);
  const cacheKey = fileUrl.toString();
  let cached = schemaValidatorCache.get(cacheKey);
  if (!cached) {
    cached = loadSchema<object>(relativePath).then((schema) => createAjv().compile<T>(schema));
    schemaValidatorCache.set(cacheKey, cached);
  }

  return cached as Promise<ValidateFunction<T>>;
}

function expandEnvInString(input: string): string {
  return input.replaceAll(/\$\{env\.([A-Z0-9_]+)\}/gi, (_match, envName: string) => {
    const value = process.env[envName];
    if (value === undefined) {
      throw new Error(`Environment variable ${envName} is required but not set.`);
    }

    return value;
  });
}

export function expandEnv<T>(value: T): T {
  if (typeof value === "string") {
    return expandEnvInString(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => expandEnv(item)) as T;
  }

  if (value && typeof value === "object") {
    const expandedEntries = Object.entries(value).map(([key, nestedValue]) => [key, expandEnv(nestedValue)]);
    return Object.fromEntries(expandedEntries) as T;
  }

  return value;
}

export function validationMessage(errors: ErrorObject[] | null | undefined): string {
  return errors?.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ") ?? "unknown schema validation error";
}

export function resolvePathInsideRoot(rootPath: string, relativePath: string, label: string): string {
  const resolvedPath = path.resolve(rootPath, relativePath);
  const relative = path.relative(rootPath, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Invalid ${label}: ${relativePath}`);
  }

  return resolvedPath;
}

export function resolveConfigPaths(config: ServerConfig, configPath: string): ServerConfig {
  const configDir = path.dirname(configPath);
  const workspaceDir = path.resolve(configDir, config.paths.workspace_dir);
  const runtimeStateDir = path.resolve(
    configDir,
    config.paths.runtime_state_dir ?? path.join(path.dirname(workspaceDir), ".openharness")
  );
  return {
    ...config,
    storage: {
      ...(config.storage ?? {})
    },
    paths: {
      workspace_dir: workspaceDir,
      runtime_state_dir: runtimeStateDir,
      runtime_dir: path.resolve(configDir, config.paths.runtime_dir),
      model_dir: path.resolve(configDir, config.paths.model_dir),
      tool_dir: path.resolve(configDir, config.paths.tool_dir),
      skill_dir: path.resolve(configDir, config.paths.skill_dir)
    }
  };
}

export function emitConfigDeprecationWarnings(
  config: ServerConfig,
  configPath: string,
  usesLegacyCompatibilityFields: (config: NonNullable<ServerConfig["object_storage"]>) => boolean
) {
  if (typeof config.workers?.standalone?.slots_per_pod === "number") {
    process.emitWarning(
      `workers.standalone.slots_per_pod is deprecated in ${configPath} and ignored by controller sizing; ` +
        "sandbox replica decisions now use observed worker-reported capacity.",
      {
        type: "DeprecationWarning",
        code: "OAH_CONFIG_DEPRECATED_SLOTS_PER_POD"
      }
    );
  }

  if (config.object_storage && usesLegacyCompatibilityFields(config.object_storage)) {
    process.emitWarning(
      `object_storage legacy fields are deprecated in ${configPath}; ` +
        "migrate managed_paths/key_prefixes/sync_on_* to workspace_backing_store and mirrors.",
      {
        type: "DeprecationWarning",
        code: "OAH_CONFIG_DEPRECATED_OBJECT_STORAGE_LEGACY_FIELDS"
      }
    );
  }
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readDirectoryEntriesIfExists(directoryPath: string) {
  if (!(await pathExists(directoryPath))) {
    return [];
  }

  return readdir(directoryPath, { withFileTypes: true });
}

export async function listYamlFilesRecursively(rootPath: string): Promise<string[]> {
  const results: string[] = [];

  async function visit(directoryPath: string): Promise<void> {
    const entries = (await readDirectoryEntriesIfExists(directoryPath)).sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".yaml")) {
        results.push(entryPath);
      }
    }
  }

  await visit(rootPath);
  return results;
}

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

export function mergePlatformModelDefinitions(
  current: PlatformModelDefinition,
  incoming: PlatformModelDefinition
): PlatformModelDefinition {
  const metadata = normalizeModelMetadata({
    ...(current.metadata ?? {}),
    ...(incoming.metadata ?? {})
  });

  return {
    ...current,
    ...incoming,
    ...(metadata ? { metadata } : {})
  };
}

export interface ModelRegistryLoadOptions {
  onError?: ((input: { filePath: string; error: unknown }) => void) | undefined;
}

export async function loadModelRegistryFromDirectory(
  modelsDir: string,
  options?: ModelRegistryLoadOptions
): Promise<PlatformModelRegistry> {
  const schema = await loadSchema<object>("../../../docs/schemas/models.schema.json");
  const modelFiles = await listYamlFilesRecursively(modelsDir);
  const validate = createAjv().compile<PlatformModelRegistry>(schema);
  const registry: PlatformModelRegistry = {};

  for (const filePath of modelFiles) {
    try {
      const fileContent = await readFile(filePath, "utf8");
      const parsed = expandEnv(YAML.parse(fileContent) ?? {});
      if (!validate(parsed)) {
        throw new Error(`Invalid model config in ${filePath}: ${validationMessage(validate.errors)}`);
      }

      for (const [modelName, definition] of Object.entries(parsed)) {
        registry[modelName] = registry[modelName]
          ? mergePlatformModelDefinitions(registry[modelName], definition)
          : normalizePlatformModelDefinition(definition);
      }
    } catch (error) {
      if (!options?.onError) {
        throw error;
      }

      options.onError({
        filePath,
        error
      });
    }
  }

  return registry;
}

export function createWorkspaceCatalog(workspaceId: string, models: ModelCatalogItem[]): DiscoveredWorkspaceCatalog {
  return {
    workspaceId,
    agents: [],
    models,
    actions: [],
    skills: [],
    tools: [],
    hooks: [],
    nativeTools: [],
    engineTools: []
  };
}

export function toAgentCatalogItems(
  agents: Record<string, DiscoveredAgent>,
  sources?: Record<string, "platform" | "workspace">
): AgentCatalogItem[] {
  return Object.values(agents)
    .filter((agent) => agent.hidden !== true)
    .map((agent) => ({
      name: agent.name,
      mode: agent.mode,
      source: sources?.[agent.name] ?? "workspace",
      ...(agent.description ? { description: agent.description } : {})
    }));
}

export function toActionCatalogItems(actions: Record<string, DiscoveredAction>): ActionCatalogItem[] {
  return Object.values(actions).map((action) => ({
    name: action.name,
    description: action.description,
    exposeToLlm: action.exposeToLlm,
    callableByUser: action.callableByUser,
    callableByApi: action.callableByApi,
    ...(action.retryPolicy ? { retryPolicy: action.retryPolicy } : {}),
    ...(action.inputSchema ? { inputSchema: action.inputSchema } : {})
  }));
}

export function toSkillCatalogItems(skills: Record<string, DiscoveredSkill>): SkillCatalogItem[] {
  return Object.values(skills).map((skill) => ({
    name: skill.name,
    ...(skill.description ? { description: skill.description } : {}),
    exposeToLlm: skill.exposeToLlm
  }));
}

export function toToolCatalogItems(toolServers: Record<string, DiscoveredToolServer>): ToolCatalogItem[] {
  return Object.values(toolServers).map((server) => ({
    name: server.name,
    transportType: server.transportType,
    ...(server.toolPrefix ? { toolPrefix: server.toolPrefix } : {})
  }));
}

export function toHookCatalogItems(hooks: Record<string, DiscoveredHook>): HookCatalogItem[] {
  return Object.values(hooks).map((hook) => ({
    name: hook.name,
    ...(hook.matcher ? { matcher: hook.matcher } : {}),
    handlerType: hook.handlerType,
    events: hook.events
  }));
}

export function toPlatformModelCatalogItems(platformModels: PlatformModelRegistry): ModelCatalogItem[] {
  return Object.entries(platformModels).map(([name, definition]) => ({
    ref: `platform/${name}`,
    name,
    source: "platform",
    provider: definition.provider,
    modelName: definition.name,
    ...(definition.url ? { url: definition.url } : {})
  }));
}

export function toWorkspaceModelCatalogItems(workspaceModels: PlatformModelRegistry): ModelCatalogItem[] {
  return Object.entries(workspaceModels).map(([name, definition]) => ({
    ref: `workspace/${name}`,
    name,
    source: "workspace",
    provider: definition.provider,
    modelName: definition.name,
    ...(definition.url ? { url: definition.url } : {})
  }));
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function inferSkillDescription(content: string): string | undefined {
  const lines = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  return lines.at(0);
}

async function resolvePromptSource(promptSource: PromptSource, workspaceRoot: string): Promise<ResolvedPromptSource> {
  if (typeof promptSource.inline === "string") {
    return { content: promptSource.inline };
  }

  if (typeof promptSource.file === "string") {
    const promptFilePath = path.resolve(workspaceRoot, promptSource.file);
    return {
      content: await readFile(promptFilePath, "utf8")
    };
  }

  throw new Error("Prompt source must provide either inline or file.");
}

function isCanonicalModelRef(value: string): boolean {
  return value.startsWith("platform/") || value.startsWith("workspace/");
}

export function resolveWorkspaceModelPreset(
  aliasOrModelRef: string,
  modelAliases: Record<string, WorkspaceModelPreset> | undefined,
  label: string
): WorkspaceModelPreset {
  const candidate = aliasOrModelRef.trim();
  if (candidate.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }

  if (isCanonicalModelRef(candidate)) {
    return { ref: candidate };
  }

  const resolved = modelAliases?.[candidate];
  if (!resolved) {
    throw new Error(`Unknown workspace model alias "${candidate}" in ${label}. Define it under .openharness/settings.yaml models.`);
  }

  if (!isCanonicalModelRef(resolved.ref)) {
    throw new Error(
      `Workspace model alias "${candidate}" in ${label} must resolve to a canonical model ref like platform/<name> or workspace/<name>.`
    );
  }

  return resolved;
}

export async function resolveWorkspaceSystemPrompt(
  systemPrompt: {
    base?: PromptSource;
    llm_optimized?: {
      providers?: Record<string, PromptSource>;
      models?: Record<string, PromptSource>;
    };
    compose?: {
      order?: Array<
        | "base"
        | "llm_optimized"
        | "agent"
        | "actions"
        | "project_agents_md"
        | "skills"
        | "agent_switches"
        | "subagents"
        | "environment"
      >;
      include_environment?: boolean;
    };
  },
  workspaceRoot: string,
  modelAliases?: Record<string, WorkspaceModelPreset>
): Promise<WorkspaceSystemPromptSettings> {
  const providers = systemPrompt.llm_optimized?.providers
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(systemPrompt.llm_optimized.providers).map(async ([provider, promptSource]) => [
            provider,
            await resolvePromptSource(promptSource as PromptSource, workspaceRoot)
          ])
        )
      )
    : undefined;

  const models = systemPrompt.llm_optimized?.models
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(systemPrompt.llm_optimized.models).map(async ([modelAliasOrRef, promptSource]) => [
            resolveWorkspaceModelPreset(modelAliasOrRef, modelAliases, `workspace prompts llm_optimized.models.${modelAliasOrRef}`).ref,
            await resolvePromptSource(promptSource as PromptSource, workspaceRoot)
          ])
        )
      )
    : undefined;

  return {
    ...(systemPrompt.base ? { base: await resolvePromptSource(systemPrompt.base as PromptSource, workspaceRoot) } : {}),
    ...(providers || models
      ? {
          llmOptimized: {
            ...(providers ? { providers } : {}),
            ...(models ? { models } : {})
          }
        }
      : {}),
    compose: {
      order:
        systemPrompt.compose?.order ??
        ["base", "llm_optimized", "agent", "actions", "project_agents_md", "skills", "agent_switches", "subagents", "environment"],
      includeEnvironment: systemPrompt.compose?.include_environment ?? false
    }
  };
}
