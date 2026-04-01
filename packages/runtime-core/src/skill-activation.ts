import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { RuntimeToolSet, SkillDefinition } from "./types.js";

const MAX_SKILL_RESOURCE_ENTRIES = 50;
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".tar",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf"
]);
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".csv",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".sh",
  ".bash",
  ".zsh",
  ".css",
  ".scss",
  ".html",
  ".sql"
]);

interface SkillResourceEntry {
  relativePath: string;
  type: "file" | "directory";
  size?: number | undefined;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function isPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedCandidate = path.resolve(candidatePath);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

function isProbablyTextFile(relativePath: string, buffer: Buffer): boolean {
  const extension = path.extname(relativePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) {
    return true;
  }

  if (BINARY_EXTENSIONS.has(extension) || buffer.includes(0)) {
    return false;
  }

  const sample = buffer.subarray(0, 1024).toString("utf8");
  return !sample.includes("\ufffd");
}

async function listSkillResources(skill: SkillDefinition): Promise<{ resources: SkillResourceEntry[]; truncated: boolean }> {
  const resources: SkillResourceEntry[] = [];
  const pendingDirectories = [skill.directory];
  let truncated = false;

  while (pendingDirectories.length > 0 && !truncated) {
    const currentDirectory = pendingDirectories.shift();
    if (!currentDirectory) {
      continue;
    }

    const entries = await readdir(currentDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = path.join(currentDirectory, entry.name);
      const relativePath = toPosixPath(path.relative(skill.directory, absolutePath));

      if (relativePath === "SKILL.md") {
        continue;
      }

      if (resources.length >= MAX_SKILL_RESOURCE_ENTRIES) {
        truncated = true;
        break;
      }

      if (entry.isDirectory()) {
        resources.push({
          relativePath,
          type: "directory"
        });
        pendingDirectories.push(absolutePath);
        continue;
      }

      if (entry.isFile()) {
        const entryStats = await stat(absolutePath);
        resources.push({
          relativePath,
          type: "file",
          size: entryStats.size
        });
      }
    }
  }

  if (!truncated && pendingDirectories.length > 0) {
    truncated = true;
  }

  return { resources, truncated };
}

async function readSkillResource(skill: SkillDefinition, resourcePath: string): Promise<string | null> {
  const resolvedPath = path.resolve(skill.directory, resourcePath);
  if (!isPathInsideRoot(skill.directory, resolvedPath)) {
    return null;
  }

  const relativePath = toPosixPath(path.relative(skill.directory, resolvedPath));
  if (!relativePath || relativePath === "SKILL.md") {
    return null;
  }

  const resourceStats = await stat(resolvedPath).catch(() => null);
  if (!resourceStats?.isFile()) {
    return null;
  }

  const buffer = await readFile(resolvedPath);
  if (isProbablyTextFile(relativePath, buffer)) {
    return `<skill_resource name="${escapeXml(skill.name)}" path="${escapeXml(relativePath)}">
${buffer.toString("utf8")}
</skill_resource>`;
  }

  return `<skill_resource name="${escapeXml(skill.name)}" path="${escapeXml(relativePath)}" encoding="base64">
${buffer.toString("base64")}
</skill_resource>`;
}

function renderSkillResourcesXml(resources: SkillResourceEntry[], truncated: boolean): string {
  if (resources.length === 0) {
    return "";
  }

  const lines = resources.map((resource) =>
    resource.type === "directory"
      ? `  <directory path="${escapeXml(resource.relativePath)}" />`
      : `  <file path="${escapeXml(resource.relativePath)}" size="${resource.size ?? 0}" />`
  );

  return [
    "<skill_resources>",
    ...lines,
    ...(truncated ? ["  <!-- listing truncated, more files may exist -->"] : []),
    "</skill_resources>"
  ].join("\n");
}

export function buildAvailableSkillsMessage(skills: SkillDefinition[]): string {
  if (skills.length === 0) {
    return "";
  }

  const catalog = skills
    .map((skill) =>
      [
        "  <skill>",
        `    <name>${escapeXml(skill.name)}</name>`,
        ...(skill.description ? [`    <description>${escapeXml(skill.description)}</description>`] : []),
        `    <location>${escapeXml(path.join(skill.directory, "SKILL.md"))}</location>`,
        "  </skill>"
      ].join("\n")
    )
    .join("\n");

  return [
    "## Available Skills",
    "",
    "<available_skills>",
    catalog,
    "</available_skills>",
    "",
    "The skills listed above provide specialized instructions for specific tasks.",
    "When a task matches a skill's description, call `activate_skill` with the skill name to load its full instructions before proceeding.",
    "To read a bundled skill resource, call `activate_skill` again with both the skill name and `resource_path` from the listing.",
    "Do not guess or fabricate skill instructions or resource contents."
  ].join("\n");
}

export function createActivateSkillTool(skills: SkillDefinition[]): RuntimeToolSet {
  return createDynamicActivateSkillTool(() => skills);
}

export function createDynamicActivateSkillTool(getSkills: () => SkillDefinition[]): RuntimeToolSet {
  const inputSchema = z.object({
    name: z.string().min(1).describe("Name of the skill to activate."),
    resource_path: z
      .string()
      .min(1)
      .optional()
      .describe("Relative path of a bundled skill resource to read.")
  });

  return {
    activate_skill: {
      description:
        "Activate a skill or read one of its bundled resource files. Call with only `name` to load the skill, or with both `name` and `resource_path` to read a specific file.",
      inputSchema,
      async execute(rawInput) {
        const { name, resource_path: resourcePath } = inputSchema.parse(rawInput);
        const enabledSkills = getSkills().filter((skill) => skill.exposeToLlm !== false);
        const skillNames = enabledSkills.map((skill) => skill.name);
        const skillsByName = new Map(enabledSkills.map((skill) => [skill.name, skill]));
        const skill = skillsByName.get(name);
        if (!skill) {
          return `Error: Skill "${name}" not found. Available skills: ${skillNames.join(", ")}`;
        }

        if (resourcePath) {
          const resourceContent = await readSkillResource(skill, resourcePath);
          return (
            resourceContent ??
            `Error: Resource "${resourcePath}" not found in skill "${name}". Call activate_skill with just the name to inspect its available resources.`
          );
        }

        const { resources, truncated } = await listSkillResources(skill);
        const resourcesXml = renderSkillResourcesXml(resources, truncated);

        return [
          `<skill_content name="${escapeXml(skill.name)}">`,
          skill.content,
          "",
          `Skill directory: ${skill.directory}`,
          `To read a resource, call activate_skill with name="${skill.name}" and resource_path set to a file path from <skill_resources>.`,
          ...(resourcesXml ? ["", resourcesXml] : []),
          "</skill_content>"
        ].join("\n");
      }
    }
  };
}
