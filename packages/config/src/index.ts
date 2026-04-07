import { access, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import type {
  ActionCatalogItem,
  AgentCatalogItem,
  HookCatalogItem,
  ModelCatalogItem,
  SkillCatalogItem,
  ToolCatalogItem,
  WorkspaceCatalog
} from "@oah/api-contracts";
import type { ErrorObject } from "ajv";
import matter from "gray-matter";
import YAML from "yaml";

const { Ajv2020 } = await import("ajv/dist/2020.js");
const addFormats = (await import("ajv-formats")).default as unknown as typeof import("ajv-formats").default;

function createAjv() {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false
  });

  addFormats(ajv);
  return ajv;
}

type ActionRetryPolicy = "manual" | "safe";
type DiscoveredWorkspaceCatalog = WorkspaceCatalog;

export interface ServerConfig {
  server: {
    host: string;
    port: number;
  };
  storage: {
    postgres_url?: string | undefined;
    redis_url?: string | undefined;
  };
  paths: {
    workspace_dir: string;
    chat_dir: string;
    template_dir: string;
    model_dir: string;
    tool_dir: string;
    skill_dir: string;
  };
  llm: {
    default_model: string;
  };
}

export interface PlatformModelDefinition {
  provider: string;
  key?: string;
  url?: string;
  name: string;
  metadata?: Record<string, unknown>;
}

export interface DiscoveredSkill {
  name: string;
  description?: string | undefined;
  exposeToLlm: boolean;
  directory: string;
  sourceRoot: string;
  content: string;
}

export interface DiscoveredToolServer {
  name: string;
  enabled: boolean;
  transportType: "stdio" | "http";
  toolPrefix?: string | undefined;
  command?: string | undefined;
  url?: string | undefined;
  environment?: Record<string, string> | undefined;
  headers?: Record<string, string> | undefined;
  timeout?: number | undefined;
  oauth?: boolean | Record<string, unknown> | undefined;
  include?: string[] | undefined;
  exclude?: string[] | undefined;
}

export interface DiscoveredHook {
  name: string;
  events: string[];
  matcher?: string | undefined;
  handlerType: "command" | "http" | "prompt" | "agent";
  capabilities: string[];
  definition: Record<string, unknown>;
}

export interface WorkspaceSettings {
  defaultAgent?: string | undefined;
  skillDirs?: string[] | undefined;
  historyMirrorEnabled?: boolean | undefined;
  systemPrompt?: WorkspaceSystemPromptSettings | undefined;
}

export interface PromptSource {
  inline?: string | undefined;
  file?: string | undefined;
}

export interface ResolvedPromptSource {
  content: string;
}

export interface WorkspaceSystemPromptComposeSettings {
  order: Array<"base" | "llm_optimized" | "agent" | "actions" | "project_agents_md" | "skills">;
  includeEnvironment: boolean;
}

export interface WorkspaceSystemPromptSettings {
  base?: ResolvedPromptSource | undefined;
  llmOptimized?: {
    providers?: Record<string, ResolvedPromptSource> | undefined;
    models?: Record<string, ResolvedPromptSource> | undefined;
  } | undefined;
  compose: WorkspaceSystemPromptComposeSettings;
}

export interface DiscoveredAgent {
  name: string;
  mode: "primary" | "subagent" | "all";
  description?: string | undefined;
  prompt: string;
  systemReminder?: string | undefined;
  modelRef?: string | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  tools: {
    native: string[];
    actions: string[];
    skills: string[];
    external: string[];
  };
  switch: string[];
  subagents: string[];
  policy?: {
    maxSteps?: number | undefined;
    runTimeoutSeconds?: number | undefined;
    toolTimeoutSeconds?: number | undefined;
    parallelToolCalls?: boolean | undefined;
    maxConcurrentSubagents?: number | undefined;
  } | undefined;
}

export interface DiscoveredAction {
  name: string;
  description: string;
  callableByApi: boolean;
  callableByUser: boolean;
  exposeToLlm: boolean;
  retryPolicy?: ActionRetryPolicy | undefined;
  inputSchema?: Record<string, unknown> | undefined;
  directory: string;
  entry: {
    command: string;
    environment?: Record<string, string> | undefined;
    cwd?: string | undefined;
    timeoutSeconds?: number | undefined;
  };
}

export interface DiscoveredWorkspace {
  id: string;
  externalRef?: string | undefined;
  name: string;
  rootPath: string;
  executionPolicy: "local" | "container" | "remote_runner";
  status: "active";
  createdAt: string;
  updatedAt: string;
  kind: "project" | "chat";
  readOnly: boolean;
  historyMirrorEnabled: boolean;
  defaultAgent?: string | undefined;
  projectAgentsMd?: string | undefined;
  settings: WorkspaceSettings;
  workspaceModels: PlatformModelRegistry;
  agents: Record<string, DiscoveredAgent>;
  actions: Record<string, DiscoveredAction>;
  skills: Record<string, DiscoveredSkill>;
  toolServers: Record<string, DiscoveredToolServer>;
  hooks: Record<string, DiscoveredHook>;
  catalog: DiscoveredWorkspaceCatalog;
}

