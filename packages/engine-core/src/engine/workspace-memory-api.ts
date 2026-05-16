import path from "node:path";

import type {
  WorkspaceMemoryCorpus,
  WorkspaceMemoryFile,
  WorkspaceMemoryIndex,
  WorkspaceMemoryProposal,
  WorkspaceMemoryProposalActionResult,
  WorkspaceMemoryProposalPage,
  WorkspaceMemoryReadQuery,
  WorkspaceMemoryReadResponse,
  WorkspaceMemorySearchQuery,
  WorkspaceMemorySearchResponse,
  WorkspaceMemoryStatus
} from "@oah/api-contracts";

import { createNativeToolSet } from "../native-tools.js";
import { normalizePathForMatch, resolveWorkspacePath } from "../native-tools/paths.js";
import { AppError } from "../errors.js";
import type { WorkspaceFileSystem, WorkspaceMemoryWritePolicy, WorkspaceRecord } from "../types.js";

const MEMORY_DIRECTORY = ".openharness/memory";
const MEMORY_INDEX_PATH = `${MEMORY_DIRECTORY}/MEMORY.md`;
const MEMORY_PROPOSALS_DIRECTORY = `${MEMORY_DIRECTORY}/proposals`;
const MEMORY_SEARCH_SNIPPET_MAX_CHARS = 220;

interface MemoryFile {
  path: string;
  content: string;
  body: string;
  frontmatter: Record<string, string>;
  mtimeMs: number;
  sizeBytes: number;
}

interface MemoryProposalFile extends MemoryFile {
  status: string;
  tool: string;
  targetPath?: string | undefined;
  createdAt?: string | undefined;
}

function getErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
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
    const value = match[2].trim().replace(/^["']|["']$/gu, "");
    if (value.length > 0) {
      frontmatter[match[1].toLowerCase()] = value;
    }
  }

  return {
    frontmatter,
    body: lines.slice(end + 2).join("\n")
  };
}

function firstMeaningfulLine(content: string): string | undefined {
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line === "---" || line.startsWith("#") || line === "```json" || line === "```") {
      continue;
    }
    return line.replace(/^[-*>\d.\s]+/u, "").trim();
  }

  return undefined;
}

function inferCorpus(memoryPath: string): WorkspaceMemoryCorpus {
  if (memoryPath === MEMORY_INDEX_PATH) {
    return "index";
  }
  if (memoryPath.startsWith(`${MEMORY_DIRECTORY}/topics/`)) {
    return "topics";
  }
  if (memoryPath.startsWith(`${MEMORY_DIRECTORY}/sessions/`)) {
    return "sessions";
  }
  if (memoryPath.startsWith(`${MEMORY_DIRECTORY}/daily/`)) {
    return "daily";
  }
  if (memoryPath.startsWith(`${MEMORY_DIRECTORY}/dreams/`)) {
    return "dreams";
  }
  return "all";
}

function memoryTitle(file: MemoryFile): string {
  return file.frontmatter.name || path.basename(file.path, ".md");
}

function memoryDescription(file: MemoryFile): string | undefined {
  return file.frontmatter.description || firstMeaningfulLine(file.body || file.content);
}

function memoryType(file: MemoryFile): string | undefined {
  return file.frontmatter.type || (inferCorpus(file.path) === "all" ? undefined : inferCorpus(file.path));
}

function toMemoryFileDto(file: MemoryFile): WorkspaceMemoryFile {
  const description = memoryDescription(file);
  const type = memoryType(file);
  return {
    path: file.path,
    corpus: inferCorpus(file.path),
    title: memoryTitle(file),
    ...(description ? { description } : {}),
    ...(type ? { type } : {}),
    sizeBytes: file.sizeBytes,
    updatedAt: new Date(file.mtimeMs).toISOString()
  };
}

function proposalSummary(file: MemoryProposalFile): string | undefined {
  return firstMeaningfulLine(file.body || file.content);
}

