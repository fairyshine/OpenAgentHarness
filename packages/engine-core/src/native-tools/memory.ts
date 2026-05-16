import path from "node:path";

import { z } from "zod";

import { formatToolOutput } from "../capabilities/tool-output.js";
import {
  parseWorkspaceMemoryTopicFile,
  scoreWorkspaceMemoryTopic,
  tokenizeWorkspaceMemoryRecallText,
  type WorkspaceMemoryTopicFile
} from "../engine/workspace-memory-recall.js";
import { resolveEffectiveWorkspaceMemoryWritePolicy as resolveWorkspaceMemoryWritePolicyForRun } from "../engine/workspace-memory-policy.js";
import { WORKSPACE_MEMORY_TYPES } from "../engine/workspace-memory-taxonomy.js";
import { AppError } from "../errors.js";
import type { EngineToolSet, WorkspaceFileSystem, WorkspaceMemoryWritePolicy, WorkspaceRecord } from "../types.js";
import { DEFAULT_READ_LIMIT } from "./constants.js";
import { ensureParentDirectory, formatReadLines } from "./fs-utils.js";
import { normalizePathForMatch, resolveWorkspacePath } from "./paths.js";
import { getNativeToolRetryPolicy, type NativeToolFactoryContext } from "./types.js";

const WORKSPACE_MEMORY_DIRECTORY = ".openharness/memory";
const WORKSPACE_MEMORY_INDEX_PATH = `${WORKSPACE_MEMORY_DIRECTORY}/MEMORY.md`;
const WORKSPACE_MEMORY_PROPOSALS_DIRECTORY = `${WORKSPACE_MEMORY_DIRECTORY}/proposals`;
const MEMORY_SEARCH_DEFAULT_MAX_RESULTS = 8;
const MEMORY_SEARCH_MAX_RESULTS = 20;
const MEMORY_SEARCH_SNIPPET_MAX_CHARS = 220;
const MEMORY_TITLE_MAX_CHARS = 120;
const MEMORY_DESCRIPTION_MAX_CHARS = 220;
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/u,
  /\bghp_[A-Za-z0-9]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/iu
] as const;

const MEMORY_SEARCH_DESCRIPTION = `Search workspace memory stored under .openharness/memory.

Usage:
- Use this before answering questions about prior decisions, user preferences, feedback, project background, references, previous sessions, or daily work logs
- Search results are summaries and snippets; call MemoryRead for the relevant files before relying on details
- Memory is durable historical context, not proof of current repository state`;

const MEMORY_READ_DESCRIPTION = `Read a bounded excerpt from a workspace memory file.

Usage:
- Paths must be under .openharness/memory
- Use this after MemorySearch to inspect exact memory content
- Results are returned with line numbers starting at 1
- Treat memory as historical context and verify current code facts against the workspace`;

const MEMORY_REMEMBER_DESCRIPTION = `Write a durable workspace memory when the user explicitly asks to remember something.

Usage:
- Use only for durable user preferences, feedback, project decisions, constraints, or external references
- Do not save secrets, tokens, private keys, raw logs, or transient task state
- Writes are limited to .openharness/memory/topics and update MEMORY.md as a concise index`;

const MEMORY_UPDATE_DESCRIPTION = `Update an existing workspace memory file with an exact text replacement.

Usage:
- Use after MemoryRead when an existing memory needs correction
- Paths must be under .openharness/memory
- Prefer exact, small replacements over broad rewrites`;

const MEMORY_FORGET_DESCRIPTION = `Forget a workspace memory by deleting a memory file or removing exact text from it.

Usage:
- Use when the user explicitly asks to forget or remove memory
- Paths must be under .openharness/memory
- Prefer exact path deletion or exact text removal`;

const MEMORY_CAPTURE_SESSION_DESCRIPTION = `Capture a bounded session or run summary into .openharness/memory/sessions.

Usage:
- Use near session boundaries, before compaction, or when the user asks to preserve current working context
- This is lower-weight material than topics/*.md and should be concise
- Include goals, key instructions, completed work, findings, open follow-ups, and relevant files`;

const MEMORY_APPEND_DAILY_DESCRIPTION = `Append a low-weight workspace work log entry under .openharness/memory/daily.

Usage:
- Use for day-level progress notes, observations, and lightweight continuity
- Do not use daily logs for durable preferences or decisions that belong in topics/*.md
- Daily logs are searchable historical material and should not be injected as startup context`;

const MEMORY_RECORD_DREAM_DESCRIPTION = `Record a memory consolidation review note in .openharness/memory/dreams/DREAMS.md.

Usage:
- Use for proposed promotions, duplicate cleanup, conflicts, or stale memory review notes
- This records review material only; it does not directly modify topics/*.md
- Keep recommendations concise and auditable`;

const MEMORY_APPLY_PROPOSAL_DESCRIPTION = `Apply a pending memory proposal created under .openharness/memory/proposals.

Usage:
- Use only after the user explicitly confirms a pending memory proposal
- Reads proposal_json from the proposal file, applies the original memory write, and marks the proposal as applied
- Does not re-enter confirm-suggested proposal mode`;

const MEMORY_REJECT_PROPOSAL_DESCRIPTION = `Reject a pending memory proposal created under .openharness/memory/proposals.

Usage:
- Use when the user declines or cancels a suggested memory write
- Marks the proposal as rejected without modifying target memory files`;

const MemorySearchInputSchema = z
  .object({
    query: z.string().min(1).describe("Search query for workspace memory"),
    maxResults: z.number().int().positive().max(MEMORY_SEARCH_MAX_RESULTS).optional().describe("Maximum number of results to return"),
    corpus: z.enum(["all", "index", "topics", "sessions", "daily", "dreams"]).optional().describe("Memory corpus to search")
  })
  .strict();

const MemoryReadInputSchema = z
  .object({
    path: z.string().min(1).describe("Memory file path under .openharness/memory"),
    from: z.number().int().positive().optional().describe("Line number to start reading from"),
    lines: z.number().int().positive().optional().describe("Number of lines to read")
  })
  .strict();

const MemoryTypeSchema = z.enum(WORKSPACE_MEMORY_TYPES);

const MemoryRememberInputSchema = z
  .object({
    type: MemoryTypeSchema.describe("Memory type"),
    title: z.string().min(1).max(MEMORY_TITLE_MAX_CHARS).describe("Short memory title"),
    content: z.string().min(1).describe("Durable memory content"),
    description: z.string().min(1).max(MEMORY_DESCRIPTION_MAX_CHARS).optional().describe("One-line memory summary"),
    path: z.string().min(1).optional().describe("Optional target path under .openharness/memory/topics")
  })
  .strict();

const MemoryUpdateInputSchema = z
  .object({
    path: z.string().min(1).describe("Memory file path under .openharness/memory"),
    oldText: z.string().min(1).describe("Exact text to replace"),
    newText: z.string().describe("Replacement text")
  })
  .strict();

const MemoryForgetInputSchema = z
  .object({
    path: z.string().min(1).optional().describe("Memory file path under .openharness/memory"),
    text: z.string().min(1).optional().describe("Exact text to remove from the memory file"),
    query: z.string().min(1).optional().describe("Query to locate candidate memories when path is not known")
  })
  .strict()
  .refine((input) => Boolean(input.path || input.query), {
    message: "MemoryForget requires path or query."
  });

const MemoryCaptureSessionInputSchema = z
  .object({
    title: z.string().min(1).max(MEMORY_TITLE_MAX_CHARS).describe("Short session summary title"),
    summary: z.string().min(1).describe("Concise session or run summary"),
    sessionId: z.string().min(1).optional().describe("Session id to record in frontmatter"),
    runId: z.string().min(1).optional().describe("Run id to record in frontmatter"),
    reason: z.string().min(1).max(MEMORY_DESCRIPTION_MAX_CHARS).optional().describe("Why this capture is being made"),
    path: z.string().min(1).optional().describe("Optional target path under .openharness/memory/sessions")
  })
  .strict();

const MemoryAppendDailyInputSchema = z
  .object({
    content: z.string().min(1).describe("Daily work log entry content"),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional().describe("Date in YYYY-MM-DD format; defaults to today"),
    title: z.string().min(1).max(MEMORY_TITLE_MAX_CHARS).optional().describe("Optional heading for this entry")
  })
  .strict();

const MemoryRecordDreamInputSchema = z
  .object({
    title: z.string().min(1).max(MEMORY_TITLE_MAX_CHARS).describe("Short review title"),
    recommendation: z.string().min(1).describe("Consolidation, promotion, cleanup, or review recommendation"),
    sourcePaths: z.array(z.string().min(1)).optional().describe("Memory files considered as sources"),
    targetPath: z.string().min(1).optional().describe("Suggested target memory path, if any")
  })
  .strict();

