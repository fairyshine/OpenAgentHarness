import path from "node:path";
import { readdir, readFile, realpath, stat } from "node:fs/promises";

import { loadWorkspaceSettings } from "@oah/config";
import { createNativeToolSet } from "@oah/engine-core";

const MEMORY_DIRECTORY = ".openharness/memory";
const MEMORY_INDEX_PATH = `${MEMORY_DIRECTORY}/MEMORY.md`;
const MEMORY_PROPOSALS_DIRECTORY = `${MEMORY_DIRECTORY}/proposals`;
const DEFAULT_SEARCH_LIMIT = 10;

export type MemoryCorpus = "all" | "index" | "topics" | "sessions" | "daily" | "dreams";

export interface MemoryCommandOptions {
  workspace?: string | undefined;
}

interface MemoryFile {
  relativePath: string;
  absolutePath: string;
  content: string;
  mtimeMs: number;
  sizeBytes: number;
  frontmatter: Record<string, string>;
  body: string;
}

interface MemoryProposalFile extends MemoryFile {
  status: string;
  tool: string;
  targetPath: string;
  createdAt: string;
}

function normalizeWorkspacePath(workspace?: string | undefined): string {
  return path.resolve(workspace ?? process.cwd());
}

function normalizeSlash(value: string): string {
  return value.split(path.sep).join("/");
}

async function pathExists(targetPath: string): Promise<boolean> {
  return stat(targetPath).then(() => true, () => false);
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const lines = content.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, body: content };
  }

  const end = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (end < 0) {
    return { frontmatter: {}, body: content };
  }

  const frontmatter: Record<string, string> = {};
  for (const line of lines.slice(1, end + 1)) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/u);
    if (!match?.[1] || !match[2]) {
      continue;
    }
    frontmatter[match[1].toLowerCase()] = match[2].trim().replace(/^["']|["']$/gu, "");
  }

  return {
    frontmatter,
    body: lines.slice(end + 2).join("\n")
  };
}

function firstMeaningfulLine(content: string): string {
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line === "---" || line.startsWith("#")) {
      continue;
    }
    return line.replace(/^[-*>\d.\s]+/u, "").trim();
  }
  return "";
}

function memoryTitle(file: MemoryFile): string {
  return file.frontmatter.name || path.basename(file.relativePath, ".md");
}

function memoryDescription(file: MemoryFile): string {
  return file.frontmatter.description || firstMeaningfulLine(file.body || file.content);
}

function memoryType(file: MemoryFile): string {
  return file.frontmatter.type || inferCorpus(file.relativePath);
}

