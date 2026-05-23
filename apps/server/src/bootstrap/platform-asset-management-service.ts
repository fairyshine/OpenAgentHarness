import { cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  PlatformAssetList,
  PlatformAssetKind,
  PlatformModelAsset,
  PlatformSkillAsset,
  PlatformToolAsset
} from "@oah/api-contracts";
import type { DiscoveredSkill, DiscoveredToolServer, ServerConfig } from "@oah/config";
import { AppError } from "@oah/engine-core";
import YAML from "yaml";

import type { BootstrappedRuntime } from "./bootstrap-runtime-types.js";

type ConfigWorkspaceModule = Awaited<ReturnType<typeof import("./module-loaders.js").loadConfigWorkspaceModule>>;

const ASSET_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/u;

function assertAssetName(name: string, kind: PlatformAssetKind): void {
  if (!ASSET_NAME_PATTERN.test(name)) {
    throw new AppError(400, "invalid_asset_name", `${kind} asset name contains unsupported characters.`);
  }
}

function resolveAssetPath(rootDir: string, name: string, label: string): string {
  const targetPath = path.resolve(rootDir, name);
  const relative = path.relative(rootDir, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AppError(400, "invalid_asset_name", `Invalid ${label}: ${name}`);
  }
  return targetPath;
}

async function pathExists(targetPath: string): Promise<boolean> {
  return Boolean(await stat(targetPath).catch(() => null));
}

async function copyUploadedDirectory(input: {
  sourceDir: string;
  targetDir: string;
  overwrite?: boolean | undefined;
  requireExisting?: boolean | undefined;
  existsCode: string;
  missingCode: string;
  existsMessage: string;
  missingMessage: string;
}): Promise<void> {
  const targetExists = await pathExists(input.targetDir);
  if (!targetExists && input.requireExisting) {
    throw new AppError(404, input.missingCode, input.missingMessage);
  }
  if (targetExists && !input.overwrite) {
    throw new AppError(409, input.existsCode, input.existsMessage);
  }

  await mkdir(path.dirname(input.targetDir), { recursive: true });
  await rm(input.targetDir, { recursive: true, force: true });
  await cp(input.sourceDir, input.targetDir, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true
  });
}