const MemoryApplyProposalInputSchema = z
  .object({
    path: z.string().min(1).describe("Pending proposal path under .openharness/memory/proposals")
  })
  .strict();

const MemoryRejectProposalInputSchema = z
  .object({
    path: z.string().min(1).describe("Pending proposal path under .openharness/memory/proposals"),
    reason: z.string().min(1).max(MEMORY_DESCRIPTION_MAX_CHARS).optional().describe("Optional rejection reason")
  })
  .strict();

interface MemoryFile {
  path: string;
  rawContent: string;
  mtimeMs: number;
  topic?: WorkspaceMemoryTopicFile | undefined;
}

interface MemoryProposalFile {
  absolutePath: string;
  relativePath: string;
  rawContent: string;
  frontmatter: Record<string, string>;
  proposalJson: unknown;
}

function getErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }

  return undefined;
}

function normalizeMemoryPath(inputPath: string): string {
  return normalizePathForMatch(inputPath.replace(/^\/+/u, ""));
}

function resolveWorkspaceMemoryWritePolicy(workspace?: WorkspaceRecord | undefined): WorkspaceMemoryWritePolicy {
  return workspace?.settings.engine?.workspaceMemory?.writePolicy ?? "explicit-only";
}

function resolveEffectiveWorkspaceMemoryWritePolicy(context: NativeToolFactoryContext): WorkspaceMemoryWritePolicy {
  return resolveWorkspaceMemoryWritePolicyForRun({
    workspace: context.options?.workspace,
    agentName: context.options?.getActiveAgentName?.(),
    session: context.options?.session,
    run: context.options?.run
  });
}

function memoryWriteRequiresConfirmationForContext(context: NativeToolFactoryContext): boolean {
  return resolveEffectiveWorkspaceMemoryWritePolicy(context) === "confirm-suggested";
}

function memoryProposalId(tool: string, targetPath?: string | undefined): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14);
  const targetSlug = slugifyMemoryTitle(targetPath ?? tool);
  return `${timestamp}-${slugifyMemoryTitle(tool)}-${targetSlug}`;
}

function buildMemoryProposalContent(input: {
  id: string;
  tool: string;
  targetPath?: string | undefined;
  proposal: unknown;
  createdAt: string;
  workspace?: WorkspaceRecord | undefined;
  writePolicy?: WorkspaceMemoryWritePolicy | undefined;
}): string {
  return [
    "---",
    `id: ${escapeFrontmatterValue(input.id)}`,
    `status: "pending"`,
    `tool: ${escapeFrontmatterValue(input.tool)}`,
    ...(input.targetPath ? [`target_path: ${escapeFrontmatterValue(input.targetPath)}`] : []),
    `write_policy: ${escapeFrontmatterValue(input.writePolicy ?? resolveWorkspaceMemoryWritePolicy(input.workspace))}`,
    `created_at: ${escapeFrontmatterValue(input.createdAt)}`,
    "---",
    "",
    `# Memory Proposal ${input.id}`,
    "",
    "```json",
    JSON.stringify(input.proposal, null, 2),
    "```",
    ""
  ].join("\n");
}

async function reserveMemoryProposalPath(input: {
  fileSystem: WorkspaceFileSystem;
  workspaceRoot: string;
  proposalId: string;
  toolName: string;
}): Promise<{ proposalId: string; proposalPath: string; absolutePath: string }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const proposalId = attempt === 0 ? input.proposalId : `${input.proposalId}-${attempt + 1}`;
    const proposalPath = `${WORKSPACE_MEMORY_PROPOSALS_DIRECTORY}/${proposalId}.md`;
    const resolved = await resolveWorkspacePath(input.fileSystem, input.workspaceRoot, proposalPath);
    assertMarkdownMemoryFile(resolved.relativePath, input.toolName);
    if (!resolved.relativePath.startsWith(`${WORKSPACE_MEMORY_PROPOSALS_DIRECTORY}/`)) {
      throw new AppError(403, "native_tool_memory_path_not_allowed", `${input.toolName} can only write memory proposals under .openharness/memory/proposals.`);
    }

    const existing = await input.fileSystem.stat(resolved.absolutePath).catch(() => null);
    if (!existing) {
      return {
        proposalId,
        proposalPath: resolved.relativePath,
        absolutePath: resolved.absolutePath
      };
    }
  }

  throw new AppError(409, "native_tool_memory_proposal_conflict", `${input.toolName} could not reserve a unique memory proposal path.`);
}

async function writeMemoryProposal(input: {
  fileSystem: WorkspaceFileSystem;
  workspaceRoot: string;
  tool: string;
  targetPath?: string | undefined;
  proposal: unknown;
  workspace?: WorkspaceRecord | undefined;
  writePolicy?: WorkspaceMemoryWritePolicy | undefined;
}): Promise<{ proposalId: string; proposalPath: string }> {
  const reserved = await reserveMemoryProposalPath({
    fileSystem: input.fileSystem,
    workspaceRoot: input.workspaceRoot,
    proposalId: memoryProposalId(input.tool, input.targetPath),
    toolName: input.tool
  });

  await ensureParentDirectory(input.fileSystem, reserved.absolutePath);
  await input.fileSystem.writeFile(
    reserved.absolutePath,
    Buffer.from(
      buildMemoryProposalContent({
        id: reserved.proposalId,
        tool: input.tool,
        targetPath: input.targetPath,
        proposal: input.proposal,
        createdAt: new Date().toISOString(),
        workspace: input.workspace,
        writePolicy: input.writePolicy
      }),
      "utf8"
    )
  );

  return {
    proposalId: reserved.proposalId,
    proposalPath: reserved.proposalPath
  };
}

async function formatMemoryProposal(input: {
  fileSystem: WorkspaceFileSystem;
  workspaceRoot: string;
  tool: string;
  targetPath?: string | undefined;
  proposal: unknown;
  workspace?: WorkspaceRecord | undefined;
  writePolicy?: WorkspaceMemoryWritePolicy | undefined;
}): Promise<string> {
  const { proposalId, proposalPath } = await writeMemoryProposal(input);
  return formatToolOutput(
    [
      ["pending", true],
      ["requires_confirmation", true],
      ["tool", input.tool],
      ["target_path", input.targetPath],
      ["proposal_id", proposalId],
      ["proposal_path", proposalPath],
      ["write_policy", input.writePolicy ?? resolveWorkspaceMemoryWritePolicy(input.workspace)]
    ],
    [
      {
        title: "proposal_json",
        lines: JSON.stringify(input.proposal, null, 2).split("\n")
      }
    ]
  );
}

async function createPendingMemoryProposal(
  context: NativeToolFactoryContext,
  input: {
    tool: string;
    targetPath?: string | undefined;
    proposal: unknown;
  }
): Promise<string> {
  return context.withFileSystem("write", WORKSPACE_MEMORY_PROPOSALS_DIRECTORY, async ({ workspaceRoot, fileSystem, workspace }) => {
    if (workspace?.readOnly) {
      throw new AppError(403, "native_tool_memory_read_only", `${input.tool} cannot write in a read-only workspace.`);
    }

    return formatMemoryProposal({
      fileSystem,
      workspaceRoot,
      tool: input.tool,
      targetPath: input.targetPath,
      proposal: input.proposal,
      workspace,
      writePolicy: resolveEffectiveWorkspaceMemoryWritePolicy(context)
    });
  });
}

function slugifyMemoryTitle(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 72);
  return slug || "memory";
}

function escapeFrontmatterValue(value: string): string {
  return JSON.stringify(value.replace(/\r?\n/gu, " ").trim());
}

function assertNoMemorySecrets(value: string, toolName: string): void {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new AppError(
      400,
      "native_tool_memory_secret_detected",
      `${toolName} refused to write memory content that appears to contain a secret.`
    );
  }
}

function assertNoMemorySecretsInJson(value: unknown, toolName: string): void {
  if (typeof value === "string") {
    assertNoMemorySecrets(value, toolName);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoMemorySecretsInJson(item, toolName);
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      assertNoMemorySecretsInJson(item, toolName);
    }
  }
}

function buildMemoryTopicContent(input: z.infer<typeof MemoryRememberInputSchema>): string {
  const description = input.description?.trim() || input.content.trim().split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim() || input.title;
  return [
    "---",
    `name: ${escapeFrontmatterValue(input.title)}`,
    `description: ${escapeFrontmatterValue(description)}`,
    `type: ${input.type}`,
    "---",
    "",
    input.content.trim(),
    ""
  ].join("\n");
}