function proposalSummary(file: MemoryProposalFile): string {
  const firstLine = firstMeaningfulLine(file.body || file.content);
  return firstLine.replace(/^```json$/u, "").trim();
}

function inferCorpus(relativePath: string): MemoryCorpus {
  if (relativePath.startsWith(`${MEMORY_PROPOSALS_DIRECTORY}/`)) {
    return "all";
  }
  if (relativePath === MEMORY_INDEX_PATH) {
    return "index";
  }
  if (relativePath.startsWith(`${MEMORY_DIRECTORY}/topics/`)) {
    return "topics";
  }
  if (relativePath.startsWith(`${MEMORY_DIRECTORY}/sessions/`)) {
    return "sessions";
  }
  if (relativePath.startsWith(`${MEMORY_DIRECTORY}/daily/`)) {
    return "daily";
  }
  if (relativePath.startsWith(`${MEMORY_DIRECTORY}/dreams/`)) {
    return "dreams";
  }
  return "all";
}

function matchesCorpus(file: MemoryFile, corpus: MemoryCorpus): boolean {
  if (corpus === "all") {
    return true;
  }
  return inferCorpus(file.relativePath) === corpus;
}

async function walkMarkdownFiles(root: string, relativeRoot = ""): Promise<string[]> {
  const absoluteRoot = path.join(root, relativeRoot);
  const entries = await readdir(absoluteRoot, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as { code?: string }).code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = relativeRoot ? path.join(relativeRoot, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (normalizeSlash(relativePath) === "proposals" || normalizeSlash(relativePath).startsWith("proposals/")) {
        continue;
      }
      files.push(...await walkMarkdownFiles(root, relativePath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(relativePath);
    }
  }
  return files;
}

async function readMemoryFiles(workspaceRoot: string): Promise<MemoryFile[]> {
  const memoryRoot = path.join(workspaceRoot, MEMORY_DIRECTORY);
  const relativeFiles = await walkMarkdownFiles(memoryRoot);
  const files = await Promise.all(
    relativeFiles.map(async (relativeMemoryPath) => {
      const absolutePath = path.join(memoryRoot, relativeMemoryPath);
      const [content, fileStat] = await Promise.all([readFile(absolutePath, "utf8"), stat(absolutePath)]);
      const parsed = parseFrontmatter(content);
      return {
        relativePath: normalizeSlash(path.join(MEMORY_DIRECTORY, relativeMemoryPath)),
        absolutePath,
        content,
        mtimeMs: fileStat.mtimeMs,
        sizeBytes: fileStat.size,
        frontmatter: parsed.frontmatter,
        body: parsed.body
      };
    })
  );
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function readMemoryProposalFiles(workspaceRoot: string): Promise<MemoryProposalFile[]> {
  const memoryRoot = path.join(workspaceRoot, MEMORY_DIRECTORY);
  const proposalRoot = path.join(memoryRoot, "proposals");
  const relativeFiles = await walkMarkdownFiles(proposalRoot);
  const files = await Promise.all(
    relativeFiles.map(async (relativeProposalPath) => {
      const absolutePath = path.join(proposalRoot, relativeProposalPath);
      const [content, fileStat] = await Promise.all([readFile(absolutePath, "utf8"), stat(absolutePath)]);
      const parsed = parseFrontmatter(content);
      return {
        relativePath: normalizeSlash(path.join(MEMORY_PROPOSALS_DIRECTORY, relativeProposalPath)),
        absolutePath,
        content,
        mtimeMs: fileStat.mtimeMs,
        sizeBytes: fileStat.size,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
        status: parsed.frontmatter.status || "pending",
        tool: parsed.frontmatter.tool || "unknown",
        targetPath: parsed.frontmatter.target_path || "",
        createdAt: parsed.frontmatter.created_at || ""
      };
    })
  );
  return files.sort((left, right) => {
    const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
    return byCreatedAt !== 0 ? byCreatedAt : left.relativePath.localeCompare(right.relativePath);
  });
}

function tokenize(value: string): string[] {
  return [...new Set((value.toLowerCase().match(/[\p{L}\p{N}._/-]+/gu) ?? []).filter((token) => token.length >= 2))];
}

function scoreFile(file: MemoryFile, query: string): number {
  const tokens = tokenize(query);
  const haystacks = [
    { text: file.relativePath.toLowerCase(), weight: 6 },
    { text: memoryTitle(file).toLowerCase(), weight: 5 },
    { text: memoryDescription(file).toLowerCase(), weight: 4 },
    { text: file.body.toLowerCase(), weight: 2 }
  ];
  let score = 0;
  for (const token of tokens) {
    for (const haystack of haystacks) {
      if (haystack.text.includes(token)) {
        score += haystack.weight;
        break;
      }
    }
  }
  return score;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function resolveMemoryFile(workspaceRoot: string, inputPath: string): Promise<string> {
  const memoryRoot = await realpath(path.join(workspaceRoot, MEMORY_DIRECTORY));
  const normalizedInput = inputPath.startsWith(MEMORY_DIRECTORY)
    ? inputPath
    : path.join(MEMORY_DIRECTORY, inputPath);
  const absolutePath = await realpath(path.resolve(workspaceRoot, normalizedInput));
  const relative = path.relative(memoryRoot, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Memory path must be under .openharness/memory.");
  }
  return absolutePath;
}

export async function memoryStatus(options: MemoryCommandOptions = {}): Promise<string> {
  const workspaceRoot = normalizeWorkspacePath(options.workspace);
  const memoryRoot = path.join(workspaceRoot, MEMORY_DIRECTORY);
  const settings = await loadWorkspaceSettings(workspaceRoot);
  const files = await readMemoryFiles(workspaceRoot);
  const proposals = await readMemoryProposalFiles(workspaceRoot);
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  const count = (corpus: MemoryCorpus) => files.filter((file) => matchesCorpus(file, corpus)).length;
  return [
    `workspace: ${workspaceRoot}`,
    `memory_root: ${memoryRoot}`,
    `memory_root_exists: ${await pathExists(memoryRoot)}`,
    `workspace_memory_enabled: ${settings.engine?.workspaceMemory?.enabled ?? false}`,
    `write_policy: ${settings.engine?.workspaceMemory?.writePolicy ?? "explicit-only"}`,
    `files: ${files.length}`,
    `bytes: ${formatBytes(totalBytes)}`,
    `index: ${await pathExists(path.join(workspaceRoot, MEMORY_INDEX_PATH))}`,
    `topics: ${count("topics")}`,
    `sessions: ${count("sessions")}`,
    `daily: ${count("daily")}`,
    `dreams: ${count("dreams")}`,
    `pending_proposals: ${proposals.filter((file) => file.status === "pending").length}`
  ].join("\n");
}

export async function memoryIndex(options: MemoryCommandOptions = {}): Promise<string> {
  const workspaceRoot = normalizeWorkspacePath(options.workspace);
  const files = await readMemoryFiles(workspaceRoot);
  if (files.length === 0) {
    return "No memory files found.";
  }
  return files
    .map((file) => {
      const description = memoryDescription(file);
      return [
        file.relativePath,
        `  type: ${memoryType(file)}`,
        `  title: ${memoryTitle(file)}`,
        ...(description ? [`  description: ${description}`] : []),
        `  updated: ${new Date(file.mtimeMs).toISOString()}`
      ].join("\n");
    })
    .join("\n\n");
}

export async function memorySearch(
  query: string,
  options: MemoryCommandOptions & { corpus?: MemoryCorpus | undefined; maxResults?: number | undefined } = {}
): Promise<string> {
  const workspaceRoot = normalizeWorkspacePath(options.workspace);
  const corpus = options.corpus ?? "all";
  const limit = options.maxResults ?? DEFAULT_SEARCH_LIMIT;
  const ranked = (await readMemoryFiles(workspaceRoot))
    .filter((file) => matchesCorpus(file, corpus))
    .map((file) => ({ file, score: scoreFile(file, query) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || right.file.mtimeMs - left.file.mtimeMs || left.file.relativePath.localeCompare(right.file.relativePath))
    .slice(0, limit);
  if (ranked.length === 0) {
    return "No matching memory files found.";
  }
  return ranked
    .map(({ file, score }) => {
      const description = memoryDescription(file);
      return [
        `${file.relativePath}  score=${score}`,
        `  type: ${memoryType(file)}`,
        `  title: ${memoryTitle(file)}`,
        ...(description ? [`  snippet: ${description}`] : [])
      ].join("\n");
    })
    .join("\n\n");
}

export async function memoryGet(
  inputPath: string,
  options: MemoryCommandOptions & { from?: number | undefined; lines?: number | undefined } = {}
): Promise<string> {
  const workspaceRoot = normalizeWorkspacePath(options.workspace);
  const absolutePath = await resolveMemoryFile(workspaceRoot, inputPath);
  const content = await readFile(absolutePath, "utf8");
  const allLines = content.replaceAll("\r\n", "\n").split("\n");
  const from = options.from ?? 1;
  const limit = options.lines ?? 200;
  const start = Math.max(0, from - 1);
  const selected = allLines.slice(start, start + limit);
  return selected.map((line, index) => `${start + index + 1}: ${line}`).join("\n");
}

export async function memoryProposals(options: MemoryCommandOptions = {}): Promise<string> {
  const workspaceRoot = normalizeWorkspacePath(options.workspace);
  const proposals = (await readMemoryProposalFiles(workspaceRoot)).filter((file) => file.status === "pending");
  if (proposals.length === 0) {
    return "No pending memory proposals found.";
  }

  return proposals
    .map((file) => {
      const summary = proposalSummary(file);
      return [
        file.relativePath,
        `  status: ${file.status}`,
        `  tool: ${file.tool}`,
        ...(file.targetPath ? [`  target: ${file.targetPath}`] : []),
        ...(file.createdAt ? [`  created: ${file.createdAt}`] : []),
        ...(summary ? [`  summary: ${summary}`] : [])
      ].join("\n");
    })
    .join("\n\n");
}

function createMemoryProposalCliTools(workspaceRoot: string) {
  return createNativeToolSet(
    workspaceRoot,
    () => ["MemoryApplyProposal", "MemoryRejectProposal"],
    {
      sessionId: "cli-memory-proposals"
    }
  );
}

export async function memoryApplyProposal(proposalPath: string, options: MemoryCommandOptions = {}): Promise<string> {
  const workspaceRoot = normalizeWorkspacePath(options.workspace);
  const tools = createMemoryProposalCliTools(workspaceRoot);
  const tool = tools.MemoryApplyProposal;
  if (!tool) {
    throw new Error("MemoryApplyProposal tool is unavailable.");
  }

  return String(await tool.execute({ path: proposalPath }, {}));
}

export async function memoryRejectProposal(
  proposalPath: string,
  options: MemoryCommandOptions & { reason?: string | undefined } = {}
): Promise<string> {
  const workspaceRoot = normalizeWorkspacePath(options.workspace);
  const tools = createMemoryProposalCliTools(workspaceRoot);
  const tool = tools.MemoryRejectProposal;
  if (!tool) {
    throw new Error("MemoryRejectProposal tool is unavailable.");
  }

  return String(
    await tool.execute(
      {
        path: proposalPath,
        ...(options.reason ? { reason: options.reason } : {})
      },
      {}
    )
  );
}
