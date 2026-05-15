import path from "node:path";

import type { Message, Run, Session } from "@oah/api-contracts";

import type { EngineLogger, ModelDefinition, ModelGateway, WorkspaceRecord } from "../types.js";
import { truncateText } from "./memory-support.js";
import { extractMessageDisplayText, hasMeaningfulText } from "./session-history.js";
import { parseWorkspaceMemoryType, type WorkspaceMemoryType } from "./workspace-memory-taxonomy.js";

export const WORKSPACE_MEMORY_RECALL_QUERY_MAX_CHARS = 2_000;
export const WORKSPACE_MEMORY_RECALL_BODY_MAX_CHARS = 4_000;
export const WORKSPACE_MEMORY_RECALL_FILE_MAX_CHARS = 3_000;
export const WORKSPACE_MEMORY_RECALL_TOTAL_MAX_CHARS = 9_000;
export const WORKSPACE_MEMORY_RECALL_MAX_FILES = 4;
export const WORKSPACE_MEMORY_RECALL_SHORTLIST_MAX_FILES = Math.max(WORKSPACE_MEMORY_RECALL_MAX_FILES * 2, 8);

const WORKSPACE_MEMORY_SELECTOR_SYSTEM_PROMPT = [
  "You are the workspace memory recall selector.",
  "Choose which workspace memory topic files will clearly help answer the current turn.",
  `Return JSON only in the form {\"paths\":[\".openharness/memory/example.md\"]}.`,
  `Select at most ${WORKSPACE_MEMORY_RECALL_MAX_FILES} files.`,
  "Be selective. If no file is clearly useful, return an empty array.",
  "Use only the provided query and memory manifest. Do not infer unseen repository facts.",
  "If a list of recently used tools is provided, avoid selecting tool usage or API reference memories for those tools unless the memory contains warnings, gotchas, or known issues that would still matter."
].join(" ");

const WORKSPACE_MEMORY_RECALL_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "be",
  "before",
  "by",
  "for",
  "from",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "please",
  "should",
  "that",
  "the",
  "this",
  "to",
  "use",
  "we",
  "what",
  "when",
  "with",
  "you"
]);

const MEMORY_REFERENCE_HINTS = ["reference", "usage", "api", "docs", "documentation", "example", "examples", "guide", "cheatsheet"];

export interface WorkspaceMemoryTopicFile {
  path: string;
  rawContent: string;
  bodyText: string;
  title?: string;
  summary?: string;
  memoryType?: WorkspaceMemoryType;
  mtimeMs: number;
}

export interface WorkspaceMemoryResolvedModel {
  canonicalModelRef: string;
  model: string;
  provider?: string | undefined;
  modelDefinition?: ModelDefinition | undefined;
}

function parseFrontmatter(raw: string): { attributes: Record<string, string>; body: string } {
  const lines = raw.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") {
    return {
      attributes: {},
      body: raw
    };
  }

  let endIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "---") {
      endIndex = index;
      break;
    }
  }

  if (endIndex < 0) {
    return {
      attributes: {},
      body: raw
    };
  }

  const attributes: Record<string, string> = {};
  for (const line of lines.slice(1, endIndex)) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/u);
    if (!match) {
      continue;
    }

    const key = match[1];
    const rawValue = match[2];
    if (!key || !rawValue) {
      continue;
    }

    const value = rawValue.trim().replace(/^['"]|['"]$/gu, "");
    if (value.length > 0) {
      attributes[key.toLowerCase()] = value;
    }
  }

  return {
    attributes,
    body: lines.slice(endIndex + 1).join("\n")
  };
}