function parseMemoryFrontmatter(content: string): { attributes: Record<string, string>; body: string } {
  const lines = content.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") {
    return {
      attributes: {},
      body: content
    };
  }

  const endIndex = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (endIndex < 0) {
    return {
      attributes: {},
      body: content
    };
  }

  const attributes: Record<string, string> = {};
  for (const line of lines.slice(1, endIndex + 1)) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/u);
    if (!match?.[1] || !match[2]) {
      continue;
    }

    const value = match[2].trim().replace(/^["']|["']$/gu, "");
    if (value.length > 0) {
      attributes[match[1].toLowerCase()] = value;
    }
  }

  return {
    attributes,
    body: lines.slice(endIndex + 2).join("\n")
  };
}

function extractJsonFence(content: string): unknown {
  const match = content.match(/```json\s*([\s\S]*?)\s*```/u);
  if (!match?.[1]) {
    throw new AppError(400, "native_tool_memory_proposal_invalid", "Memory proposal does not contain proposal_json.");
  }

  try {
    return JSON.parse(match[1]);
  } catch {
    throw new AppError(400, "native_tool_memory_proposal_invalid", "Memory proposal contains invalid proposal_json.");
  }
}

function updateMemoryProposalStatus(content: string, input: { status: "applied" | "rejected"; timestamp: string; reason?: string | undefined }): string {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  if (lines[0]?.trim() !== "---") {
    throw new AppError(400, "native_tool_memory_proposal_invalid", "Memory proposal frontmatter is missing.");
  }

  const endIndex = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (endIndex < 0) {
    throw new AppError(400, "native_tool_memory_proposal_invalid", "Memory proposal frontmatter is not closed.");
  }

  const frontmatterEndIndex = endIndex + 1;
  const frontmatterLines = lines.slice(1, frontmatterEndIndex);
  const bodyLines = lines.slice(frontmatterEndIndex);
  const nextFrontmatter: string[] = [];
  const replaced = new Set<string>();

  for (const line of frontmatterLines) {
    const key = line.match(/^([A-Za-z0-9_-]+)\s*:/u)?.[1]?.toLowerCase();
    if (key === "status") {
      nextFrontmatter.push(`status: ${escapeFrontmatterValue(input.status)}`);
      replaced.add("status");
      continue;
    }
    if (key === "applied_at" || key === "rejected_at" || key === "rejection_reason") {
      continue;
    }
    nextFrontmatter.push(line);
  }

  if (!replaced.has("status")) {
    nextFrontmatter.push(`status: ${escapeFrontmatterValue(input.status)}`);
  }
  if (input.status === "applied") {
    nextFrontmatter.push(`applied_at: ${escapeFrontmatterValue(input.timestamp)}`);
  } else {
    nextFrontmatter.push(`rejected_at: ${escapeFrontmatterValue(input.timestamp)}`);
    if (input.reason) {
      nextFrontmatter.push(`rejection_reason: ${escapeFrontmatterValue(input.reason)}`);
    }
  }

  return ["---", ...nextFrontmatter, ...bodyLines].join("\n");
}

function buildSessionCaptureContent(input: z.infer<typeof MemoryCaptureSessionInputSchema>, capturedAt: string): string {
  return [
    "---",
    `name: ${escapeFrontmatterValue(input.title)}`,
    `description: ${escapeFrontmatterValue(input.reason ?? input.summary)}`,
    "type: session",
    ...(input.sessionId ? [`session_id: ${escapeFrontmatterValue(input.sessionId)}`] : []),
    ...(input.runId ? [`run_id: ${escapeFrontmatterValue(input.runId)}`] : []),
    `captured_at: ${escapeFrontmatterValue(capturedAt)}`,
    "---",
    "",
    `# ${input.title}`,
    "",
    input.summary.trim(),
    ""
  ].join("\n");
}

function defaultMemoryTopicPath(input: z.infer<typeof MemoryRememberInputSchema>): string {
  return `${WORKSPACE_MEMORY_DIRECTORY}/topics/${input.type}/${slugifyMemoryTitle(input.title)}.md`;
}

function defaultSessionCapturePath(input: z.infer<typeof MemoryCaptureSessionInputSchema>): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${WORKSPACE_MEMORY_DIRECTORY}/sessions/${date}-${slugifyMemoryTitle(input.title)}.md`;
}

function dailyMemoryPath(date?: string | undefined): string {
  return `${WORKSPACE_MEMORY_DIRECTORY}/daily/${date ?? new Date().toISOString().slice(0, 10)}.md`;
}

function buildDailyEntry(input: z.infer<typeof MemoryAppendDailyInputSchema>, timestamp: string): string {
  return [
    `## ${input.title?.trim() || timestamp}`,
    "",
    input.content.trim(),
    ""
  ].join("\n");
}

function buildDreamEntry(input: z.infer<typeof MemoryRecordDreamInputSchema>, timestamp: string): string {
  return [
    `## ${input.title}`,
    "",
    `- recorded_at: ${timestamp}`,
    ...(input.targetPath ? [`- target: ${input.targetPath}`] : []),
    ...(input.sourcePaths && input.sourcePaths.length > 0 ? [`- sources: ${input.sourcePaths.join(", ")}`] : []),
    "",
    input.recommendation.trim(),
    ""
  ].join("\n");
}

function normalizeMemoryWritePath(inputPath: string, options?: { defaultDirectory?: string | undefined }): string {
  const normalized = normalizeMemoryPath(inputPath);
  if (normalized.startsWith(`${WORKSPACE_MEMORY_DIRECTORY}/`)) {
    return normalized;
  }

  const defaultDirectory = options?.defaultDirectory ?? `${WORKSPACE_MEMORY_DIRECTORY}/topics`;
  return normalizePathForMatch(path.join(defaultDirectory, normalized));
}

function assertPathUnderWorkspaceMemory(relativePath: string, toolName: string): void {
  if (
    relativePath !== WORKSPACE_MEMORY_DIRECTORY &&
    !relativePath.startsWith(`${WORKSPACE_MEMORY_DIRECTORY}/`)
  ) {
    throw new AppError(403, "native_tool_memory_path_not_allowed", `${toolName} can only access files under .openharness/memory.`);
  }
}

function assertMarkdownMemoryFile(relativePath: string, toolName: string): void {
  assertPathUnderWorkspaceMemory(relativePath, toolName);
  if (!relativePath.endsWith(".md")) {
    throw new AppError(400, "native_tool_memory_file_invalid", `${toolName} can only modify markdown memory files.`);
  }
}

function buildMemoryIndexLine(input: z.infer<typeof MemoryRememberInputSchema>, memoryPath: string): string {
  const description = input.description?.trim() || input.content.trim().split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim() || input.title;
  return `- [${input.title}](${memoryPath}) - ${description}`;
}

async function updateMemoryIndex(input: {
  fileSystem: WorkspaceFileSystem;
  workspaceRoot: string;
  memoryPath: string;
  line: string;
}): Promise<boolean> {
  const indexPath = path.join(input.workspaceRoot, WORKSPACE_MEMORY_INDEX_PATH);
  let current = "";
  try {
    current = (await input.fileSystem.readFile(indexPath)).toString("utf8");
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }

  if (current.includes(input.memoryPath)) {
    return false;
  }

  const next = `${current.trimEnd()}${current.trim().length > 0 ? "\n" : ""}${input.line}\n`;
  await ensureParentDirectory(input.fileSystem, indexPath);
  await input.fileSystem.writeFile(indexPath, Buffer.from(next, "utf8"));
  return true;
}

async function resolveExistingMemoryTarget(input: {
  fileSystem: WorkspaceFileSystem;
  workspaceRoot: string;
  requestedPath: string;
  toolName: string;
}): Promise<{ absolutePath: string; relativePath: string; content: string }> {
  const normalizedPath = normalizeMemoryWritePath(input.requestedPath);
  assertMarkdownMemoryFile(normalizedPath, input.toolName);
  const resolved = await resolveWorkspacePath(input.fileSystem, input.workspaceRoot, normalizedPath);
  assertMarkdownMemoryFile(resolved.relativePath, input.toolName);
  const entry = await input.fileSystem.stat(resolved.absolutePath).catch(() => null);
  if (entry?.kind !== "file") {
    throw new AppError(404, "native_tool_memory_file_not_found", `Memory file ${input.requestedPath} was not found.`);
  }

  return {
    ...resolved,
    content: (await input.fileSystem.readFile(resolved.absolutePath)).toString("utf8")
  };
}

function memoryPathMatchesCorpus(memoryPath: string, corpus: z.infer<typeof MemorySearchInputSchema>["corpus"]): boolean {
  if (!corpus || corpus === "all") {
    return true;
  }

  if (corpus === "index") {
    return memoryPath === WORKSPACE_MEMORY_INDEX_PATH;
  }

  return memoryPath.startsWith(`${WORKSPACE_MEMORY_DIRECTORY}/${corpus}/`);
}