function toModelAssets(models: Awaited<ReturnType<ConfigWorkspaceModule["loadPlatformModels"]>>): PlatformModelAsset[] {
  return Object.entries(models)
    .map(([id, definition]) => ({
      id,
      provider: definition.provider,
      modelName: definition.name,
      ...(definition.url ? { url: definition.url } : {})
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function toToolAssets(tools: Record<string, DiscoveredToolServer>): PlatformToolAsset[] {
  return Object.values(tools)
    .map((tool) => ({
      name: tool.name,
      transportType: tool.transportType,
      enabled: tool.enabled,
      ...(tool.toolPrefix ? { toolPrefix: tool.toolPrefix } : {})
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function toSkillAssets(skills: Record<string, DiscoveredSkill>): PlatformSkillAsset[] {
  return Object.values(skills)
    .map((skill) => ({
      name: skill.name,
      ...(skill.description ? { description: skill.description } : {}),
      exposeToLlm: skill.exposeToLlm
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function serializeToolDefinition(tool: DiscoveredToolServer): Record<string, unknown> {
  return {
    ...(tool.enabled !== true ? { enabled: tool.enabled } : {}),
    ...(tool.command ? { command: tool.command } : {}),
    ...(tool.url ? { url: tool.url } : {}),
    ...(tool.environment ? { environment: tool.environment } : {}),
    ...(tool.headers ? { headers: tool.headers } : {}),
    ...(typeof tool.timeout === "number" ? { timeout: tool.timeout } : {}),
    ...(tool.oauth !== undefined ? { oauth: tool.oauth } : {}),
    ...(tool.toolPrefix || tool.include || tool.exclude
      ? {
          expose: {
            ...(tool.toolPrefix ? { tool_prefix: tool.toolPrefix } : {}),
            ...(tool.include ? { include: tool.include } : {}),
            ...(tool.exclude ? { exclude: tool.exclude } : {})
          }
        }
      : {})
  };
}

async function validateSingleModelFile(input: {
  loadConfigWorkspaceModule: () => Promise<ConfigWorkspaceModule>;
  yamlBuffer: Buffer;
  assetName: string;
}): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-model-asset-"));
  try {
    const filePath = path.join(tempDir, `${input.assetName}.yaml`);
    await writeFile(filePath, input.yamlBuffer);
    const { loadPlatformModels } = await input.loadConfigWorkspaceModule();
    const models = await loadPlatformModels(tempDir);
    const modelNames = Object.keys(models).sort();
    if (modelNames.length !== 1 || !models[input.assetName]) {
      throw new AppError(
        400,
        "invalid_model_asset",
        `Uploaded model YAML must define exactly one model named "${input.assetName}".`
      );
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function validateToolAsset(input: {
  loadConfigWorkspaceModule: () => Promise<ConfigWorkspaceModule>;
  sourceDir: string;
  assetName: string;
}): Promise<void> {
  const { loadPlatformToolServers } = await input.loadConfigWorkspaceModule();
  const tools = await loadPlatformToolServers(input.sourceDir);
  if (!tools[input.assetName]) {
    throw new AppError(
      400,
      "invalid_tool_asset",
      `Uploaded tool package must define a tool named "${input.assetName}" in settings.yaml.`
    );
  }
}

async function validateSkillAsset(input: {
  loadConfigWorkspaceModule: () => Promise<ConfigWorkspaceModule>;
  sourceDir: string;
  assetName: string;
}): Promise<void> {
  const { loadPlatformSkills } = await input.loadConfigWorkspaceModule();
  const skills = await loadPlatformSkills(input.sourceDir);
  if (!skills[input.assetName]) {
    throw new AppError(
      400,
      "invalid_skill_asset",
      `Uploaded skill package must contain a skill named "${input.assetName}" with SKILL.md.`
    );
  }
}

export function createPlatformAssetManagement(input: {
  config: ServerConfig;
  loadConfigWorkspaceModule: () => Promise<ConfigWorkspaceModule>;
  onPlatformModelsChanged?: (() => Promise<unknown> | unknown) | undefined;
}): Pick<
  BootstrappedRuntime,
  | "listPlatformAssets"
  | "uploadPlatformModelAsset"
  | "deletePlatformModelAsset"
  | "uploadPlatformToolAsset"
  | "deletePlatformToolAsset"
  | "uploadPlatformSkillAsset"
  | "deletePlatformSkillAsset"
> {
  return {
    listPlatformAssets: async (kind): Promise<PlatformAssetList> => {
      const { loadPlatformModels, loadPlatformToolServers, loadPlatformSkills } = await input.loadConfigWorkspaceModule();
      switch (kind) {
        case "runtime":
          throw new AppError(501, "workspace_runtimes_unavailable", "Workspace runtimes are managed by the runtime asset service.");
        case "model":
          return { kind, items: toModelAssets(await loadPlatformModels(input.config.paths.model_dir)) };
        case "tool":
          return { kind, items: toToolAssets(await loadPlatformToolServers(input.config.paths.tool_dir)) };
        case "skill":
          return { kind, items: toSkillAssets(await loadPlatformSkills(input.config.paths.skill_dir)) };
      }
    },

    uploadPlatformModelAsset: async (uploadInput) => {
      assertAssetName(uploadInput.name, "model");
      const targetPath = resolveAssetPath(input.config.paths.model_dir, `${uploadInput.name}.yaml`, "model asset name");
      const targetExists = await pathExists(targetPath);
      if (!targetExists && uploadInput.requireExisting) {
        throw new AppError(404, "model_asset_not_found", `Model asset "${uploadInput.name}" does not exist.`);
      }
      if (targetExists && !uploadInput.overwrite) {
        throw new AppError(409, "model_asset_already_exists", `Model asset "${uploadInput.name}" already exists.`);
      }

      await validateSingleModelFile({
        loadConfigWorkspaceModule: input.loadConfigWorkspaceModule,
        yamlBuffer: uploadInput.yamlBuffer,
        assetName: uploadInput.name
      });
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, uploadInput.yamlBuffer);
      await input.onPlatformModelsChanged?.();
      return { kind: "model", name: uploadInput.name };
    },

    deletePlatformModelAsset: async ({ name }) => {
      assertAssetName(name, "model");
      const targetPath = resolveAssetPath(input.config.paths.model_dir, `${name}.yaml`, "model asset name");
      if (!(await pathExists(targetPath))) {
        throw new AppError(404, "model_asset_not_found", `Model asset "${name}" does not exist.`);
      }
      await rm(targetPath, { force: true });
      await input.onPlatformModelsChanged?.();
    },

    uploadPlatformToolAsset: async (uploadInput) => {
      assertAssetName(uploadInput.name, "tool");
      const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "oah-tool-asset-"));
      try {
        await writeFile(path.join(stagingRoot, "settings.yaml"), YAML.stringify({ [uploadInput.name]: uploadInput.definition }));
        if (uploadInput.serverFiles) {
          const serverRoot = path.join(stagingRoot, "servers", uploadInput.name);
          await mkdir(serverRoot, { recursive: true });
          for (const [relativePath, content] of Object.entries(uploadInput.serverFiles)) {
            const targetPath = resolveAssetPath(serverRoot, relativePath, "tool server file path");
            await mkdir(path.dirname(targetPath), { recursive: true });
            await writeFile(targetPath, content);
          }
        }
        await validateToolAsset({
          loadConfigWorkspaceModule: input.loadConfigWorkspaceModule,
          sourceDir: stagingRoot,
          assetName: uploadInput.name
        });

        const { loadPlatformToolServers } = await input.loadConfigWorkspaceModule();
        const tools = await loadPlatformToolServers(input.config.paths.tool_dir);
        const toolExists = Boolean(tools[uploadInput.name]);
        if (!toolExists && uploadInput.requireExisting) {
          throw new AppError(404, "tool_asset_not_found", `Tool asset "${uploadInput.name}" does not exist.`);
        }
        if (toolExists && !uploadInput.overwrite) {
          throw new AppError(409, "tool_asset_already_exists", `Tool asset "${uploadInput.name}" already exists.`);
        }

        const settingsPath = path.join(input.config.paths.tool_dir, "settings.yaml");
        await mkdir(input.config.paths.tool_dir, { recursive: true });
        await writeFile(
          settingsPath,
          YAML.stringify({
            ...Object.fromEntries(Object.entries(tools).map(([toolName, tool]) => [toolName, serializeToolDefinition(tool)])),
            [uploadInput.name]: uploadInput.definition
          }),
          "utf8"
        );

        const targetServerRoot = path.join(input.config.paths.tool_dir, "servers", uploadInput.name);
        await rm(targetServerRoot, { recursive: true, force: true });
        if (uploadInput.serverFiles) {
          await mkdir(path.dirname(targetServerRoot), { recursive: true });
          await cp(path.join(stagingRoot, "servers", uploadInput.name), targetServerRoot, {
            recursive: true,
            force: false,
            errorOnExist: true,
            preserveTimestamps: true
          });
        }
        return { kind: "tool", name: uploadInput.name };
      } finally {
        await rm(stagingRoot, { recursive: true, force: true });
      }
    },

    deletePlatformToolAsset: async ({ name }) => {
      assertAssetName(name, "tool");
      const { loadPlatformToolServers } = await input.loadConfigWorkspaceModule();
      const tools = await loadPlatformToolServers(input.config.paths.tool_dir);
      if (!tools[name]) {
        throw new AppError(404, "tool_asset_not_found", `Tool asset "${name}" does not exist.`);
      }

      const settingsPath = path.join(input.config.paths.tool_dir, "settings.yaml");
      const nextSettings = Object.fromEntries(
        Object.entries(tools)
          .filter(([toolName]) => toolName !== name)
          .map(([toolName, tool]) => [toolName, serializeToolDefinition(tool)])
      );
      await writeFile(settingsPath, YAML.stringify(nextSettings), "utf8");
      await rm(path.join(input.config.paths.tool_dir, "servers", name), { recursive: true, force: true });
    },

    uploadPlatformSkillAsset: async (uploadInput) => {
      assertAssetName(uploadInput.name, "skill");
      const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "oah-skill-asset-"));
      try {
        const skillDir = path.join(stagingRoot, uploadInput.name);
        await mkdir(skillDir, { recursive: true });
        await writeFile(path.join(skillDir, "SKILL.md"), uploadInput.skillMarkdown);
        if (uploadInput.files) {
          for (const [relativePath, content] of Object.entries(uploadInput.files)) {
            if (relativePath === "SKILL.md") {
              continue;
            }
            const targetPath = resolveAssetPath(skillDir, relativePath, "skill file path");
            await mkdir(path.dirname(targetPath), { recursive: true });
            await writeFile(targetPath, content);
          }
        }
        await validateSkillAsset({
          loadConfigWorkspaceModule: input.loadConfigWorkspaceModule,
          sourceDir: stagingRoot,
          assetName: uploadInput.name
        });
        await copyUploadedDirectory({
          sourceDir: skillDir,
          targetDir: resolveAssetPath(input.config.paths.skill_dir, uploadInput.name, "skill asset name"),
          overwrite: uploadInput.overwrite,
          requireExisting: uploadInput.requireExisting,
          existsCode: "skill_asset_already_exists",
          missingCode: "skill_asset_not_found",
          existsMessage: `Skill asset "${uploadInput.name}" already exists.`,
          missingMessage: `Skill asset "${uploadInput.name}" does not exist.`
        });
        return { kind: "skill", name: uploadInput.name };
      } finally {
        await rm(stagingRoot, { recursive: true, force: true });
      }
    },

    deletePlatformSkillAsset: async ({ name }) => {
      assertAssetName(name, "skill");
      const targetDir = resolveAssetPath(input.config.paths.skill_dir, name, "skill asset name");
      if (!(await pathExists(targetDir))) {
        throw new AppError(404, "skill_asset_not_found", `Skill asset "${name}" does not exist.`);
      }
      await rm(targetDir, { recursive: true, force: true });
    }
  };
}