function toProposalDto(file: MemoryProposalFile): WorkspaceMemoryProposal {
  const summary = proposalSummary(file);
  return {
    path: file.path,
    status: file.status,
    tool: file.tool,
    ...(file.targetPath ? { targetPath: file.targetPath } : {}),
    ...(file.createdAt ? { createdAt: file.createdAt } : {}),
    ...(summary ? { summary } : {})
  };
}

function tokenize(value: string): string[] {
  return [...new Set((value.toLowerCase().match(/[\p{L}\p{N}._/-]+/gu) ?? []).filter((token) => token.length >= 2))];
}

function scoreFile(file: MemoryFile, query: string): number {
  const tokens = tokenize(query);
  const haystacks = [
    { text: file.path.toLowerCase(), weight: 6 },
    { text: memoryTitle(file).toLowerCase(), weight: 5 },
    { text: (memoryDescription(file) ?? "").toLowerCase(), weight: 4 },
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

function buildSnippet(file: MemoryFile, query: string): string | undefined {
  const tokens = tokenize(query);
  const lines = file.content.replaceAll("\r\n", "\n").split("\n");
  const line =
    lines.find((candidate) => tokens.some((token) => candidate.toLowerCase().includes(token))) ??
    firstMeaningfulLine(file.body || file.content);
  if (!line) {
    return undefined;
  }

  const trimmed = line.trim();
  return trimmed.length > MEMORY_SEARCH_SNIPPET_MAX_CHARS
    ? `${trimmed.slice(0, MEMORY_SEARCH_SNIPPET_MAX_CHARS - 3)}...`
    : trimmed;
}

function matchesCorpus(file: MemoryFile, corpus: WorkspaceMemoryCorpus): boolean {
  return corpus === "all" || inferCorpus(file.path) === corpus;
}

function normalizeMemoryPath(inputPath: string): string {
  return normalizePathForMatch(inputPath.replace(/^\/+/u, ""));
}

function assertMemoryPath(memoryPath: string): void {
  if (memoryPath !== MEMORY_DIRECTORY && !memoryPath.startsWith(`${MEMORY_DIRECTORY}/`)) {
    throw new AppError(403, "workspace_memory_path_not_allowed", "Memory path must be under .openharness/memory.");
  }
  if (!memoryPath.endsWith(".md")) {
    throw new AppError(400, "workspace_memory_file_invalid", "Memory file path must point to a markdown file.");
  }
}

function normalizeProposalPath(inputPath: string): string {
  const normalized = normalizeMemoryPath(inputPath);
  if (normalized.startsWith(`${MEMORY_PROPOSALS_DIRECTORY}/`)) {
    return normalized;
  }
  return normalizePathForMatch(path.join(MEMORY_PROPOSALS_DIRECTORY, normalized));
}

async function walkMarkdownFiles(input: {
  fileSystem: WorkspaceFileSystem;
  root: string;
  relativeRoot?: string | undefined;
  skipProposals?: boolean | undefined;
}): Promise<string[]> {
  const relativeRoot = input.relativeRoot ?? "";
  const absoluteRoot = path.join(input.root, relativeRoot);
  const entries = await input.fileSystem.readdir(absoluteRoot).catch((error) => {
    if (getErrorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  });

  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    if (entry.kind === "directory") {
      if (input.skipProposals && (relativePath === "proposals" || relativePath.startsWith("proposals/"))) {
        continue;
      }
      files.push(...await walkMarkdownFiles({ ...input, relativeRoot: relativePath }));
      continue;
    }
    if (entry.kind === "file" && entry.name.endsWith(".md")) {
      files.push(relativePath);
    }
  }

  return files;
}

async function readMemoryFile(input: {
  fileSystem: WorkspaceFileSystem;
  workspaceRoot: string;
  memoryPath: string;
}): Promise<MemoryFile> {
  const resolved = await resolveWorkspacePath(input.fileSystem, input.workspaceRoot, input.memoryPath);
  assertMemoryPath(resolved.relativePath);
  const stat = await input.fileSystem.stat(resolved.absolutePath);
  if (stat.kind !== "file") {
    throw new AppError(404, "workspace_memory_file_not_found", `Memory file ${input.memoryPath} was not found.`);
  }

  const content = (await input.fileSystem.readFile(resolved.absolutePath)).toString("utf8");
  const parsed = parseFrontmatter(content);
  return {
    path: resolved.relativePath,
    content,
    body: parsed.body,
    frontmatter: parsed.frontmatter,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size
  };
}

async function readMemoryFiles(fileSystem: WorkspaceFileSystem, workspaceRoot: string): Promise<MemoryFile[]> {
  const memoryRoot = path.join(workspaceRoot, MEMORY_DIRECTORY);
  const relativeFiles = await walkMarkdownFiles({
    fileSystem,
    root: memoryRoot,
    skipProposals: true
  });
  const files = await Promise.all(
    relativeFiles.map((relativePath) =>
      readMemoryFile({
        fileSystem,
        workspaceRoot,
        memoryPath: `${MEMORY_DIRECTORY}/${normalizePathForMatch(relativePath)}`
      })
    )
  );
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function readProposalFiles(fileSystem: WorkspaceFileSystem, workspaceRoot: string): Promise<MemoryProposalFile[]> {
  const proposalRoot = path.join(workspaceRoot, MEMORY_PROPOSALS_DIRECTORY);
  const relativeFiles = await walkMarkdownFiles({
    fileSystem,
    root: proposalRoot
  });
  const files = await Promise.all(
    relativeFiles.map(async (relativePath) => {
      const file = await readMemoryFile({
        fileSystem,
        workspaceRoot,
        memoryPath: `${MEMORY_PROPOSALS_DIRECTORY}/${normalizePathForMatch(relativePath)}`
      });
      return {
        ...file,
        status: file.frontmatter.status || "pending",
        tool: file.frontmatter.tool || "unknown",
        targetPath: file.frontmatter.target_path,
        createdAt: file.frontmatter.created_at
      };
    })
  );
  return files.sort((left, right) => {
    const byCreatedAt = (right.createdAt ?? "").localeCompare(left.createdAt ?? "");
    return byCreatedAt !== 0 ? byCreatedAt : left.path.localeCompare(right.path);
  });
}

export async function buildWorkspaceMemoryStatus(input: {
  workspace: WorkspaceRecord;
  fileSystem: WorkspaceFileSystem;
}): Promise<WorkspaceMemoryStatus> {
  const [files, proposals, memoryRoot] = await Promise.all([
    readMemoryFiles(input.fileSystem, input.workspace.rootPath),
    readProposalFiles(input.fileSystem, input.workspace.rootPath),
    input.fileSystem.stat(path.join(input.workspace.rootPath, MEMORY_DIRECTORY)).catch(() => null)
  ]);
  const count = (corpus: WorkspaceMemoryCorpus) => files.filter((file) => matchesCorpus(file, corpus)).length;
  return {
    workspaceId: input.workspace.id,
    enabled: input.workspace.settings.engine?.workspaceMemory?.enabled ?? false,
    writePolicy: input.workspace.settings.engine?.workspaceMemory?.writePolicy ?? "explicit-only",
    rootPath: MEMORY_DIRECTORY,
    rootExists: memoryRoot?.kind === "directory",
    indexExists: files.some((file) => file.path === MEMORY_INDEX_PATH),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    topics: count("topics"),
    sessions: count("sessions"),
    daily: count("daily"),
    dreams: count("dreams"),
    pendingProposals: proposals.filter((proposal) => proposal.status === "pending").length
  };
}

export async function buildWorkspaceMemoryIndex(input: {
  workspace: WorkspaceRecord;
  fileSystem: WorkspaceFileSystem;
}): Promise<WorkspaceMemoryIndex> {
  return {
    workspaceId: input.workspace.id,
    items: (await readMemoryFiles(input.fileSystem, input.workspace.rootPath)).map(toMemoryFileDto)
  };
}

export async function searchWorkspaceMemory(input: {
  workspace: WorkspaceRecord;
  fileSystem: WorkspaceFileSystem;
  query: WorkspaceMemorySearchQuery;
}): Promise<WorkspaceMemorySearchResponse> {
  const ranked = (await readMemoryFiles(input.fileSystem, input.workspace.rootPath))
    .filter((file) => matchesCorpus(file, input.query.corpus))
    .map((file) => ({ file, score: scoreFile(file, input.query.query) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || right.file.mtimeMs - left.file.mtimeMs || left.file.path.localeCompare(right.file.path))
    .slice(0, input.query.maxResults);

  return {
    workspaceId: input.workspace.id,
    query: input.query.query,
    corpus: input.query.corpus,
    items: ranked.map(({ file, score }) => ({
      ...toMemoryFileDto(file),
      score,
      ...(buildSnippet(file, input.query.query) ? { snippet: buildSnippet(file, input.query.query) } : {})
    }))
  };
}

export async function readWorkspaceMemory(input: {
  workspace: WorkspaceRecord;
  fileSystem: WorkspaceFileSystem;
  query: WorkspaceMemoryReadQuery;
}): Promise<WorkspaceMemoryReadResponse> {
  const memoryPath = normalizeMemoryPath(input.query.path);
  assertMemoryPath(memoryPath);
  const file = await readMemoryFile({
    fileSystem: input.fileSystem,
    workspaceRoot: input.workspace.rootPath,
    memoryPath
  });
  const allLines = file.content.replaceAll("\r\n", "\n").split("\n");
  const start = Math.max(0, input.query.from - 1);
  const selected = allLines.slice(start, start + input.query.lines);
  return {
    workspaceId: input.workspace.id,
    path: file.path,
    from: input.query.from,
    returnedLines: selected.length,
    totalLines: allLines.length,
    truncated: start + selected.length < allLines.length,
    content: selected.map((line, index) => `${start + index + 1}: ${line}`).join("\n")
  };
}

export async function listWorkspaceMemoryProposals(input: {
  workspace: WorkspaceRecord;
  fileSystem: WorkspaceFileSystem;
}): Promise<WorkspaceMemoryProposalPage> {
  return {
    workspaceId: input.workspace.id,
    items: (await readProposalFiles(input.fileSystem, input.workspace.rootPath))
      .filter((file) => file.status === "pending")
      .map(toProposalDto)
  };
}

export async function applyWorkspaceMemoryProposal(input: {
  workspace: WorkspaceRecord;
  fileSystem: WorkspaceFileSystem;
  path: string;
}): Promise<WorkspaceMemoryProposalActionResult> {
  const tool = createNativeToolSet(input.workspace.rootPath, () => ["MemoryApplyProposal"], {
    sessionId: "workspace-memory-api",
    fileSystem: input.fileSystem,
    workspace: input.workspace
  }).MemoryApplyProposal;
  const proposalPath = normalizeProposalPath(input.path);
  const output = String(await tool.execute({ path: proposalPath }, {}));
  return {
    workspaceId: input.workspace.id,
    path: proposalPath,
    status: "applied",
    output
  };
}

export async function rejectWorkspaceMemoryProposal(input: {
  workspace: WorkspaceRecord;
  fileSystem: WorkspaceFileSystem;
  path: string;
  reason?: string | undefined;
}): Promise<WorkspaceMemoryProposalActionResult> {
  const tool = createNativeToolSet(input.workspace.rootPath, () => ["MemoryRejectProposal"], {
    sessionId: "workspace-memory-api",
    fileSystem: input.fileSystem,
    workspace: input.workspace
  }).MemoryRejectProposal;
  const proposalPath = normalizeProposalPath(input.path);
  const output = String(await tool.execute({ path: proposalPath, ...(input.reason ? { reason: input.reason } : {}) }, {}));
  return {
    workspaceId: input.workspace.id,
    path: proposalPath,
    status: "rejected",
    output
  };
}

export type { WorkspaceMemoryWritePolicy };