function buildMemorySnippet(content: string, queryTokens: string[]): string {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const normalizedTokens = queryTokens.map((token) => token.toLowerCase());
  const matchIndex = lines.findIndex((line) => {
    const normalizedLine = line.toLowerCase();
    return normalizedTokens.some((token) => normalizedLine.includes(token));
  });
  const line = (matchIndex >= 0 ? (lines[matchIndex] ?? "") : (lines.find((candidate) => candidate.trim().length > 0) ?? "")).trim();
  return line.length > MEMORY_SEARCH_SNIPPET_MAX_CHARS ? `${line.slice(0, MEMORY_SEARCH_SNIPPET_MAX_CHARS - 3)}...` : line;
}

function memoryFileToSearchTopic(file: MemoryFile): WorkspaceMemoryTopicFile {
  if (file.topic) {
    return file.topic;
  }

  return parseWorkspaceMemoryTopicFile({
    filePath: file.path,
    rawContent: file.rawContent,
    mtimeMs: file.mtimeMs
  });
}

async function readMemoryFiles(fileSystem: WorkspaceFileSystem, workspaceRoot: string): Promise<MemoryFile[]> {
  const memoryRoot = path.join(workspaceRoot, WORKSPACE_MEMORY_DIRECTORY);
  const files: MemoryFile[] = [];

  const walk = async (absoluteDirectory: string, relativeDirectory: string): Promise<void> => {
    let entries;
    try {
      entries = await fileSystem.readdir(absoluteDirectory);
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        return;
      }

      throw error;
    }

    for (const entry of entries) {
      const absoluteEntryPath = path.join(absoluteDirectory, entry.name);
      const relativeEntryPath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.kind === "directory") {
        if (relativeEntryPath === "proposals" || relativeEntryPath.startsWith("proposals/")) {
          continue;
        }
        await walk(absoluteEntryPath, relativeEntryPath);
        continue;
      }

      if (entry.kind !== "file" || !entry.name.endsWith(".md")) {
        continue;
      }

      let rawContent;
      let stat;
      try {
        rawContent = (await fileSystem.readFile(absoluteEntryPath)).toString("utf8");
        stat = await fileSystem.stat(absoluteEntryPath);
      } catch (error) {
        if (getErrorCode(error) === "ENOENT") {
          continue;
        }

        throw error;
      }

      const filePath = `${WORKSPACE_MEMORY_DIRECTORY}/${normalizePathForMatch(relativeEntryPath)}`;
      files.push({
        path: filePath,
        rawContent,
        mtimeMs: stat.mtimeMs,
        ...(filePath !== WORKSPACE_MEMORY_INDEX_PATH
          ? {
              topic: parseWorkspaceMemoryTopicFile({
                filePath,
                rawContent,
                mtimeMs: stat.mtimeMs
              })
            }
          : {})
      });
    }
  };

  await walk(memoryRoot, "");
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeMemoryProposalPath(inputPath: string): string {
  const normalized = normalizeMemoryPath(inputPath);
  if (normalized.startsWith(`${WORKSPACE_MEMORY_PROPOSALS_DIRECTORY}/`)) {
    return normalized;
  }

  return normalizePathForMatch(path.join(WORKSPACE_MEMORY_PROPOSALS_DIRECTORY, normalized));
}

async function resolveMemoryProposalFile(input: {
  fileSystem: WorkspaceFileSystem;
  workspaceRoot: string;
  requestedPath: string;
  toolName: string;
}): Promise<MemoryProposalFile> {
  const normalizedPath = normalizeMemoryProposalPath(input.requestedPath);
  assertMarkdownMemoryFile(normalizedPath, input.toolName);
  if (!normalizedPath.startsWith(`${WORKSPACE_MEMORY_PROPOSALS_DIRECTORY}/`)) {
    throw new AppError(403, "native_tool_memory_path_not_allowed", `${input.toolName} can only access memory proposals under .openharness/memory/proposals.`);
  }

  const resolved = await resolveWorkspacePath(input.fileSystem, input.workspaceRoot, normalizedPath);
  assertMarkdownMemoryFile(resolved.relativePath, input.toolName);
  if (!resolved.relativePath.startsWith(`${WORKSPACE_MEMORY_PROPOSALS_DIRECTORY}/`)) {
    throw new AppError(403, "native_tool_memory_path_not_allowed", `${input.toolName} can only access memory proposals under .openharness/memory/proposals.`);
  }

  const entry = await input.fileSystem.stat(resolved.absolutePath).catch(() => null);
  if (entry?.kind !== "file") {
    throw new AppError(404, "native_tool_memory_proposal_not_found", `Memory proposal ${input.requestedPath} was not found.`);
  }

  const rawContent = (await input.fileSystem.readFile(resolved.absolutePath)).toString("utf8");
  const parsed = parseMemoryFrontmatter(rawContent);
  return {
    absolutePath: resolved.absolutePath,
    relativePath: resolved.relativePath,
    rawContent,
    frontmatter: parsed.attributes,
    proposalJson: extractJsonFence(parsed.body)
  };
}

function assertPendingMemoryProposal(proposal: MemoryProposalFile, toolName: string): void {
  const status = proposal.frontmatter["status"] ?? "pending";
  if (status !== "pending") {
    throw new AppError(409, "native_tool_memory_proposal_not_pending", `${toolName} can only operate on pending memory proposals.`);
  }
}

async function markMemoryProposalStatus(input: {
  fileSystem: WorkspaceFileSystem;
  proposal: MemoryProposalFile;
  status: "applied" | "rejected";
  reason?: string | undefined;
}): Promise<void> {
  await input.fileSystem.writeFile(
    input.proposal.absolutePath,
    Buffer.from(
      updateMemoryProposalStatus(input.proposal.rawContent, {
        status: input.status,
        timestamp: new Date().toISOString(),
        reason: input.reason
      }),
      "utf8"
    )
  );
}

async function applyMemoryRemember(input: {
  context: NativeToolFactoryContext;
  fileSystem: WorkspaceFileSystem;
  workspaceRoot: string;
  proposal: unknown;
}): Promise<string> {
  const proposalInput = MemoryRememberInputSchema.parse(input.proposal);
  assertNoMemorySecretsInJson(proposalInput, "MemoryApplyProposal");
  const requestedPath = proposalInput.path
    ? normalizeMemoryWritePath(proposalInput.path, { defaultDirectory: `${WORKSPACE_MEMORY_DIRECTORY}/topics/${proposalInput.type}` })
    : defaultMemoryTopicPath(proposalInput);
  assertMarkdownMemoryFile(requestedPath, "MemoryApplyProposal");

  const resolved = await resolveWorkspacePath(input.fileSystem, input.workspaceRoot, requestedPath);
  assertMarkdownMemoryFile(resolved.relativePath, "MemoryApplyProposal");
  if (!resolved.relativePath.startsWith(`${WORKSPACE_MEMORY_DIRECTORY}/topics/`)) {
    throw new AppError(403, "native_tool_memory_path_not_allowed", "MemoryApplyProposal can only apply MemoryRemember proposals under .openharness/memory/topics.");
  }

  const existing = await input.fileSystem.stat(resolved.absolutePath).catch(() => null);
  if (existing && existing.kind !== "file") {
    throw new AppError(400, "native_tool_memory_file_invalid", `Memory path ${resolved.relativePath} is not a file.`);
  }

  const content = buildMemoryTopicContent(proposalInput);
  await ensureParentDirectory(input.fileSystem, resolved.absolutePath);
  await input.fileSystem.writeFile(resolved.absolutePath, Buffer.from(content, "utf8"));
  await input.context.rememberRead(resolved.relativePath, input.workspaceRoot, input.fileSystem);
  const indexUpdated = await updateMemoryIndex({
    fileSystem: input.fileSystem,
    workspaceRoot: input.workspaceRoot,
    memoryPath: resolved.relativePath,
    line: buildMemoryIndexLine(proposalInput, resolved.relativePath)
  });

  return formatToolOutput([
    ["path", resolved.relativePath],
    ["type", proposalInput.type],
    ["title", proposalInput.title],
    ["created", !existing],
    ["updated", Boolean(existing)],
    ["index_updated", indexUpdated]
  ]);
}