function stripMarkdownLinePrefix(value: string): string {
  return value.replace(/^[>\-*+\d.\s`]+/u, "").trim();
}

function extractFirstHeading(markdown: string): string | undefined {
  return markdown
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.startsWith("#"))
    ?.replace(/^#+\s*/u, "")
    .trim();
}

function extractFirstMeaningfulBodyLine(markdown: string): string | undefined {
  for (const rawLine of markdown.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line === "---" || line.startsWith("#")) {
      continue;
    }

    const normalized = stripMarkdownLinePrefix(line);
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return undefined;
}

function normalizeRecallText(value: string): string {
  return value.toLowerCase();
}

function stemRecallToken(value: string): string {
  const token = normalizeRecallText(value);
  for (const suffix of ["ations", "ation", "ments", "ment", "ingly", "edly", "ings", "ness", "tion", "ions", "ion", "ies", "ing", "ers", "er", "ed", "es", "s"]) {
    if (token.length - suffix.length >= 4 && token.endsWith(suffix)) {
      return token.slice(0, -suffix.length);
    }
  }

  return token;
}

export function tokenizeWorkspaceMemoryRecallText(value: string): string[] {
  const matches = normalizeRecallText(value).match(/[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu) ?? [];
  const tokens = new Set<string>();

  for (const match of matches) {
    const token = match.replace(/^[_./-]+|[_./-]+$/gu, "");
    if (token.length < 2 || WORKSPACE_MEMORY_RECALL_STOPWORDS.has(token)) {
      continue;
    }

    tokens.add(token);
  }

  return [...tokens];
}

function areRecallTokensRelated(left: string, right: string): boolean {
  const leftStem = stemRecallToken(left);
  const rightStem = stemRecallToken(right);
  if (leftStem === rightStem) {
    return true;
  }

  const shortestLength = Math.min(leftStem.length, rightStem.length);
  if (shortestLength >= 4 && (leftStem.includes(rightStem) || rightStem.includes(leftStem))) {
    return true;
  }

  return shortestLength >= 5 && leftStem.slice(0, 5) === rightStem.slice(0, 5);
}

function topicLooksLikeReferenceForRecentTool(topic: WorkspaceMemoryTopicFile, recentTools: string[], query: string): boolean {
  if (recentTools.length === 0) {
    return false;
  }

  const combinedText = normalizeRecallText([topic.path, topic.title ?? "", topic.summary ?? "", topic.bodyText].join("\n"));
  if (!MEMORY_REFERENCE_HINTS.some((hint) => combinedText.includes(hint))) {
    return false;
  }

  return recentTools.some((toolName) => {
    const normalizedTool = normalizeRecallText(toolName);
    return normalizedTool.length >= 3 && combinedText.includes(normalizedTool) && !normalizeRecallText(query).includes(normalizedTool);
  });
}

export function scoreWorkspaceMemoryTopic(
  query: string,
  queryTokens: string[],
  recentTools: string[],
  topic: WorkspaceMemoryTopicFile
): number {
  if (queryTokens.length === 0) {
    return 0;
  }

  const normalizedQuery = normalizeRecallText(query);
  const pathText = normalizeRecallText(topic.path);
  const titleText = normalizeRecallText(topic.title ?? "");
  const summaryText = normalizeRecallText(topic.summary ?? "");
  const bodyText = normalizeRecallText(topic.bodyText);
  const fileStem = normalizeRecallText(path.basename(topic.path, ".md"));

  let score = 0;
  if (fileStem.length >= 3 && normalizedQuery.includes(fileStem)) {
    score += 10;
  }

  if (titleText.length >= 4 && normalizedQuery.includes(titleText)) {
    score += 8;
  }

  const pathTokens = tokenizeWorkspaceMemoryRecallText(pathText);
  const titleTokens = tokenizeWorkspaceMemoryRecallText(titleText);
  const summaryTokens = tokenizeWorkspaceMemoryRecallText(summaryText);
  const bodyTokens = tokenizeWorkspaceMemoryRecallText(bodyText);

  for (const token of queryTokens) {
    if (pathText.includes(token) || pathTokens.some((candidate) => areRecallTokensRelated(token, candidate))) {
      score += 7;
      continue;
    }

    if (titleText.includes(token) || titleTokens.some((candidate) => areRecallTokensRelated(token, candidate))) {
      score += 6;
      continue;
    }

    if (summaryText.includes(token) || summaryTokens.some((candidate) => areRecallTokensRelated(token, candidate))) {
      score += 4;
      continue;
    }

    if (bodyText.includes(token) || bodyTokens.some((candidate) => areRecallTokensRelated(token, candidate))) {
      score += 2;
    }
  }

  if (topicLooksLikeReferenceForRecentTool(topic, recentTools, query)) {
    score -= 4;
  }

  return score;
}

function listToolNamesInMessage(message: Message): string[] {
  if (!Array.isArray(message.content)) {
    return [];
  }

  return message.content.flatMap((part) => {
    if ((part.type === "tool-call" || part.type === "tool-result") && typeof part.toolName === "string") {
      return [part.toolName];
    }

    return [];
  });
}

export function extractRecentToolNames(messages: Message[], maxTools = 6): string[] {
  const recent = new Set<string>();

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }

    for (const toolName of listToolNamesInMessage(message)) {
      if (!recent.has(toolName)) {
        recent.add(toolName);
      }

      if (recent.size >= maxTools) {
        return [...recent];
      }
    }
  }

  return [...recent];
}

export function buildWorkspaceMemoryRecallQuery(
  messages: Message[],
  options?: {
    maxSegments?: number;
    hiddenMessagePredicate?: ((message: Message) => boolean) | undefined;
  }
): string {
  const segments: string[] = [];
  const maxSegments = options?.maxSegments ?? 4;

  for (let index = messages.length - 1; index >= 0 && segments.length < maxSegments; index -= 1) {
    const message = messages[index];
    if (
      !message ||
      options?.hiddenMessagePredicate?.(message) === true ||
      (message.role !== "user" && message.role !== "assistant")
    ) {
      continue;
    }

    const text = extractMessageDisplayText(message);
    if (!hasMeaningfulText(text)) {
      continue;
    }

    segments.push(`${message.role}: ${truncateText(text.trim(), 600)}`);
  }

  return truncateText(segments.reverse().join("\n\n"), WORKSPACE_MEMORY_RECALL_QUERY_MAX_CHARS).trim();
}

export function parseWorkspaceMemoryTopicFile(input: {
  filePath: string;
  rawContent: string;
  mtimeMs: number;
}): WorkspaceMemoryTopicFile {
  const { attributes, body } = parseFrontmatter(input.rawContent);
  const title = attributes["name"]?.trim() || extractFirstHeading(body);
  const summarySource = attributes["description"]?.trim() || extractFirstMeaningfulBodyLine(body);
  const summary = summarySource ? truncateText(summarySource, 140).replace(/\n/gu, " ") : undefined;
  const memoryType = parseWorkspaceMemoryType(attributes["type"]);

  return {
    path: input.filePath,
    rawContent: input.rawContent,
    bodyText: truncateText(body.trim(), WORKSPACE_MEMORY_RECALL_BODY_MAX_CHARS),
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    ...(memoryType ? { memoryType } : {}),
    mtimeMs: input.mtimeMs
  };
}

function buildRecallManifest(shortlist: Array<{ topic: WorkspaceMemoryTopicFile; score: number }>): string {
  return shortlist
    .map(({ topic, score }) =>
      [
        `- path: ${topic.path}`,
        topic.memoryType ? `  type: ${topic.memoryType}` : undefined,
        topic.title ? `  title: ${topic.title}` : undefined,
        topic.summary ? `  summary: ${topic.summary}` : undefined,
        `  freshness: ${new Date(topic.mtimeMs).toISOString()}`,
        `  heuristic_score: ${score}`
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n");
}

function parseSelectedMemoryPaths(responseText: string, allowedPaths: ReadonlySet<string>): string[] {
  const trimmed = responseText.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as { paths?: unknown };
    if (!Array.isArray(parsed.paths)) {
      return [];
    }

    return parsed.paths
      .filter((value): value is string => typeof value === "string" && allowedPaths.has(value))
      .slice(0, WORKSPACE_MEMORY_RECALL_MAX_FILES);
  } catch {
    const matches = trimmed.match(/\.openharness\/memory\/[^\s",\]]+\.md/gu) ?? [];
    const unique = new Set<string>();
    for (const match of matches) {
      if (allowedPaths.has(match)) {
        unique.add(match);
      }
      if (unique.size >= WORKSPACE_MEMORY_RECALL_MAX_FILES) {
        break;
      }
    }

    return [...unique];
  }
}

async function selectRelevantMemoryTopicPathsWithModel(input: {
  logger?: EngineLogger | undefined;
  modelGateway: ModelGateway;
  resolveModelForRun: (workspace: WorkspaceRecord, modelRef?: string | undefined) => WorkspaceMemoryResolvedModel;
  workspace: WorkspaceRecord;
  session: Session;
  run: Run;
  query: string;
  recentTools: string[];
  shortlist: Array<{ topic: WorkspaceMemoryTopicFile; score: number }>;
}): Promise<string[]> {
  if (input.shortlist.length === 0) {
    return [];
  }

  const manifest = buildRecallManifest(input.shortlist);
  const resolvedModel = input.resolveModelForRun(input.workspace, undefined);

  try {
    const response = await input.modelGateway.generate({
      model: resolvedModel.model,
      ...(resolvedModel.modelDefinition ? { modelDefinition: resolvedModel.modelDefinition } : {}),
      ...(resolvedModel.provider ? { provider: resolvedModel.provider } : {}),
      maxTokens: 220,
      messages: [
        {
          role: "system",
          content: WORKSPACE_MEMORY_SELECTOR_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: [
            "<current_turn>",
            input.query,
            "</current_turn>",
            "",
            input.recentTools.length > 0 ? `Recently used tools: ${input.recentTools.join(", ")}` : undefined,
            input.recentTools.length > 0 ? "" : undefined,
            "<available_workspace_memory_topics>",
            manifest,
            "</available_workspace_memory_topics>"
          ]
            .filter((line) => typeof line === "string")
            .join("\n")
        }
      ]
    });

    return parseSelectedMemoryPaths(response.text, new Set(input.shortlist.map(({ topic }) => topic.path)));
  } catch (error) {
    input.logger?.warn?.("Workspace memory recall selector failed.", {
      workspaceId: input.workspace.id,
      sessionId: input.session.id,
      runId: input.run.id,
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    return [];
  }
}

export async function selectRelevantWorkspaceMemoryTopics(input: {
  logger?: EngineLogger | undefined;
  modelGateway: ModelGateway;
  resolveModelForRun: (workspace: WorkspaceRecord, modelRef?: string | undefined) => WorkspaceMemoryResolvedModel;
  workspace: WorkspaceRecord;
  session: Session;
  run: Run;
  messages: Message[];
  topics: WorkspaceMemoryTopicFile[];
  alreadySurfacedPaths?: ReadonlySet<string> | undefined;
  hiddenMessagePredicate?: ((message: Message) => boolean) | undefined;
}): Promise<WorkspaceMemoryTopicFile[]> {
  const query = buildWorkspaceMemoryRecallQuery(input.messages, {
    hiddenMessagePredicate: input.hiddenMessagePredicate
  });
  const queryTokens = tokenizeWorkspaceMemoryRecallText(query);
  if (query.length === 0 || queryTokens.length === 0 || input.topics.length === 0) {
    return [];
  }

  const recentTools = extractRecentToolNames(input.messages);
  const ranked = input.topics
    .map((topic) => ({
      topic,
      score: scoreWorkspaceMemoryTopic(query, queryTokens, recentTools, topic)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || right.topic.mtimeMs - left.topic.mtimeMs || left.topic.path.localeCompare(right.topic.path));
  if (ranked.length === 0) {
    return [];
  }

  const freshRanked =
    input.alreadySurfacedPaths && input.alreadySurfacedPaths.size > 0
      ? ranked.filter((entry) => !input.alreadySurfacedPaths?.has(entry.topic.path))
      : ranked;
  const shortlistSource = freshRanked.length > 0 ? freshRanked : ranked;
  const shortlist = shortlistSource.slice(0, WORKSPACE_MEMORY_RECALL_SHORTLIST_MAX_FILES);
  const selectedPaths = await selectRelevantMemoryTopicPathsWithModel({
    logger: input.logger,
    modelGateway: input.modelGateway,
    resolveModelForRun: input.resolveModelForRun,
    workspace: input.workspace,
    session: input.session,
    run: input.run,
    query,
    recentTools,
    shortlist
  });
  const shortlistByPath = new Map(shortlist.map((entry) => [entry.topic.path, entry.topic]));
  const selectedFromModel = selectedPaths
    .map((selectedPath) => shortlistByPath.get(selectedPath))
    .filter((topic): topic is WorkspaceMemoryTopicFile => Boolean(topic));
  const candidateTopics = selectedFromModel.length > 0 ? selectedFromModel : shortlist.map((entry) => entry.topic);

  const selected: WorkspaceMemoryTopicFile[] = [];
  let totalChars = 0;
  for (const topic of candidateTopics) {
    if (selected.length >= WORKSPACE_MEMORY_RECALL_MAX_FILES) {
      break;
    }

    const trimmed = topic.rawContent.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const truncatedContent = truncateText(trimmed, WORKSPACE_MEMORY_RECALL_FILE_MAX_CHARS);
    if (selected.length > 0 && totalChars + truncatedContent.length > WORKSPACE_MEMORY_RECALL_TOTAL_MAX_CHARS) {
      continue;
    }

    selected.push({
      ...topic,
      rawContent: truncatedContent
    });
    totalChars += truncatedContent.length;
  }

  return selected;
}