export type PlatformModelRegistry = Record<string, PlatformModelDefinition>;
export type PlatformAgentRegistry = Record<string, DiscoveredAgent>;

export interface WorkspaceTemplateSkill {
  name: string;
  content: string;
}

export interface WorkspaceTemplateDescriptor {
  name: string;
}

export interface InitializeWorkspaceFromTemplateInput {
  templateDir: string;
  templateName: string;
  rootPath: string;
  agentsMd?: string | undefined;
  toolServers?: Record<string, Record<string, unknown>> | undefined;
  skills?: WorkspaceTemplateSkill[] | undefined;
}

async function loadSchema<T>(relativePath: string): Promise<T> {
  const fileUrl = new URL(relativePath, import.meta.url);
  const fileContent = await readFile(fileUrl, "utf8");
  return JSON.parse(fileContent) as T;
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

function expandEnv<T>(value: T): T {
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

function validationMessage(errors: ErrorObject[] | null | undefined): string {
  return (
    errors
      ?.map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ") ?? "unknown schema validation error"
  );
}

function resolvePathInsideRoot(rootPath: string, relativePath: string, label: string): string {
  const resolvedPath = path.resolve(rootPath, relativePath);
  const relative = path.relative(rootPath, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Invalid ${label}: ${relativePath}`);
  }

  return resolvedPath;
}

function resolveConfigPaths(config: ServerConfig, configPath: string): ServerConfig {
  const configDir = path.dirname(configPath);
  return {
    ...config,
    storage: {
      ...(config.storage ?? {})
    },
    paths: {
      workspace_dir: path.resolve(configDir, config.paths.workspace_dir),
      chat_dir: path.resolve(configDir, config.paths.chat_dir),
      template_dir: path.resolve(configDir, config.paths.template_dir),
      model_dir: path.resolve(configDir, config.paths.model_dir),
      tool_dir: path.resolve(configDir, config.paths.tool_dir),
      skill_dir: path.resolve(configDir, config.paths.skill_dir)
    }
  };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readDirectoryEntriesIfExists(directoryPath: string) {
  if (!(await pathExists(directoryPath))) {
    return [];
  }

  return readdir(directoryPath, { withFileTypes: true });
}

async function loadModelRegistryFromDirectory(modelsDir: string): Promise<PlatformModelRegistry> {
  const schema = await loadSchema<object>("../../../docs/schemas/models.schema.json");
  const directoryEntries = await readDirectoryEntriesIfExists(modelsDir);
  const validate = createAjv().compile<PlatformModelRegistry>(schema);
  const registry: PlatformModelRegistry = {};

  for (const entry of directoryEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) {
      continue;
    }

    const filePath = path.join(modelsDir, entry.name);
    const fileContent = await readFile(filePath, "utf8");
    const parsed = expandEnv(YAML.parse(fileContent) ?? {});
    if (!validate(parsed)) {
      throw new Error(`Invalid model config in ${filePath}: ${validationMessage(validate.errors)}`);
    }

    Object.assign(registry, parsed);
  }

  return registry;
}

function createWorkspaceCatalog(workspaceId: string, models: ModelCatalogItem[]): DiscoveredWorkspaceCatalog {
  return {
    workspaceId,
    agents: [],
    models,
    actions: [],
    skills: [],
    tools: [],
    hooks: [],
    nativeTools: []
  };
}

function toAgentCatalogItems(
  agents: Record<string, DiscoveredAgent>,
  sources?: Record<string, "platform" | "workspace">
): AgentCatalogItem[] {
  return Object.values(agents).map((agent) => ({
    name: agent.name,
    mode: agent.mode,
    source: sources?.[agent.name] ?? "workspace",
    ...(agent.description ? { description: agent.description } : {})
  }));
}

function toActionCatalogItems(actions: Record<string, DiscoveredAction>): ActionCatalogItem[] {
  return Object.values(actions).map((action) => ({
    name: action.name,
    description: action.description,
    exposeToLlm: action.exposeToLlm,
    callableByUser: action.callableByUser,
    callableByApi: action.callableByApi,
    ...(action.retryPolicy ? { retryPolicy: action.retryPolicy } : {})
  }));
}

function toSkillCatalogItems(skills: Record<string, DiscoveredSkill>): SkillCatalogItem[] {
  return Object.values(skills).map((skill) => ({
    name: skill.name,
    ...(skill.description ? { description: skill.description } : {}),
    exposeToLlm: skill.exposeToLlm
  }));
}

function toToolCatalogItems(toolServers: Record<string, DiscoveredToolServer>): ToolCatalogItem[] {
  return Object.values(toolServers).map((server) => ({
    name: server.name,
    transportType: server.transportType,
    ...(server.toolPrefix ? { toolPrefix: server.toolPrefix } : {})
  }));
}

function toHookCatalogItems(hooks: Record<string, DiscoveredHook>): HookCatalogItem[] {
  return Object.values(hooks).map((hook) => ({
    name: hook.name,
    ...(hook.matcher ? { matcher: hook.matcher } : {}),
    handlerType: hook.handlerType,
    events: hook.events
  }));
}

function toPlatformModelCatalogItems(platformModels: PlatformModelRegistry): ModelCatalogItem[] {
  return Object.entries(platformModels).map(([name, definition]) => ({
    ref: `platform/${name}`,
    name,
    source: "platform",
    provider: definition.provider,
    modelName: definition.name,
    ...(definition.url ? { url: definition.url } : {})
  }));
}

function toWorkspaceModelCatalogItems(workspaceModels: PlatformModelRegistry): ModelCatalogItem[] {
  return Object.entries(workspaceModels).map(([name, definition]) => ({
    ref: `workspace/${name}`,
    name,
    source: "workspace",
    provider: definition.provider,
    modelName: definition.name,
    ...(definition.url ? { url: definition.url } : {})
  }));
}

function nowIso(): string {
  return new Date().toISOString();
}

function inferSkillDescription(content: string): string | undefined {
  const lines = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  return lines.at(0);
}

function mergeWithPrecedence<T>(primary: Record<string, T>, fallback: Record<string, T>): Record<string, T> {
  return {
    ...primary,
    ...Object.fromEntries(Object.entries(fallback).filter(([name]) => !(name in primary)))
  };
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

async function resolveWorkspaceSystemPrompt(
  systemPrompt: {
    base?: PromptSource;
    llm_optimized?: {
      providers?: Record<string, PromptSource>;
      models?: Record<string, PromptSource>;
    };
    compose?: {
      order?: Array<"base" | "llm_optimized" | "agent" | "actions" | "project_agents_md" | "skills">;
      include_environment?: boolean;
    };
  },
  workspaceRoot: string
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
          Object.entries(systemPrompt.llm_optimized.models).map(async ([modelRef, promptSource]) => [
            modelRef,
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
      order: systemPrompt.compose?.order ?? ["base", "llm_optimized", "agent", "actions", "project_agents_md", "skills"],
      includeEnvironment: systemPrompt.compose?.include_environment ?? false
    }
  };
}

function workspaceIdSuffix(kind: "project" | "chat", rootPath: string): string {
  return createHash("sha1")
    .update(`${kind}\0${path.resolve(rootPath).replaceAll("\\", "/")}`)
    .digest("hex")
    .slice(0, 10);
}

export function buildWorkspaceId(kind: "project" | "chat", name: string, rootPath?: string): string {
  const normalized = normalizeWorkspaceName(name);
  const base = `${kind}_${normalized || "workspace"}`;
  return rootPath ? `${base}_${workspaceIdSuffix(kind, rootPath)}` : base;
}

export function normalizeWorkspaceName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

export function resolveWorkspaceCreationRoot(input: {
  workspaceDir: string;
  name: string;
  rootPath?: string | undefined;
}): string {
  if (input.rootPath) {
    return path.isAbsolute(input.rootPath)
      ? input.rootPath
      : path.resolve(input.workspaceDir, input.rootPath);
  }

  const directoryName = normalizeWorkspaceName(input.name) || "workspace";
  return path.resolve(input.workspaceDir, directoryName);
}

export async function loadServerConfig(configPath: string): Promise<ServerConfig> {
  const [schema, fileContent] = await Promise.all([
    loadSchema<object>("../../../docs/schemas/server-config.schema.json"),
    readFile(configPath, "utf8")
  ]);

  const parsed = YAML.parse(fileContent) ?? {};
  const expanded = expandEnv(parsed);
  const validate = createAjv().compile<ServerConfig>(schema);
  if (!validate(expanded)) {
    throw new Error(`Invalid server config: ${validationMessage(validate.errors)}`);
  }

  return resolveConfigPaths(
    {
      ...expanded,
      server: expanded.server as ServerConfig["server"],
      storage:
        expanded.storage && typeof expanded.storage === "object" && !Array.isArray(expanded.storage)
          ? (expanded.storage as ServerConfig["storage"])
          : {}
    } as ServerConfig,
    configPath
  );
}

export async function loadPlatformModels(modelsDir: string): Promise<PlatformModelRegistry> {
  return loadModelRegistryFromDirectory(modelsDir);
}

async function appendAgentsMd(rootPath: string, agentsMd: string): Promise<void> {
  const agentsPath = path.join(rootPath, "AGENTS.md");
  const appendedContent = agentsMd.trim();
  if (!appendedContent) {
    return;
  }

  const existingContent = (await pathExists(agentsPath)) ? (await readFile(agentsPath, "utf8")).trim() : "";
  const mergedContent = existingContent ? `${existingContent}\n\n${appendedContent}\n` : `${appendedContent}\n`;
  await writeFile(agentsPath, mergedContent, "utf8");
}

async function mergeWorkspaceToolSettings(
  rootPath: string,
  toolServers: Record<string, Record<string, unknown>>
): Promise<void> {
  if (Object.keys(toolServers).length === 0) {
    return;
  }

  const toolsRoot = path.join(rootPath, ".openharness", "tools");
  const settingsPath = path.join(toolsRoot, "settings.yaml");
  await mkdir(toolsRoot, { recursive: true });

  const currentSettingsRaw = (await pathExists(settingsPath)) ? YAML.parse(await readFile(settingsPath, "utf8")) : {};
  if (!currentSettingsRaw || typeof currentSettingsRaw !== "object" || Array.isArray(currentSettingsRaw)) {
    throw new Error(`Invalid existing MCP settings in ${settingsPath}.`);
  }

  await writeFile(
    settingsPath,
    YAML.stringify({
      ...(currentSettingsRaw as Record<string, unknown>),
      ...toolServers
    }),
    "utf8"
  );
}

async function writeWorkspaceSkills(rootPath: string, skills: WorkspaceTemplateSkill[]): Promise<void> {
  if (skills.length === 0) {
    return;
  }

  const skillsRoot = path.join(rootPath, ".openharness", "skills");
  await mkdir(skillsRoot, { recursive: true });

  for (const skill of skills) {
    const skillDirectory = resolvePathInsideRoot(skillsRoot, skill.name, "skill name");
    await rm(skillDirectory, { recursive: true, force: true });
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(path.join(skillDirectory, "SKILL.md"), `${skill.content.trim()}\n`, "utf8");
  }
}

export async function initializeWorkspaceFromTemplate(input: InitializeWorkspaceFromTemplateInput): Promise<void> {
  const templatePath = resolvePathInsideRoot(input.templateDir, input.templateName, "template name");
  const templateStats = await stat(templatePath).catch(() => null);
  if (!templateStats?.isDirectory()) {
    throw new Error(`Workspace template was not found: ${input.templateName}`);
  }

  if (await pathExists(input.rootPath)) {
    throw new Error(`Workspace root already exists: ${input.rootPath}`);
  }

  await mkdir(path.dirname(input.rootPath), { recursive: true });
  await cp(templatePath, input.rootPath, {
    recursive: true,
    force: false,
    errorOnExist: true
  });

  if (input.agentsMd) {
    await appendAgentsMd(input.rootPath, input.agentsMd);
  }

  if (input.toolServers) {
    await mergeWorkspaceToolSettings(input.rootPath, input.toolServers);
  }

  if (input.skills) {
    await writeWorkspaceSkills(input.rootPath, input.skills);
  }
}

export async function listWorkspaceTemplates(templateDir: string): Promise<WorkspaceTemplateDescriptor[]> {
  const directoryEntries = await readDirectoryEntriesIfExists(templateDir);
  return directoryEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function loadWorkspaceSettings(workspaceRoot: string): Promise<WorkspaceSettings> {
  const settingsPath = path.join(workspaceRoot, ".openharness", "settings.yaml");
  if (!(await pathExists(settingsPath))) {
    return {};
  }

  const [schema, fileContent] = await Promise.all([
    loadSchema<object>("../../../docs/schemas/settings.schema.json"),
    readFile(settingsPath, "utf8")
  ]);

  const parsed = expandEnv(YAML.parse(fileContent) ?? {});
  const validate = createAjv().compile<WorkspaceSettings>(schema);
  if (!validate(parsed)) {
    throw new Error(`Invalid workspace settings in ${settingsPath}: ${validationMessage(validate.errors)}`);
  }

  const typedParsed = parsed as {
    default_agent?: string;
    skill_dirs?: string[];
    history_mirror_enabled?: boolean;
    system_prompt?: {
      base?: PromptSource;
      llm_optimized?: {
        providers?: Record<string, PromptSource>;
        models?: Record<string, PromptSource>;
      };
      compose?: {
        order?: Array<"base" | "llm_optimized" | "agent" | "actions" | "project_agents_md" | "skills">;
        include_environment?: boolean;
      };
    };
  };

  return {
    ...(typedParsed.default_agent ? { defaultAgent: typedParsed.default_agent } : {}),
    ...(typedParsed.skill_dirs ? { skillDirs: typedParsed.skill_dirs } : {}),
    ...(typeof typedParsed.history_mirror_enabled === "boolean"
      ? { historyMirrorEnabled: typedParsed.history_mirror_enabled }
      : {}),
    ...(typedParsed.system_prompt
      ? {
          systemPrompt: await resolveWorkspaceSystemPrompt(typedParsed.system_prompt, workspaceRoot)
        }
      : {})
  };
}

export async function updateWorkspaceHistoryMirrorSetting(workspaceRoot: string, enabled: boolean): Promise<void> {
  const settingsPath = path.join(workspaceRoot, ".openharness", "settings.yaml");
  await mkdir(path.dirname(settingsPath), { recursive: true });

  const currentRaw = (await pathExists(settingsPath)) ? YAML.parse(await readFile(settingsPath, "utf8")) : {};
  if (currentRaw !== null && (typeof currentRaw !== "object" || Array.isArray(currentRaw))) {
    throw new Error(`Invalid workspace settings in ${settingsPath}.`);
  }

  await writeFile(
    settingsPath,
    YAML.stringify({
      ...(currentRaw as Record<string, unknown>),
      history_mirror_enabled: enabled
    }),
    "utf8"
  );
}

export async function loadWorkspaceModels(workspaceRoot: string): Promise<PlatformModelRegistry> {
  return loadModelRegistryFromDirectory(path.join(workspaceRoot, ".openharness", "models"));
}

async function loadSkillsFromRoot(skillRoot: string): Promise<Record<string, DiscoveredSkill>> {
  const directoryEntries = await readDirectoryEntriesIfExists(skillRoot);
  const skills: Record<string, DiscoveredSkill> = {};

  for (const entry of directoryEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillDirectory = path.join(skillRoot, entry.name);
    const skillFilePath = path.join(skillDirectory, "SKILL.md");
    if (!(await pathExists(skillFilePath))) {
      continue;
    }

    const fileContent = await readFile(skillFilePath, "utf8");
    const parsed = matter(fileContent);
    const content = parsed.content.trim();
    if (!content) {
      throw new Error(`Skill definition in ${skillFilePath} is missing markdown content.`);
    }

    const frontmatter = parsed.data as Record<string, unknown>;
    const name = typeof frontmatter.name === "string" && frontmatter.name.trim().length > 0 ? frontmatter.name : entry.name;
    if (skills[name]) {
      throw new Error(`Duplicate skill name detected in ${skillRoot}: ${name}`);
    }

    const inferredDescription = inferSkillDescription(content);

    skills[name] = {
      name,
      ...(typeof frontmatter.description === "string"
        ? { description: frontmatter.description }
        : inferredDescription
          ? { description: inferredDescription }
          : {}),
      exposeToLlm: true,
      directory: skillDirectory,
      sourceRoot: skillRoot,
      content
    };
  }

  return skills;
}

export async function loadSkillsFromRoots(skillRoots: string[]): Promise<Record<string, DiscoveredSkill>> {
  const mergedSkills: Record<string, DiscoveredSkill> = {};

  for (const skillRoot of skillRoots) {
    const skills = await loadSkillsFromRoot(skillRoot);
    for (const [name, skill] of Object.entries(skills)) {
      if (mergedSkills[name]) {
        continue;
      }

      mergedSkills[name] = skill;
    }
  }

  return mergedSkills;
}

export async function loadPlatformSkills(skillDir: string): Promise<Record<string, DiscoveredSkill>> {
  return loadSkillsFromRoots([skillDir]);
}

export async function loadProjectAgentsMd(workspaceRoot: string): Promise<string | undefined> {
  const agentsPath = path.join(workspaceRoot, "AGENTS.md");
  if (!(await pathExists(agentsPath))) {
    return undefined;
  }

  return readFile(agentsPath, "utf8");
}

export async function loadWorkspaceToolServers(toolRoot: string): Promise<Record<string, DiscoveredToolServer>> {
  const settingsPath = path.join(toolRoot, "settings.yaml");
  if (!(await pathExists(settingsPath))) {
    return {};
  }

  const [schema, fileContent] = await Promise.all([
    loadSchema<object>("../../../docs/schemas/mcp-settings.schema.json"),
    readFile(settingsPath, "utf8")
  ]);

  const parsed = expandEnv(YAML.parse(fileContent) ?? {});
  const validate = createAjv().compile<Record<string, unknown>>(schema);
  if (!validate(parsed)) {
    throw new Error(`Invalid tool settings in ${settingsPath}: ${validationMessage(validate.errors)}`);
  }

  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).map(([name, rawDefinition]) => {
      const definition = rawDefinition as {
        enabled?: boolean;
        command?: string;
        url?: string;
        environment?: Record<string, string>;
        headers?: Record<string, string>;
        timeout?: number;
        oauth?: boolean | Record<string, unknown>;
        expose?: {
          tool_prefix?: string;
          include?: string[];
          exclude?: string[];
        };
      };

      return [
        name,
        {
          name,
          enabled: definition.enabled !== false,
          transportType: typeof definition.command === "string" ? "stdio" : "http",
          ...(typeof definition.expose?.tool_prefix === "string" ? { toolPrefix: definition.expose.tool_prefix } : {}),
          ...(typeof definition.command === "string" ? { command: definition.command } : {}),
          ...(typeof definition.url === "string" ? { url: definition.url } : {}),
          ...(definition.environment ? { environment: definition.environment } : {}),
          ...(definition.headers ? { headers: definition.headers } : {}),
          ...(typeof definition.timeout === "number" ? { timeout: definition.timeout } : {}),
          ...(definition.oauth !== undefined ? { oauth: definition.oauth } : {}),
          ...(Array.isArray(definition.expose?.include) ? { include: definition.expose.include } : {}),
          ...(Array.isArray(definition.expose?.exclude) ? { exclude: definition.expose.exclude } : {})
        } satisfies DiscoveredToolServer
      ];
    })
  );
}

export async function loadPlatformToolServers(toolDir: string): Promise<Record<string, DiscoveredToolServer>> {
  return loadWorkspaceToolServers(toolDir);
}

export async function loadWorkspaceAgents(workspaceRoot: string): Promise<Record<string, DiscoveredAgent>> {
  const agentsDir = path.join(workspaceRoot, ".openharness", "agents");
  const directoryEntries = await readDirectoryEntriesIfExists(agentsDir);
  const agents: Record<string, DiscoveredAgent> = {};

  for (const entry of directoryEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }

    const filePath = path.join(agentsDir, entry.name);
    const fileContent = await readFile(filePath, "utf8");
    const parsed = matter(fileContent);
    const prompt = parsed.content.trim();
    if (!prompt) {
      throw new Error(`Agent definition in ${filePath} is missing markdown prompt content.`);
    }

    const data = parsed.data as Record<string, unknown>;
    const name = entry.name.replace(/\.md$/u, "");
    const mode =
      data.mode === "primary" || data.mode === "subagent" || data.mode === "all" ? data.mode : "primary";
    const model = data.model && typeof data.model === "object" ? (data.model as Record<string, unknown>) : undefined;
    const tools = data.tools && typeof data.tools === "object" ? (data.tools as Record<string, unknown>) : undefined;
    const policy = data.policy && typeof data.policy === "object" ? (data.policy as Record<string, unknown>) : undefined;

    const externalTools = Array.isArray(tools?.external)
      ? tools.external.filter((item): item is string => typeof item === "string")
      : [];

    agents[name] = {
      name,
      mode,
      ...(typeof data.description === "string" ? { description: data.description } : {}),
      prompt,
      ...(typeof data.system_reminder === "string" ? { systemReminder: data.system_reminder } : {}),
      ...(typeof model?.model_ref === "string" ? { modelRef: model.model_ref } : {}),
      ...(typeof model?.temperature === "number" ? { temperature: model.temperature } : {}),
      ...(typeof model?.max_tokens === "number" ? { maxTokens: model.max_tokens } : {}),
      tools: {
        native: Array.isArray(tools?.native) ? tools.native.filter((item): item is string => typeof item === "string") : [],
        actions: Array.isArray(tools?.actions) ? tools.actions.filter((item): item is string => typeof item === "string") : [],
        skills: Array.isArray(tools?.skills) ? tools.skills.filter((item): item is string => typeof item === "string") : [],
        external: externalTools
      },
      switch: Array.isArray(data.switch) ? data.switch.filter((item): item is string => typeof item === "string") : [],
      subagents: Array.isArray(data.subagents)
        ? data.subagents.filter((item): item is string => typeof item === "string")
        : [],
      ...(policy
        ? {
            policy: {
              ...(typeof policy.max_steps === "number" ? { maxSteps: policy.max_steps } : {}),
              ...(typeof policy.run_timeout_seconds === "number"
                ? { runTimeoutSeconds: policy.run_timeout_seconds }
                : {}),
              ...(typeof policy.tool_timeout_seconds === "number"
                ? { toolTimeoutSeconds: policy.tool_timeout_seconds }
                : {}),
              ...(typeof policy.parallel_tool_calls === "boolean"
                ? { parallelToolCalls: policy.parallel_tool_calls }
                : {}),
              ...(typeof policy.max_concurrent_subagents === "number"
                ? { maxConcurrentSubagents: policy.max_concurrent_subagents }
                : {})
            }
          }
        : {})
    };
  }

  return agents;
}

export async function loadWorkspaceActions(workspaceRoot: string): Promise<Record<string, DiscoveredAction>> {
  const actionsDir = path.join(workspaceRoot, ".openharness", "actions");
  const directoryEntries = await readDirectoryEntriesIfExists(actionsDir);
  const schema = await loadSchema<object>("../../../docs/schemas/action.schema.json");
  const validate = createAjv().compile<Record<string, unknown>>(schema);
  const actions: Record<string, DiscoveredAction> = {};

  for (const entry of directoryEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const actionDirectory = path.join(actionsDir, entry.name);
    const actionFilePath = path.join(actionDirectory, "ACTION.yaml");
    if (!(await pathExists(actionFilePath))) {
      continue;
    }

    const fileContent = await readFile(actionFilePath, "utf8");
    const parsed = expandEnv(YAML.parse(fileContent) ?? {});
    if (!validate(parsed)) {
      throw new Error(`Invalid action config in ${actionFilePath}: ${validationMessage(validate.errors)}`);
    }

    const actionData = parsed as {
      name: string;
      description: string;
      expose?: {
        to_llm?: boolean;
        callable_by_user?: boolean;
        callable_by_api?: boolean;
      };
      recovery?: {
        retry_policy?: ActionRetryPolicy;
      };
      input_schema?: Record<string, unknown>;
      entry: {
        command: string;
        environment?: Record<string, string>;
        cwd?: string;
        timeout_seconds?: number;
      };
    };

    if (actions[actionData.name]) {
      throw new Error(`Duplicate action name detected: ${actionData.name}`);
    }

    actions[actionData.name] = {
      name: actionData.name,
      description: actionData.description,
      callableByApi: actionData.expose?.callable_by_api ?? true,
      callableByUser: actionData.expose?.callable_by_user ?? true,
      exposeToLlm: actionData.expose?.to_llm ?? true,
      ...(actionData.recovery?.retry_policy ? { retryPolicy: actionData.recovery.retry_policy } : {}),
      inputSchema: actionData.input_schema,
      directory: actionDirectory,
      entry: {
        command: actionData.entry.command,
        environment: actionData.entry.environment,
        cwd: actionData.entry.cwd,
        timeoutSeconds: actionData.entry.timeout_seconds
      }
    };
  }

  return actions;
}

export async function loadWorkspaceHooks(workspaceRoot: string): Promise<Record<string, DiscoveredHook>> {
  const hooksDir = path.join(workspaceRoot, ".openharness", "hooks");
  const directoryEntries = await readDirectoryEntriesIfExists(hooksDir);
  const schema = await loadSchema<object>("../../../docs/schemas/hook.schema.json");
  const validate = createAjv().compile<Record<string, unknown>>(schema);
  const hooks: Record<string, DiscoveredHook> = {};

  for (const entry of directoryEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) {
      continue;
    }

    const filePath = path.join(hooksDir, entry.name);
    const fileContent = await readFile(filePath, "utf8");
    const parsed = expandEnv(YAML.parse(fileContent) ?? {});
    if (!validate(parsed)) {
      throw new Error(`Invalid hook config in ${filePath}: ${validationMessage(validate.errors)}`);
    }

    const hook = parsed as {
      name: string;
      events: string[];
      matcher?: string;
      capabilities?: string[];
      handler: {
        type: "command" | "http" | "prompt" | "agent";
      };
    };

    if (hooks[hook.name]) {
      throw new Error(`Duplicate hook name detected: ${hook.name}`);
    }

    hooks[hook.name] = {
      name: hook.name,
      events: hook.events,
      ...(hook.matcher ? { matcher: hook.matcher } : {}),
      handlerType: hook.handler.type,
      capabilities: hook.capabilities ?? [],
      definition: parsed as Record<string, unknown>
    };
  }

  return hooks;
}

function resolveSkillRoots(workspaceRoot: string, settings: WorkspaceSettings, platformSkillDir: string): string[] {
  const workspaceSkillRoot = path.join(workspaceRoot, ".openharness", "skills");
  const configuredSkillRoots = (settings.skillDirs ?? []).map((skillDir) => path.resolve(workspaceRoot, skillDir));
  return [workspaceSkillRoot, ...configuredSkillRoots, platformSkillDir];
}

export async function discoverWorkspace(
  rootPath: string,
  kind: "project" | "chat",
  input: {
    platformModels: PlatformModelRegistry;
    platformAgents?: PlatformAgentRegistry;
    platformSkills?: Record<string, DiscoveredSkill>;
    platformToolServers?: Record<string, DiscoveredToolServer>;
    platformSkillDir?: string;
    platformToolDir?: string;
  }
) {
  const settings = await loadWorkspaceSettings(rootPath);
  const workspaceModels = await loadWorkspaceModels(rootPath);
  const workspaceAgents = await loadWorkspaceAgents(rootPath);
  const agents = input.platformAgents ? mergeWithPrecedence(workspaceAgents, input.platformAgents) : workspaceAgents;
  const agentSources = Object.fromEntries([
    ...Object.keys(input.platformAgents ?? {}).map((name) => [name, "platform" as const]),
    ...Object.keys(workspaceAgents).map((name) => [name, "workspace" as const])
  ]);
  const actions = kind === "chat" ? {} : await loadWorkspaceActions(rootPath);
  const workspaceSkillRoots = [
    path.join(rootPath, ".openharness", "skills"),
    ...(settings.skillDirs ?? []).map((skillDir) => path.resolve(rootPath, skillDir))
  ];
  const discoveredWorkspaceSkills = kind === "chat" ? {} : await loadSkillsFromRoots(workspaceSkillRoots);
  const skills =
    kind === "chat"
      ? {}
      : input.platformSkills
        ? mergeWithPrecedence(discoveredWorkspaceSkills, input.platformSkills)
        : await loadSkillsFromRoots(
            input.platformSkillDir
              ? resolveSkillRoots(rootPath, settings, input.platformSkillDir)
              : [path.join(rootPath, ".openharness", "skills")]
          );
  const discoveredWorkspaceToolServers =
    kind === "chat" ? {} : await loadWorkspaceToolServers(path.join(rootPath, ".openharness", "tools"));
  const toolServers =
    kind === "chat"
      ? {}
      : input.platformToolServers
        ? mergeWithPrecedence(discoveredWorkspaceToolServers, input.platformToolServers)
        : input.platformToolDir
        ? {
            ...discoveredWorkspaceToolServers,
            ...Object.fromEntries(
              Object.entries(await loadPlatformToolServers(input.platformToolDir)).filter(
                ([name]) => !(name in discoveredWorkspaceToolServers)
              )
            )
          }
        : discoveredWorkspaceToolServers;
  const hooks = kind === "chat" ? {} : await loadWorkspaceHooks(rootPath);
  const projectAgentsMd = await loadProjectAgentsMd(rootPath);
  const name = path.basename(rootPath);
  const id = buildWorkspaceId(kind, name, rootPath);
  const models = [...toPlatformModelCatalogItems(input.platformModels), ...toWorkspaceModelCatalogItems(workspaceModels)];
  const timestamp = nowIso();
  const catalog = createWorkspaceCatalog(id, models);
  catalog.agents = toAgentCatalogItems(agents, agentSources);
  catalog.actions = toActionCatalogItems(actions);
  catalog.skills = toSkillCatalogItems(skills);
  catalog.tools = toToolCatalogItems(toolServers);
  catalog.hooks = toHookCatalogItems(hooks);

  return {
    id,
    name,
    rootPath,
    executionPolicy: "local" as const,
    status: "active" as const,
    createdAt: timestamp,
    updatedAt: timestamp,
    kind,
    readOnly: kind === "chat",
    historyMirrorEnabled: kind === "project" ? settings.historyMirrorEnabled ?? false : false,
    defaultAgent: settings.defaultAgent,
    projectAgentsMd,
    settings,
    workspaceModels,
    agents,
    actions,
    skills,
    toolServers,
    hooks,
    catalog
  } satisfies DiscoveredWorkspace;
}

export async function discoverWorkspaces(input: {
  paths: Pick<ServerConfig["paths"], "workspace_dir" | "chat_dir" | "tool_dir" | "skill_dir">;
  platformModels: PlatformModelRegistry;
  platformAgents?: PlatformAgentRegistry;
}): Promise<DiscoveredWorkspace[]> {
  const [platformSkills, platformToolServers] = await Promise.all([
    loadPlatformSkills(input.paths.skill_dir),
    loadPlatformToolServers(input.paths.tool_dir)
  ]);
  const projectEntries = await readDirectoryEntriesIfExists(input.paths.workspace_dir);
  const chatEntries = await readDirectoryEntriesIfExists(input.paths.chat_dir);

  const projects = await Promise.all(
    projectEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        discoverWorkspace(path.join(input.paths.workspace_dir, entry.name), "project", {
          platformModels: input.platformModels,
          ...(input.platformAgents ? { platformAgents: input.platformAgents } : {}),
          platformSkills,
          platformToolServers
        })
      )
  );

  const chats = await Promise.all(
    chatEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        discoverWorkspace(path.join(input.paths.chat_dir, entry.name), "chat", {
          platformModels: input.platformModels,
          ...(input.platformAgents ? { platformAgents: input.platformAgents } : {}),
          platformSkills,
          platformToolServers
        })
      )
  );

  return [...projects, ...chats];
}