async function applyMemoryUpdate(input: {
  context: NativeToolFactoryContext;
  fileSystem: WorkspaceFileSystem;
  workspaceRoot: string;
  proposal: unknown;
}): Promise<string> {
  const proposalInput = MemoryUpdateInputSchema.parse(input.proposal);
  assertNoMemorySecretsInJson(proposalInput, "MemoryApplyProposal");
  const target = await resolveExistingMemoryTarget({
    fileSystem: input.fileSystem,
    workspaceRoot: input.workspaceRoot,
    requestedPath: proposalInput.path,
    toolName: "MemoryApplyProposal"
  });
  if (!target.content.includes(proposalInput.oldText)) {
    throw new AppError(400, "native_tool_memory_text_not_found", "MemoryApplyProposal oldText was not found in the target memory file.");
  }

  await input.fileSystem.writeFile(target.absolutePath, Buffer.from(target.content.replace(proposalInput.oldText, proposalInput.newText), "utf8"));
  await input.context.rememberRead(target.relativePath, input.workspaceRoot, input.fileSystem);
  return formatToolOutput([
    ["path", target.relativePath],
    ["replacements", 1]
  ]);
}

async function applyMemoryForget(input: {
  context: NativeToolFactoryContext;
  fileSystem: WorkspaceFileSystem;
  workspaceRoot: string;
  proposal: unknown;
}): Promise<string> {
  const proposalInput = MemoryForgetInputSchema.parse(input.proposal);
  assertNoMemorySecretsInJson(proposalInput, "MemoryApplyProposal");
  if (!proposalInput.path) {
    throw new AppError(400, "native_tool_memory_path_required", "MemoryApplyProposal requires MemoryForget proposals to include an exact path.");
  }

  const target = await resolveExistingMemoryTarget({
    fileSystem: input.fileSystem,
    workspaceRoot: input.workspaceRoot,
    requestedPath: proposalInput.path,
    toolName: "MemoryApplyProposal"
  });
  if (proposalInput.text) {
    if (!target.content.includes(proposalInput.text)) {
      throw new AppError(400, "native_tool_memory_text_not_found", "MemoryApplyProposal text was not found in the target memory file.");
    }

    await input.fileSystem.writeFile(target.absolutePath, Buffer.from(target.content.replace(proposalInput.text, ""), "utf8"));
    await input.context.rememberRead(target.relativePath, input.workspaceRoot, input.fileSystem);
    return formatToolOutput([
      ["path", target.relativePath],
      ["forgotten", true],
      ["mode", "text"]
    ]);
  }

  await input.fileSystem.rm(target.absolutePath, { force: true });
  return formatToolOutput([
    ["path", target.relativePath],
    ["forgotten", true],
    ["mode", "file"]
  ]);
}

async function applyMemoryCaptureSession(input: {
  context: NativeToolFactoryContext;
  fileSystem: WorkspaceFileSystem;
  workspaceRoot: string;
  proposal: unknown;
}): Promise<string> {
  const proposalInput = MemoryCaptureSessionInputSchema.parse(input.proposal);
  assertNoMemorySecretsInJson(proposalInput, "MemoryApplyProposal");
  const requestedPath = proposalInput.path
    ? normalizeMemoryWritePath(proposalInput.path, { defaultDirectory: `${WORKSPACE_MEMORY_DIRECTORY}/sessions` })
    : defaultSessionCapturePath(proposalInput);
  assertMarkdownMemoryFile(requestedPath, "MemoryApplyProposal");
  if (!requestedPath.startsWith(`${WORKSPACE_MEMORY_DIRECTORY}/sessions/`)) {
    throw new AppError(403, "native_tool_memory_path_not_allowed", "MemoryApplyProposal can only apply MemoryCaptureSession proposals under .openharness/memory/sessions.");
  }

  const resolved = await resolveWorkspacePath(input.fileSystem, input.workspaceRoot, requestedPath);
  assertMarkdownMemoryFile(resolved.relativePath, "MemoryApplyProposal");
  if (!resolved.relativePath.startsWith(`${WORKSPACE_MEMORY_DIRECTORY}/sessions/`)) {
    throw new AppError(403, "native_tool_memory_path_not_allowed", "MemoryApplyProposal can only apply MemoryCaptureSession proposals under .openharness/memory/sessions.");
  }

  const existing = await input.fileSystem.stat(resolved.absolutePath).catch(() => null);
  if (existing && existing.kind !== "file") {
    throw new AppError(400, "native_tool_memory_file_invalid", `Memory path ${resolved.relativePath} is not a file.`);
  }

  await ensureParentDirectory(input.fileSystem, resolved.absolutePath);
  await input.fileSystem.writeFile(resolved.absolutePath, Buffer.from(buildSessionCaptureContent(proposalInput, new Date().toISOString()), "utf8"));
  await input.context.rememberRead(resolved.relativePath, input.workspaceRoot, input.fileSystem);
  return formatToolOutput([
    ["path", resolved.relativePath],
    ["created", !existing],
    ["updated", Boolean(existing)],
    ["session_id", proposalInput.sessionId],
    ["run_id", proposalInput.runId]
  ]);
}

async function applyMemoryAppendDaily(input: {
  context: NativeToolFactoryContext;
  fileSystem: WorkspaceFileSystem;
  workspaceRoot: string;
  proposal: unknown;
}): Promise<string> {
  const proposalInput = MemoryAppendDailyInputSchema.parse(input.proposal);
  assertNoMemorySecretsInJson(proposalInput, "MemoryApplyProposal");
  const requestedPath = dailyMemoryPath(proposalInput.date);
  const resolved = await resolveWorkspacePath(input.fileSystem, input.workspaceRoot, requestedPath);
  assertMarkdownMemoryFile(resolved.relativePath, "MemoryApplyProposal");
  if (!resolved.relativePath.startsWith(`${WORKSPACE_MEMORY_DIRECTORY}/daily/`)) {
    throw new AppError(403, "native_tool_memory_path_not_allowed", "MemoryApplyProposal can only apply MemoryAppendDaily proposals under .openharness/memory/daily.");
  }

  let current = "";
  let existing = false;
  try {
    current = (await input.fileSystem.readFile(resolved.absolutePath)).toString("utf8");
    existing = true;
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }

  const timestamp = new Date().toISOString();
  const header = existing
    ? ""
    : [
        "---",
        `name: ${escapeFrontmatterValue(`Daily ${proposalInput.date ?? timestamp.slice(0, 10)}`)}`,
        "description: \"Low-weight workspace daily log.\"",
        "type: daily",
        `date: ${escapeFrontmatterValue(proposalInput.date ?? timestamp.slice(0, 10))}`,
        "---",
        "",
        `# Daily ${proposalInput.date ?? timestamp.slice(0, 10)}`,
        ""
      ].join("\n");
  const nextContent = `${current.trimEnd()}${current.trim().length > 0 ? "\n\n" : ""}${header}${buildDailyEntry(proposalInput, timestamp)}`;
  await ensureParentDirectory(input.fileSystem, resolved.absolutePath);
  await input.fileSystem.writeFile(resolved.absolutePath, Buffer.from(nextContent, "utf8"));
  await input.context.rememberRead(resolved.relativePath, input.workspaceRoot, input.fileSystem);
  return formatToolOutput([
    ["path", resolved.relativePath],
    ["created", !existing],
    ["updated", existing],
    ["date", proposalInput.date ?? timestamp.slice(0, 10)]
  ]);
}

async function applyMemoryRecordDream(input: {
  context: NativeToolFactoryContext;
  fileSystem: WorkspaceFileSystem;
  workspaceRoot: string;
  proposal: unknown;
}): Promise<string> {
  const proposalInput = MemoryRecordDreamInputSchema.parse(input.proposal);
  assertNoMemorySecretsInJson(proposalInput, "MemoryApplyProposal");
  const requestedPath = `${WORKSPACE_MEMORY_DIRECTORY}/dreams/DREAMS.md`;
  const resolved = await resolveWorkspacePath(input.fileSystem, input.workspaceRoot, requestedPath);
  assertMarkdownMemoryFile(resolved.relativePath, "MemoryApplyProposal");
  if (resolved.relativePath !== requestedPath) {
    throw new AppError(403, "native_tool_memory_path_not_allowed", "MemoryApplyProposal can only apply MemoryRecordDream proposals to .openharness/memory/dreams/DREAMS.md.");
  }

  let current = "";
  let existing = false;
  try {
    current = (await input.fileSystem.readFile(resolved.absolutePath)).toString("utf8");
    existing = true;
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }

  const timestamp = new Date().toISOString();
  const header = existing
    ? ""
    : [
        "---",
        "name: \"Memory Dreams\"",
        "description: \"Memory consolidation and promotion review log.\"",
        "type: dreams",
        "---",
        "",
        "# Memory Dreams",
        ""
      ].join("\n");
  const nextContent = `${current.trimEnd()}${current.trim().length > 0 ? "\n\n" : ""}${header}${buildDreamEntry(proposalInput, timestamp)}`;
  await ensureParentDirectory(input.fileSystem, resolved.absolutePath);
  await input.fileSystem.writeFile(resolved.absolutePath, Buffer.from(nextContent, "utf8"));
  await input.context.rememberRead(resolved.relativePath, input.workspaceRoot, input.fileSystem);
  return formatToolOutput([
    ["path", resolved.relativePath],
    ["created", !existing],
    ["updated", existing],
    ["target_path", proposalInput.targetPath]
  ]);
}

async function applyMemoryProposalPayload(input: {
  context: NativeToolFactoryContext;
  fileSystem: WorkspaceFileSystem;
  workspaceRoot: string;
  toolName: string;
  proposal: unknown;
}): Promise<string> {
  switch (input.toolName) {
    case "MemoryRemember":
      return applyMemoryRemember(input);
    case "MemoryUpdate":
      return applyMemoryUpdate(input);
    case "MemoryForget":
      return applyMemoryForget(input);
    case "MemoryCaptureSession":
      return applyMemoryCaptureSession(input);
    case "MemoryAppendDaily":
      return applyMemoryAppendDaily(input);
    case "MemoryRecordDream":
      return applyMemoryRecordDream(input);
    default:
      throw new AppError(400, "native_tool_memory_proposal_invalid", `Unsupported memory proposal tool: ${input.toolName}`);
  }
}

export function createMemoryTools(context: NativeToolFactoryContext): EngineToolSet {
  return {
    MemorySearch: {
      description: MEMORY_SEARCH_DESCRIPTION,
      retryPolicy: getNativeToolRetryPolicy("MemorySearch"),
      inputSchema: MemorySearchInputSchema,
      async execute(rawInput) {
        context.assertVisible("MemorySearch");
        const input = MemorySearchInputSchema.parse(rawInput);
        const maxResults = input.maxResults ?? MEMORY_SEARCH_DEFAULT_MAX_RESULTS;

        return context.withFileSystem("read", WORKSPACE_MEMORY_DIRECTORY, async ({ workspaceRoot, fileSystem }) => {
          const queryTokens = tokenizeWorkspaceMemoryRecallText(input.query);
          const files = (await readMemoryFiles(fileSystem, workspaceRoot)).filter((file) =>
            memoryPathMatchesCorpus(file.path, input.corpus)
          );
          const allRanked = files
            .map((file) => {
              const topic = memoryFileToSearchTopic(file);
              const score = scoreWorkspaceMemoryTopic(input.query, queryTokens, [], topic);
              const fallbackScore = file.rawContent.toLowerCase().includes(input.query.toLowerCase()) ? 1 : 0;
              return {
                file,
                topic,
                score: score > 0 ? score : fallbackScore
              };
            })
            .filter((entry) => entry.score > 0)
            .sort((left, right) => right.score - left.score || right.file.mtimeMs - left.file.mtimeMs || left.file.path.localeCompare(right.file.path));
          const ranked = allRanked.slice(0, maxResults);

          return formatToolOutput(
            [
              ["query", input.query],
              ["corpus", input.corpus ?? "all"],
              ["matches", ranked.length],
              ["truncated", allRanked.length > ranked.length]
            ],
            [
              {
                title: "results",
                lines: ranked.map(({ file, topic, score }) =>
                  [
                    `path=${file.path}`,
                    `score=${score}`,
                    topic.memoryType ? `type=${topic.memoryType}` : undefined,
                    topic.title ? `title=${topic.title}` : undefined,
                    topic.summary ? `summary=${topic.summary}` : undefined,
                    `updated=${new Date(file.mtimeMs).toISOString()}`,
                    `snippet=${buildMemorySnippet(file.rawContent, queryTokens)}`
                  ]
                    .filter(Boolean)
                    .join(" | ")
                ),
                emptyText: "(no matching memory files)"
              }
            ]
          );
        });
      }
    },
    MemoryRead: {
      description: MEMORY_READ_DESCRIPTION,
      retryPolicy: getNativeToolRetryPolicy("MemoryRead"),
      inputSchema: MemoryReadInputSchema,
      async execute(rawInput) {
        context.assertVisible("MemoryRead");
        const input = MemoryReadInputSchema.parse(rawInput);
        const requestedPath = normalizeMemoryPath(input.path);
        if (
          requestedPath !== WORKSPACE_MEMORY_DIRECTORY &&
          !requestedPath.startsWith(`${WORKSPACE_MEMORY_DIRECTORY}/`)
        ) {
          throw new AppError(403, "native_tool_memory_path_not_allowed", "MemoryRead can only read files under .openharness/memory.");
        }

        return context.withFileSystem("read", requestedPath, async ({ workspaceRoot, fileSystem }) => {
          const resolved = await resolveWorkspacePath(fileSystem, workspaceRoot, requestedPath);
          if (
            resolved.relativePath !== WORKSPACE_MEMORY_DIRECTORY &&
            !resolved.relativePath.startsWith(`${WORKSPACE_MEMORY_DIRECTORY}/`)
          ) {
            throw new AppError(403, "native_tool_memory_path_not_allowed", "MemoryRead can only read files under .openharness/memory.");
          }

          const entry = await fileSystem.stat(resolved.absolutePath).catch(() => null);
          if (entry?.kind !== "file" || !resolved.relativePath.endsWith(".md")) {
            throw new AppError(404, "native_tool_memory_file_not_found", `Memory file ${input.path} was not found.`);
          }

          const content = (await fileSystem.readFile(resolved.absolutePath)).toString("utf8");
          const offset = input.from ?? 1;
          const limit = input.lines ?? DEFAULT_READ_LIMIT;
          const { rendered, truncated, totalLines } = formatReadLines(content, offset, limit);
          await context.rememberRead(resolved.relativePath, workspaceRoot, fileSystem);

          return formatToolOutput(
            [
              ["path", resolved.relativePath],
              ["offset", offset],
              ["returned_lines", rendered.length],
              ["total_lines", totalLines],
              ["truncated", truncated]
            ],
            [
              {
                title: "content",
                lines: rendered,
                emptyText: "(empty memory file)"
              }
            ]
          );
        });
      }
    },
    MemoryRemember: {
      description: MEMORY_REMEMBER_DESCRIPTION,
      retryPolicy: getNativeToolRetryPolicy("MemoryRemember"),
      inputSchema: MemoryRememberInputSchema,
      async execute(rawInput) {
        context.assertVisible("MemoryRemember");
        const input = MemoryRememberInputSchema.parse(rawInput);
        assertNoMemorySecretsInJson(input, "MemoryRemember");

        const requestedPath = input.path
          ? normalizeMemoryWritePath(input.path, { defaultDirectory: `${WORKSPACE_MEMORY_DIRECTORY}/topics/${input.type}` })
          : defaultMemoryTopicPath(input);
        assertMarkdownMemoryFile(requestedPath, "MemoryRemember");
        if (memoryWriteRequiresConfirmationForContext(context)) {
          return createPendingMemoryProposal(context, {
            tool: "MemoryRemember",
            targetPath: requestedPath,
            proposal: input
          });
        }

        return context.withFileSystem("write", requestedPath, async ({ workspaceRoot, fileSystem, workspace }) => {
          if (workspace?.readOnly) {
            throw new AppError(403, "native_tool_memory_read_only", "MemoryRemember cannot write in a read-only workspace.");
          }

          const resolved = await resolveWorkspacePath(fileSystem, workspaceRoot, requestedPath);
          assertMarkdownMemoryFile(resolved.relativePath, "MemoryRemember");
          const existing = await fileSystem.stat(resolved.absolutePath).catch(() => null);
          if (existing && existing.kind !== "file") {
            throw new AppError(400, "native_tool_memory_file_invalid", `Memory path ${resolved.relativePath} is not a file.`);
          }

          const content = buildMemoryTopicContent(input);
          await ensureParentDirectory(fileSystem, resolved.absolutePath);
          await fileSystem.writeFile(resolved.absolutePath, Buffer.from(content, "utf8"));
          await context.rememberRead(resolved.relativePath, workspaceRoot, fileSystem);
          const indexUpdated = await updateMemoryIndex({
            fileSystem,
            workspaceRoot,
            memoryPath: resolved.relativePath,
            line: buildMemoryIndexLine(input, resolved.relativePath)
          });

          return formatToolOutput([
            ["path", resolved.relativePath],
            ["type", input.type],
            ["title", input.title],
            ["created", !existing],
            ["updated", Boolean(existing)],
            ["index_updated", indexUpdated],
            ["write_policy", resolveEffectiveWorkspaceMemoryWritePolicy(context)]
          ]);
        });
      }
    },
    MemoryUpdate: {
      description: MEMORY_UPDATE_DESCRIPTION,
      retryPolicy: getNativeToolRetryPolicy("MemoryUpdate"),
      inputSchema: MemoryUpdateInputSchema,
      async execute(rawInput) {
        context.assertVisible("MemoryUpdate");
        const input = MemoryUpdateInputSchema.parse(rawInput);
        assertNoMemorySecretsInJson(input, "MemoryUpdate");
        if (memoryWriteRequiresConfirmationForContext(context)) {
          return createPendingMemoryProposal(context, {
            tool: "MemoryUpdate",
            targetPath: normalizeMemoryWritePath(input.path),
            proposal: input
          });
        }

        return context.withFileSystem("write", input.path, async ({ workspaceRoot, fileSystem, workspace }) => {
          if (workspace?.readOnly) {
            throw new AppError(403, "native_tool_memory_read_only", "MemoryUpdate cannot write in a read-only workspace.");
          }

          const target = await resolveExistingMemoryTarget({
            fileSystem,
            workspaceRoot,
            requestedPath: input.path,
            toolName: "MemoryUpdate"
          });
          if (!target.content.includes(input.oldText)) {
            throw new AppError(400, "native_tool_memory_text_not_found", "MemoryUpdate oldText was not found in the target memory file.");
          }

          const nextContent = target.content.replace(input.oldText, input.newText);
          await fileSystem.writeFile(target.absolutePath, Buffer.from(nextContent, "utf8"));
          await context.rememberRead(target.relativePath, workspaceRoot, fileSystem);

          return formatToolOutput([
            ["path", target.relativePath],
            ["replacements", 1],
            ["write_policy", resolveEffectiveWorkspaceMemoryWritePolicy(context)]
          ]);
        });
      }
    },
    MemoryForget: {
      description: MEMORY_FORGET_DESCRIPTION,
      retryPolicy: getNativeToolRetryPolicy("MemoryForget"),
      inputSchema: MemoryForgetInputSchema,
      async execute(rawInput) {
        context.assertVisible("MemoryForget");
        const input = MemoryForgetInputSchema.parse(rawInput);
        assertNoMemorySecretsInJson(input, "MemoryForget");
        if (memoryWriteRequiresConfirmationForContext(context)) {
          return createPendingMemoryProposal(context, {
            tool: "MemoryForget",
            targetPath: input.path ? normalizeMemoryWritePath(input.path) : undefined,
            proposal: input
          });
        }

        return context.withFileSystem("write", input.path ?? WORKSPACE_MEMORY_DIRECTORY, async ({ workspaceRoot, fileSystem, workspace }) => {
          if (workspace?.readOnly) {
            throw new AppError(403, "native_tool_memory_read_only", "MemoryForget cannot write in a read-only workspace.");
          }

          if (!input.path) {
            const query = input.query ?? "";
            const queryTokens = tokenizeWorkspaceMemoryRecallText(query);
            const allRanked = (await readMemoryFiles(fileSystem, workspaceRoot))
              .map((file) => {
                const topic = memoryFileToSearchTopic(file);
                const score = scoreWorkspaceMemoryTopic(query, queryTokens, [], topic);
                const fallbackScore = file.rawContent.toLowerCase().includes(query.toLowerCase()) ? 1 : 0;
                return {
                  file,
                  topic,
                  score: score > 0 ? score : fallbackScore
                };
              })
              .filter((entry) => entry.score > 0)
              .sort((left, right) => right.score - left.score || right.file.mtimeMs - left.file.mtimeMs || left.file.path.localeCompare(right.file.path))
              .slice(0, MEMORY_SEARCH_DEFAULT_MAX_RESULTS);

            return formatToolOutput(
              [
                ["query", query],
                ["forgotten", false],
                ["reason", "path_required"],
                ["matches", allRanked.length]
              ],
              [
                {
                  title: "candidates",
                  lines: allRanked.map(({ file, topic, score }) =>
                    [
                      `path=${file.path}`,
                      `score=${score}`,
                      topic.memoryType ? `type=${topic.memoryType}` : undefined,
                      topic.title ? `title=${topic.title}` : undefined,
                      topic.summary ? `summary=${topic.summary}` : undefined
                    ]
                      .filter(Boolean)
                      .join(" | ")
                  ),
                  emptyText: "(no matching memory files)"
                }
              ]
            );
          }

          const target = await resolveExistingMemoryTarget({
            fileSystem,
            workspaceRoot,
            requestedPath: input.path,
            toolName: "MemoryForget"
          });

          if (input.text) {
            if (!target.content.includes(input.text)) {
              throw new AppError(400, "native_tool_memory_text_not_found", "MemoryForget text was not found in the target memory file.");
            }

            const nextContent = target.content.replace(input.text, "");
            await fileSystem.writeFile(target.absolutePath, Buffer.from(nextContent, "utf8"));
            await context.rememberRead(target.relativePath, workspaceRoot, fileSystem);
            return formatToolOutput([
              ["path", target.relativePath],
              ["forgotten", true],
              ["mode", "text"],
              ["write_policy", resolveEffectiveWorkspaceMemoryWritePolicy(context)]
            ]);
          }

          await fileSystem.rm(target.absolutePath, { force: true });
          return formatToolOutput([
            ["path", target.relativePath],
            ["forgotten", true],
            ["mode", "file"],
            ["write_policy", resolveEffectiveWorkspaceMemoryWritePolicy(context)]
          ]);
        });
      }
    },
    MemoryCaptureSession: {
      description: MEMORY_CAPTURE_SESSION_DESCRIPTION,
      retryPolicy: getNativeToolRetryPolicy("MemoryCaptureSession"),
      inputSchema: MemoryCaptureSessionInputSchema,
      async execute(rawInput) {
        context.assertVisible("MemoryCaptureSession");
        const input = MemoryCaptureSessionInputSchema.parse(rawInput);
        assertNoMemorySecretsInJson(input, "MemoryCaptureSession");

        const requestedPath = input.path
          ? normalizeMemoryWritePath(input.path, { defaultDirectory: `${WORKSPACE_MEMORY_DIRECTORY}/sessions` })
          : defaultSessionCapturePath(input);
        assertMarkdownMemoryFile(requestedPath, "MemoryCaptureSession");
        if (!requestedPath.startsWith(`${WORKSPACE_MEMORY_DIRECTORY}/sessions/`)) {
          throw new AppError(403, "native_tool_memory_path_not_allowed", "MemoryCaptureSession can only write under .openharness/memory/sessions.");
        }
        if (memoryWriteRequiresConfirmationForContext(context)) {
          return createPendingMemoryProposal(context, {
            tool: "MemoryCaptureSession",
            targetPath: requestedPath,
            proposal: input
          });
        }

        return context.withFileSystem("write", requestedPath, async ({ workspaceRoot, fileSystem, workspace }) => {
          if (workspace?.readOnly) {
            throw new AppError(403, "native_tool_memory_read_only", "MemoryCaptureSession cannot write in a read-only workspace.");
          }

          const resolved = await resolveWorkspacePath(fileSystem, workspaceRoot, requestedPath);
          assertMarkdownMemoryFile(resolved.relativePath, "MemoryCaptureSession");
          if (!resolved.relativePath.startsWith(`${WORKSPACE_MEMORY_DIRECTORY}/sessions/`)) {
            throw new AppError(403, "native_tool_memory_path_not_allowed", "MemoryCaptureSession can only write under .openharness/memory/sessions.");
          }

          const existing = await fileSystem.stat(resolved.absolutePath).catch(() => null);
          if (existing && existing.kind !== "file") {
            throw new AppError(400, "native_tool_memory_file_invalid", `Memory path ${resolved.relativePath} is not a file.`);
          }

          const capturedAt = new Date().toISOString();
          const content = buildSessionCaptureContent(input, capturedAt);
          await ensureParentDirectory(fileSystem, resolved.absolutePath);
          await fileSystem.writeFile(resolved.absolutePath, Buffer.from(content, "utf8"));
          await context.rememberRead(resolved.relativePath, workspaceRoot, fileSystem);

          return formatToolOutput([
            ["path", resolved.relativePath],
            ["created", !existing],
            ["updated", Boolean(existing)],
            ["session_id", input.sessionId],
            ["run_id", input.runId],
            ["write_policy", resolveEffectiveWorkspaceMemoryWritePolicy(context)]
          ]);
        });
      }
    },
    MemoryAppendDaily: {
      description: MEMORY_APPEND_DAILY_DESCRIPTION,
      retryPolicy: getNativeToolRetryPolicy("MemoryAppendDaily"),
      inputSchema: MemoryAppendDailyInputSchema,
      async execute(rawInput) {
        context.assertVisible("MemoryAppendDaily");
        const input = MemoryAppendDailyInputSchema.parse(rawInput);
        assertNoMemorySecretsInJson(input, "MemoryAppendDaily");

        const requestedPath = dailyMemoryPath(input.date);
        if (memoryWriteRequiresConfirmationForContext(context)) {
          return createPendingMemoryProposal(context, {
            tool: "MemoryAppendDaily",
            targetPath: requestedPath,
            proposal: input
          });
        }
        return context.withFileSystem("write", requestedPath, async ({ workspaceRoot, fileSystem, workspace }) => {
          if (workspace?.readOnly) {
            throw new AppError(403, "native_tool_memory_read_only", "MemoryAppendDaily cannot write in a read-only workspace.");
          }

          const resolved = await resolveWorkspacePath(fileSystem, workspaceRoot, requestedPath);
          assertMarkdownMemoryFile(resolved.relativePath, "MemoryAppendDaily");
          if (!resolved.relativePath.startsWith(`${WORKSPACE_MEMORY_DIRECTORY}/daily/`)) {
            throw new AppError(403, "native_tool_memory_path_not_allowed", "MemoryAppendDaily can only write under .openharness/memory/daily.");
          }

          let current = "";
          let existing = false;
          try {
            current = (await fileSystem.readFile(resolved.absolutePath)).toString("utf8");
            existing = true;
          } catch (error) {
            if (getErrorCode(error) !== "ENOENT") {
              throw error;
            }
          }

          const timestamp = new Date().toISOString();
          const header = existing
            ? ""
            : [
                "---",
                `name: ${escapeFrontmatterValue(`Daily ${input.date ?? timestamp.slice(0, 10)}`)}`,
                "description: \"Low-weight workspace daily log.\"",
                "type: daily",
                `date: ${escapeFrontmatterValue(input.date ?? timestamp.slice(0, 10))}`,
                "---",
                "",
                `# Daily ${input.date ?? timestamp.slice(0, 10)}`,
                ""
              ].join("\n");
          const nextContent = `${current.trimEnd()}${current.trim().length > 0 ? "\n\n" : ""}${header}${buildDailyEntry(input, timestamp)}`;
          await ensureParentDirectory(fileSystem, resolved.absolutePath);
          await fileSystem.writeFile(resolved.absolutePath, Buffer.from(nextContent, "utf8"));
          await context.rememberRead(resolved.relativePath, workspaceRoot, fileSystem);

          return formatToolOutput([
            ["path", resolved.relativePath],
            ["created", !existing],
            ["updated", existing],
            ["date", input.date ?? timestamp.slice(0, 10)],
            ["write_policy", resolveEffectiveWorkspaceMemoryWritePolicy(context)]
          ]);
        });
      }
    },
    MemoryRecordDream: {
      description: MEMORY_RECORD_DREAM_DESCRIPTION,
      retryPolicy: getNativeToolRetryPolicy("MemoryRecordDream"),
      inputSchema: MemoryRecordDreamInputSchema,
      async execute(rawInput) {
        context.assertVisible("MemoryRecordDream");
        const input = MemoryRecordDreamInputSchema.parse(rawInput);
        assertNoMemorySecretsInJson(input, "MemoryRecordDream");

        const requestedPath = `${WORKSPACE_MEMORY_DIRECTORY}/dreams/DREAMS.md`;
        if (memoryWriteRequiresConfirmationForContext(context)) {
          return createPendingMemoryProposal(context, {
            tool: "MemoryRecordDream",
            targetPath: requestedPath,
            proposal: input
          });
        }
        return context.withFileSystem("write", requestedPath, async ({ workspaceRoot, fileSystem, workspace }) => {
          if (workspace?.readOnly) {
            throw new AppError(403, "native_tool_memory_read_only", "MemoryRecordDream cannot write in a read-only workspace.");
          }

          const resolved = await resolveWorkspacePath(fileSystem, workspaceRoot, requestedPath);
          assertMarkdownMemoryFile(resolved.relativePath, "MemoryRecordDream");
          if (resolved.relativePath !== requestedPath) {
            throw new AppError(403, "native_tool_memory_path_not_allowed", "MemoryRecordDream can only write .openharness/memory/dreams/DREAMS.md.");
          }

          let current = "";
          let existing = false;
          try {
            current = (await fileSystem.readFile(resolved.absolutePath)).toString("utf8");
            existing = true;
          } catch (error) {
            if (getErrorCode(error) !== "ENOENT") {
              throw error;
            }
          }

          const timestamp = new Date().toISOString();
          const header = existing
            ? ""
            : [
                "---",
                "name: \"Memory Dreams\"",
                "description: \"Memory consolidation and promotion review log.\"",
                "type: dreams",
                "---",
                "",
                "# Memory Dreams",
                ""
              ].join("\n");
          const nextContent = `${current.trimEnd()}${current.trim().length > 0 ? "\n\n" : ""}${header}${buildDreamEntry(input, timestamp)}`;
          await ensureParentDirectory(fileSystem, resolved.absolutePath);
          await fileSystem.writeFile(resolved.absolutePath, Buffer.from(nextContent, "utf8"));
          await context.rememberRead(resolved.relativePath, workspaceRoot, fileSystem);

          return formatToolOutput([
            ["path", resolved.relativePath],
            ["created", !existing],
            ["updated", existing],
            ["target_path", input.targetPath],
            ["write_policy", resolveEffectiveWorkspaceMemoryWritePolicy(context)]
          ]);
        });
      }
    },
    MemoryApplyProposal: {
      description: MEMORY_APPLY_PROPOSAL_DESCRIPTION,
      retryPolicy: getNativeToolRetryPolicy("MemoryApplyProposal"),
      inputSchema: MemoryApplyProposalInputSchema,
      async execute(rawInput) {
        context.assertVisible("MemoryApplyProposal");
        const input = MemoryApplyProposalInputSchema.parse(rawInput);
        const proposalPath = normalizeMemoryProposalPath(input.path);

        return context.withFileSystem("write", WORKSPACE_MEMORY_DIRECTORY, async ({ workspaceRoot, fileSystem, workspace }) => {
          if (workspace?.readOnly) {
            throw new AppError(403, "native_tool_memory_read_only", "MemoryApplyProposal cannot write in a read-only workspace.");
          }

          const proposal = await resolveMemoryProposalFile({
            fileSystem,
            workspaceRoot,
            requestedPath: proposalPath,
            toolName: "MemoryApplyProposal"
          });
          assertPendingMemoryProposal(proposal, "MemoryApplyProposal");
          const proposalTool = proposal.frontmatter["tool"];
          if (!proposalTool) {
            throw new AppError(400, "native_tool_memory_proposal_invalid", "Memory proposal is missing tool.");
          }

          const appliedOutput = await applyMemoryProposalPayload({
            context,
            fileSystem,
            workspaceRoot,
            toolName: proposalTool,
            proposal: proposal.proposalJson
          });
          await markMemoryProposalStatus({
            fileSystem,
            proposal,
            status: "applied"
          });

          return formatToolOutput(
            [
              ["proposal_path", proposal.relativePath],
              ["proposal_status", "applied"],
              ["tool", proposalTool]
            ],
            [
              {
                title: "applied_result",
                lines: String(appliedOutput).split("\n")
              }
            ]
          );
        });
      }
    },
    MemoryRejectProposal: {
      description: MEMORY_REJECT_PROPOSAL_DESCRIPTION,
      retryPolicy: getNativeToolRetryPolicy("MemoryRejectProposal"),
      inputSchema: MemoryRejectProposalInputSchema,
      async execute(rawInput) {
        context.assertVisible("MemoryRejectProposal");
        const input = MemoryRejectProposalInputSchema.parse(rawInput);
        const proposalPath = normalizeMemoryProposalPath(input.path);

        return context.withFileSystem("write", proposalPath, async ({ workspaceRoot, fileSystem, workspace }) => {
          if (workspace?.readOnly) {
            throw new AppError(403, "native_tool_memory_read_only", "MemoryRejectProposal cannot write in a read-only workspace.");
          }

          const proposal = await resolveMemoryProposalFile({
            fileSystem,
            workspaceRoot,
            requestedPath: proposalPath,
            toolName: "MemoryRejectProposal"
          });
          assertPendingMemoryProposal(proposal, "MemoryRejectProposal");
          await markMemoryProposalStatus({
            fileSystem,
            proposal,
            status: "rejected",
            reason: input.reason
          });

          return formatToolOutput([
            ["proposal_path", proposal.relativePath],
            ["proposal_status", "rejected"],
            ["tool", proposal.frontmatter["tool"]],
            ["reason", input.reason]
          ]);
        });
      }
    }
  };
}
