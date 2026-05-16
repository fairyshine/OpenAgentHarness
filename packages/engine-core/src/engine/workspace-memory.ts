import path from "node:path";

import type { Message, Run, Session } from "@oah/api-contracts";

import type {
  EngineLogger,
  ModelGateway,
  MessageRepository,
  RunQueuePriority,
  RunRepository,
  RunStepRepository,
  SessionRepository,
  WorkspaceFileAccessProvider,
  WorkspaceFileSystem,
  WorkspaceRecord
} from "../types.js";
import type { ContextPreparationModule, ContextPreparationModuleInput } from "./context-modules.js";
import type { EngineMessage } from "./engine-messages.js";
import { extractMessageDisplayText, hasMeaningfulText } from "./session-history.js";
import { getErrorCode, renderMessagesForMemory, selectMessagesSinceId, truncateText } from "./memory-support.js";
import { WORKSPACE_MEMORY_EXTRACTOR_AGENT_NAME, isWorkspaceMemoryExtractionRun } from "./workspace-memory-agent.js";
import {
  parseWorkspaceMemoryTopicFile,
  type WorkspaceMemoryResolvedModel,
  type WorkspaceMemoryTopicFile,
  selectRelevantWorkspaceMemoryTopics
} from "./workspace-memory-recall.js";
import {
  WORKSPACE_MEMORY_FRONTMATTER_TEMPLATE_LINES,
  WORKSPACE_MEMORY_SAVE_GUIDANCE_LINES,
  WORKSPACE_MEMORY_TYPE_GUIDANCE_LINES
} from "./workspace-memory-taxonomy.js";
import { resolveEffectiveWorkspaceMemoryWritePolicy } from "./workspace-memory-policy.js";

const WORKSPACE_MEMORY_DIRECTORY = ".openharness/memory";
const WORKSPACE_MEMORY_PATH = `${WORKSPACE_MEMORY_DIRECTORY}/MEMORY.md`;
const WORKSPACE_MEMORY_TOPICS_DIRECTORY = `${WORKSPACE_MEMORY_DIRECTORY}/topics`;
const WORKSPACE_MEMORY_SESSIONS_DIRECTORY = `${WORKSPACE_MEMORY_DIRECTORY}/sessions`;
const WORKSPACE_MEMORY_CONTEXT_MAX_CHARS = 6_000;
const WORKSPACE_MEMORY_TRANSCRIPT_MAX_CHARS = 12_000;
const WORKSPACE_MEMORY_FLUSH_MAX_CHARS = 12_000;
const WORKSPACE_MEMORY_TAG = "workspace-memory";
const WORKSPACE_MEMORY_TOPIC_TAG = "workspace-memory-topic";
const WORKSPACE_MEMORY_RECALL_STEP_NAME = "workspace_memory_recall";

const WORKSPACE_MEMORY_CONTEXT_PREFIX = [
  "Workspace memory loaded from `.openharness/memory/MEMORY.md`.",
  "Use it as long-lived project context, but verify concrete code facts against the current workspace before relying on them."
].join(" ");

const WORKSPACE_MEMORY_TOPIC_CONTEXT_PREFIX = [
  "Relevant workspace memory topic recalled for this turn.",
  "Treat it as durable project guidance, but re-check live repo details before acting on them."
].join(" ");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHiddenEngineMemoryMessage(message: Message): boolean {
  if (!isRecord(message.metadata)) {
    return false;
  }

  if (Array.isArray(message.metadata.tags) && message.metadata.tags.includes("session-memory")) {
    return true;
  }

  const extra = isRecord(message.metadata.extra) ? message.metadata.extra : undefined;
  return extra?.["memoryKind"] === "session";
}

function buildWorkspaceMemoryContext(content: string): string {
  return `<workspace_memory path="${WORKSPACE_MEMORY_PATH}">\n${WORKSPACE_MEMORY_CONTEXT_PREFIX}\n\n${content}\n</workspace_memory>`;
}

function buildWorkspaceMemoryTopicContext(filePath: string, content: string): string {
  return `<workspace_memory_file path="${filePath}">\n${WORKSPACE_MEMORY_TOPIC_CONTEXT_PREFIX}\n\n${content}\n</workspace_memory_file>`;
}

function buildExtractionTaskPrompt(existingMemories: string, transcript: string): string {
  return [
    `Memory directory: ${WORKSPACE_MEMORY_DIRECTORY}/`,
    `Index path: ${WORKSPACE_MEMORY_PATH}`,
    "",
    "Update the durable workspace memory directory for this repository.",
    "Use only the conversation delta below. Do not inspect source code or git history.",
    "If a relevant topic file already exists, update it instead of creating a duplicate.",
    "When you save a durable memory, write it to a topic file and keep MEMORY.md as a concise index of one-line links or hooks.",
    "If no durable memory change is warranted, do not write any memory files and explain briefly that no memory update was needed.",
    "",
    ...WORKSPACE_MEMORY_TYPE_GUIDANCE_LINES,
    "",
    ...WORKSPACE_MEMORY_SAVE_GUIDANCE_LINES,
    "",
    "Use this frontmatter format in topic files:",
    ...WORKSPACE_MEMORY_FRONTMATTER_TEMPLATE_LINES,
    "",
    "Current memory manifest:",
    existingMemories.length > 0 ? existingMemories : "(memory directory is currently empty)",
    "",
    "<conversation_delta>",
    transcript,
    "</conversation_delta>"
  ].join("\n");
}

function slugifyWorkspaceMemoryTitle(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 72);
  return slug || "memory";
}

function escapeWorkspaceMemoryFrontmatterValue(value: string): string {
  return JSON.stringify(value.replace(/\r?\n/gu, " ").trim());
}

function buildCompactionFlushContent(input: {
  session: Session;
  run: Run;
  capturedAt: string;
  summarizedMessageCount: number;
  compactThroughMessageId?: string | undefined;
  transcript: string;
}): string {
  const title = `Compaction flush ${input.capturedAt.slice(0, 10)}`;
  return [
    "---",
    `name: ${escapeWorkspaceMemoryFrontmatterValue(title)}`,
    "description: \"Session context preserved before compaction.\"",
    "type: session",
    `session_id: ${escapeWorkspaceMemoryFrontmatterValue(input.session.id)}`,
    `run_id: ${escapeWorkspaceMemoryFrontmatterValue(input.run.id)}`,
    `captured_at: ${escapeWorkspaceMemoryFrontmatterValue(input.capturedAt)}`,
    `reason: "before_compaction"`,
    `summarized_message_count: ${input.summarizedMessageCount}`,
    ...(input.compactThroughMessageId ? [`compact_through_message_id: ${escapeWorkspaceMemoryFrontmatterValue(input.compactThroughMessageId)}`] : []),
    "---",
    "",
    `# ${title}`,
    "",
    "Preserved before context compaction. This is low-weight session memory for search and later consolidation.",
    "",
    "## Transcript",
    "",
    input.transcript.trim(),
    ""
  ].join("\n");
}

export interface WorkspaceMemoryServiceDependencies {
  logger?: EngineLogger | undefined;
  modelGateway: ModelGateway;
  messageRepository: Pick<MessageRepository, "create" | "listBySessionId">;
  sessionRepository: Pick<SessionRepository, "create" | "listByWorkspaceId">;
  runRepository: Pick<RunRepository, "create" | "getById" | "listBySessionId">;
  runStepRepository: Pick<RunStepRepository, "listByRunId">;
  enqueueRun: (
    sessionId: string,
    runId: string,
    options?: { priority?: RunQueuePriority | undefined }
  ) => Promise<void>;
  workspaceFileSystem: WorkspaceFileSystem;
  workspaceFileAccessProvider?: WorkspaceFileAccessProvider | undefined;
  resolveModelForRun: (
    workspace: WorkspaceRecord,
    modelRef?: string | undefined
  ) => WorkspaceMemoryResolvedModel;
  recordSystemStep: (run: Run, name: string, output?: Record<string, unknown> | undefined) => Promise<unknown>;
  createId: (prefix: string) => string;
  nowIso: () => string;
}

export class WorkspaceMemoryService implements ContextPreparationModule {
  readonly name = "workspace_memory";
  readonly #logger?: EngineLogger | undefined;
  readonly #modelGateway: WorkspaceMemoryServiceDependencies["modelGateway"];
  readonly #messageRepository: WorkspaceMemoryServiceDependencies["messageRepository"];
  readonly #sessionRepository: WorkspaceMemoryServiceDependencies["sessionRepository"];
  readonly #runRepository: WorkspaceMemoryServiceDependencies["runRepository"];
  readonly #runStepRepository: WorkspaceMemoryServiceDependencies["runStepRepository"];
  readonly #enqueueRun: WorkspaceMemoryServiceDependencies["enqueueRun"];
  readonly #workspaceFileSystem: WorkspaceMemoryServiceDependencies["workspaceFileSystem"];
  readonly #workspaceFileAccessProvider: WorkspaceMemoryServiceDependencies["workspaceFileAccessProvider"];
  readonly #resolveModelForRun: WorkspaceMemoryServiceDependencies["resolveModelForRun"];
  readonly #recordSystemStep: WorkspaceMemoryServiceDependencies["recordSystemStep"];
  readonly #createId: WorkspaceMemoryServiceDependencies["createId"];
  readonly #nowIso: WorkspaceMemoryServiceDependencies["nowIso"];
  readonly #updateChains = new Map<string, Promise<void>>();
  readonly #recalledPathsByRunId = new Map<string, string[]>();

  constructor(dependencies: WorkspaceMemoryServiceDependencies) {
    this.#logger = dependencies.logger;
    this.#modelGateway = dependencies.modelGateway;
    this.#messageRepository = dependencies.messageRepository;
    this.#sessionRepository = dependencies.sessionRepository;
    this.#runRepository = dependencies.runRepository;
    this.#runStepRepository = dependencies.runStepRepository;
    this.#enqueueRun = dependencies.enqueueRun;
    this.#workspaceFileSystem = dependencies.workspaceFileSystem;
    this.#workspaceFileAccessProvider = dependencies.workspaceFileAccessProvider;
    this.#resolveModelForRun = dependencies.resolveModelForRun;
    this.#recordSystemStep = dependencies.recordSystemStep;
    this.#createId = dependencies.createId;
    this.#nowIso = dependencies.nowIso;
  }

  isEnabled(workspace: WorkspaceRecord): boolean {
    return workspace.settings.engine?.workspaceMemory?.enabled ?? false;
  }

  async prepareMessagesForModelInput(input: ContextPreparationModuleInput): Promise<EngineMessage[]> {
    if (!this.isEnabled(input.workspace) || isWorkspaceMemoryExtractionRun(input.run)) {
      return input.engineMessages;
    }

    const [memoryContent, relevantTopics] = await Promise.all([
      this.#readWorkspaceFile(input.workspace, WORKSPACE_MEMORY_PATH),
      this.#selectRelevantMemoryTopics(input.workspace, input.session, input.run, input.messages)
    ]);
    this.#rememberRecallSelection(input.run.id, relevantTopics.map((topic) => topic.path));
    const injectedMessages: EngineMessage[] = [];
    const trimmed = memoryContent?.trim();
    if (trimmed) {
      injectedMessages.push({
        id: this.#createId("engmsg"),
        sessionId: input.session.id,
        runId: input.run.id,
        role: "system",
        kind: "system_note",
        content: buildWorkspaceMemoryContext(truncateText(trimmed, WORKSPACE_MEMORY_CONTEXT_MAX_CHARS)),
        createdAt: this.#nowIso(),
        metadata: {
          runtimeKind: "system_note",
          synthetic: true,
          visibleInTranscript: false,
          eligibleForModelContext: true,
          source: "system",
          tags: [WORKSPACE_MEMORY_TAG],
          extra: {
            path: WORKSPACE_MEMORY_PATH
          }
        }
      });
    }

    for (const topic of relevantTopics) {
      const content = topic.rawContent.trim();
      if (!content) {
        continue;
      }

      injectedMessages.push({
        id: this.#createId("engmsg"),
        sessionId: input.session.id,
        runId: input.run.id,
        role: "system",
        kind: "system_note",
        content: buildWorkspaceMemoryTopicContext(topic.path, content),
        createdAt: this.#nowIso(),
        metadata: {
          runtimeKind: "system_note",
          synthetic: true,
          visibleInTranscript: false,
          eligibleForModelContext: true,
          source: "system",
          tags: [WORKSPACE_MEMORY_TAG, WORKSPACE_MEMORY_TOPIC_TAG],
          extra: {
            path: topic.path,
            recalled: true
          }
        }
      });
    }

    if (injectedMessages.length === 0) {
      return input.engineMessages;
    }

    return [
      ...input.engineMessages,
      ...injectedMessages
    ];
  }

  async recordRecallForCompletedRun(run: Run): Promise<void> {
    const recalledPaths = this.#recalledPathsByRunId.get(run.id) ?? [];
    this.#recalledPathsByRunId.delete(run.id);
    if (recalledPaths.length === 0) {
      return;
    }

    await this.#recordSystemStep(run, WORKSPACE_MEMORY_RECALL_STEP_NAME, {
      recalledPaths
    });
  }

  #rememberRecallSelection(runId: string, recalledPaths: string[]): void {
    if (recalledPaths.length === 0) {
      this.#recalledPathsByRunId.delete(runId);
      return;
    }

    this.#recalledPathsByRunId.set(runId, [...new Set(recalledPaths)]);
  }

  scheduleBackgroundUpdate(input: {
    workspace: WorkspaceRecord;
    session: Session;
    run: Run;
  }): void {
    if (
      !this.isEnabled(input.workspace) ||
      resolveEffectiveWorkspaceMemoryWritePolicy({
        workspace: input.workspace,
        agentName: input.run.effectiveAgentName,
        session: input.session,
        run: input.run
      }) !== "auto-extract" ||
      input.workspace.readOnly ||
      input.workspace.kind !== "project" ||
      isWorkspaceMemoryExtractionRun(input.run)
    ) {
      return;
    }

    const updateKey = input.workspace.id;
    const previous = this.#updateChains.get(updateKey) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => this.#updateWorkspaceMemory(input))
      .catch((error) => {
        this.#logger?.warn?.("Background workspace memory update failed.", {
          workspaceId: input.workspace.id,
          sessionId: input.session.id,
          runId: input.run.id,
          errorMessage: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => {
        if (this.#updateChains.get(updateKey) === next) {
          this.#updateChains.delete(updateKey);
        }
      });

    this.#updateChains.set(updateKey, next);
  }

  async captureBeforeCompaction(input: {
    workspace: WorkspaceRecord;
    session: Session;
    run: Run;
    messages: Message[];
    summarizedMessageCount: number;
    compactThroughMessageId?: string | undefined;
  }): Promise<{ captured: boolean; path?: string | undefined; reason?: string | undefined }> {
    if (!this.isEnabled(input.workspace) || input.workspace.readOnly || input.workspace.kind !== "project") {
      return {
        captured: false,
        reason: "disabled"
      };
    }

    const transcript = truncateText(renderMessagesForMemory(input.messages), WORKSPACE_MEMORY_FLUSH_MAX_CHARS).trim();
    if (!transcript) {
      return {
        captured: false,
        reason: "empty"
      };
    }

    const capturedAt = this.#nowIso();
    const fileName = `${capturedAt.slice(0, 10)}-compact-${slugifyWorkspaceMemoryTitle(input.session.title || input.session.id)}-${input.run.id}.md`;
    const relativePath = `${WORKSPACE_MEMORY_SESSIONS_DIRECTORY}/${fileName}`;
    await this.#withWorkspaceFileAccess(input.workspace, "write", relativePath, async (leasedWorkspace) => {
      const absolutePath = path.join(leasedWorkspace.rootPath, relativePath);
      await this.#workspaceFileSystem.mkdir(path.dirname(absolutePath), { recursive: true });
      await this.#workspaceFileSystem.writeFile(
        absolutePath,
        Buffer.from(
          buildCompactionFlushContent({
            session: input.session,
            run: input.run,
            capturedAt,
            summarizedMessageCount: input.summarizedMessageCount,
            compactThroughMessageId: input.compactThroughMessageId,
            transcript
          }),
          "utf8"
        )
      );
    });

    await this.#recordSystemStep(input.run, "workspace_memory_compaction_flush", {
      path: relativePath,
      summarizedMessageCount: input.summarizedMessageCount,
      ...(input.compactThroughMessageId ? { compactThroughMessageId: input.compactThroughMessageId } : {})
    });

    return {
      captured: true,
      path: relativePath
    };
  }

  async #updateWorkspaceMemory(input: {
    workspace: WorkspaceRecord;
    session: Session;
    run: Run;
  }): Promise<void> {
    const messages = (await this.#messageRepository.listBySessionId(input.session.id)).filter(
      (message) => !isHiddenEngineMemoryMessage(message)
    );
    const [lastExtractedMessageId, existingMemories] = await Promise.all([
      this.#readLastExtractedMessageId(input.workspace, input.session.id),
      this.#buildMemoryManifest(input.workspace)
    ]);
    const deltaMessages = selectMessagesSinceId(messages, lastExtractedMessageId);
    const latestMessageId = messages.at(-1)?.id;
    if (deltaMessages.length === 0 || !latestMessageId) {
      return;
    }

    const transcript = truncateText(renderMessagesForMemory(deltaMessages), WORKSPACE_MEMORY_TRANSCRIPT_MAX_CHARS).trim();
    if (transcript.length === 0) {
      return;
    }

    const childSessionId = this.#createId("ses");
    const childRunId = this.#createId("run");
    const now = this.#nowIso();
    const resolvedParentModel = this.#resolveModelForRun(
      input.workspace,
      input.session.modelRef ?? input.workspace.agents[input.run.effectiveAgentName]?.modelRef
    );

    await this.#sessionRepository.create({
      id: childSessionId,
      workspaceId: input.workspace.id,
      parentSessionId: input.session.id,
      subjectRef: input.session.subjectRef,
      ...(input.session.modelRef ? { modelRef: input.session.modelRef } : {}),
      agentName: WORKSPACE_MEMORY_EXTRACTOR_AGENT_NAME,
      activeAgentName: WORKSPACE_MEMORY_EXTRACTOR_AGENT_NAME,
      title: "Workspace Memory Extractor",
      status: "active",
      createdAt: now,
      updatedAt: now
    });
    await this.#messageRepository.create({
      id: this.#createId("msg"),
      sessionId: childSessionId,
      runId: childRunId,
      role: "user",
      content: buildExtractionTaskPrompt(existingMemories, transcript),
      metadata: {
        source: "engine",
        synthetic: true,
        visibleInTranscript: false,
        eligibleForModelContext: true,
        tags: [WORKSPACE_MEMORY_TAG],
        extra: {
          memoryKind: "workspace",
          workspaceMemoryExtraction: true,
          parentRunId: input.run.id,
          parentSessionId: input.session.id,
          path: WORKSPACE_MEMORY_PATH,
          memoryDirectory: WORKSPACE_MEMORY_DIRECTORY,
          lastExtractedMessageId: latestMessageId
        }
      },
      createdAt: now
    });
    await this.#runRepository.create({
      id: childRunId,
      workspaceId: input.workspace.id,
      sessionId: childSessionId,
      parentRunId: input.run.id,
      initiatorRef: input.run.initiatorRef ?? input.session.subjectRef,
      triggerType: "system",
      triggerRef: "engine.workspace_memory",
      agentName: WORKSPACE_MEMORY_EXTRACTOR_AGENT_NAME,
      effectiveAgentName: WORKSPACE_MEMORY_EXTRACTOR_AGENT_NAME,
      switchCount: 0,
      status: "queued",
      createdAt: now,
      metadata: {
        parentRunId: input.run.id,
        parentSessionId: input.session.id,
        parentAgentName: input.run.effectiveAgentName,
        workspaceMemoryExtraction: true,
        workspaceMemoryPath: WORKSPACE_MEMORY_PATH,
        workspaceMemoryDirectory: WORKSPACE_MEMORY_DIRECTORY,
        lastExtractedMessageId: latestMessageId,
        summarizedMessageCount: deltaMessages.length,
        inheritedModelRef: resolvedParentModel.canonicalModelRef
      }
    });

    await this.#recordSystemStep(input.run, "workspace_memory_extract_queued", {
      path: WORKSPACE_MEMORY_PATH,
      childSessionId,
      childRunId,
      summarizedMessageCount: deltaMessages.length,
      lastExtractedMessageId: latestMessageId
    });
    await this.#enqueueRun(childSessionId, childRunId, {
      priority: "subagent"
    });

    const childRun = await this.#waitForRunTerminalState(childRunId);
    if (childRun.status !== "completed") {
      await this.#recordSystemStep(input.run, "workspace_memory_update_failed", {
        path: WORKSPACE_MEMORY_PATH,
        childSessionId,
        childRunId,
        status: childRun.status,
        ...(childRun.errorCode ? { errorCode: childRun.errorCode } : {}),
        ...(childRun.errorMessage ? { errorMessage: childRun.errorMessage } : {})
      });
      return;
    }

    const childMessages = await this.#messageRepository.listBySessionId(childSessionId);
    const wroteMemory = this.#didWriteWorkspaceMemory(childMessages);
    await this.#recordSystemStep(input.run, "workspace_memory_update", {
      path: WORKSPACE_MEMORY_PATH,
      childSessionId,
      childRunId,
      wroteMemory,
      summarizedMessageCount: deltaMessages.length,
      lastExtractedMessageId: latestMessageId
    });
  }

  async #waitForRunTerminalState(runId: string): Promise<Run> {
    while (true) {
      const run = await this.#runRepository.getById(runId);
      if (run && this.#isRunTerminal(run.status)) {
        return run;
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  #isRunTerminal(status: Run["status"]): boolean {
    return status === "completed" || status === "failed" || status === "cancelled" || status === "timed_out";
  }

  #didWriteWorkspaceMemory(messages: Message[]): boolean {
    return messages.some((message) => {
      if (
        message.role !== "tool" ||
        !Array.isArray(message.content) ||
        !message.content.some(
          (part) =>
            part.type === "tool-result" &&
            (part.toolName === "Write" || part.toolName === "Edit")
        )
      ) {
        return false;
      }

      const rendered = extractMessageDisplayText(message);
      return hasMeaningfulText(rendered) && rendered.includes(`file_path: ${WORKSPACE_MEMORY_DIRECTORY}/`);
    });
  }

  async #readWorkspaceFile(workspace: WorkspaceRecord, relativePath: string): Promise<string | undefined> {
    return this.#withWorkspaceFileAccess(workspace, "read", relativePath, async (leasedWorkspace) => {
      const absolutePath = path.join(leasedWorkspace.rootPath, relativePath);
      try {
        return (await this.#workspaceFileSystem.readFile(absolutePath)).toString("utf8");
      } catch (error) {
        if (getErrorCode(error) === "ENOENT") {
          return undefined;
        }

        throw error;
      }
    });
  }

  async #readLastExtractedMessageId(workspace: WorkspaceRecord, parentSessionId: string): Promise<string | undefined> {
    const sessions = await this.#listWorkspaceSessions(workspace.id);
    const extractorSessions = sessions.filter(
      (session) => session.parentSessionId === parentSessionId && session.activeAgentName === WORKSPACE_MEMORY_EXTRACTOR_AGENT_NAME
    );
    if (extractorSessions.length === 0) {
      return undefined;
    }

    const extractorRuns = (
      await Promise.all(extractorSessions.map(async (session) => this.#runRepository.listBySessionId(session.id)))
    )
      .flat()
      .filter(
        (run) =>
          run.status === "completed" &&
          run.metadata?.workspaceMemoryExtraction === true &&
          run.metadata?.parentSessionId === parentSessionId &&
          typeof run.metadata?.lastExtractedMessageId === "string"
      )
      .sort((left, right) => {
        const leftTime = left.endedAt ?? left.createdAt;
        const rightTime = right.endedAt ?? right.createdAt;
        return rightTime.localeCompare(leftTime);
      });

    const latest = extractorRuns[0];
    return typeof latest?.metadata?.lastExtractedMessageId === "string" ? latest.metadata.lastExtractedMessageId : undefined;
  }

  async #listWorkspaceSessions(workspaceId: string): Promise<Session[]> {
    const sessions: Session[] = [];
    let cursor: string | undefined;

    while (true) {
      const page = await this.#sessionRepository.listByWorkspaceId(workspaceId, 200, cursor);
      sessions.push(...page);
      if (page.length < 200) {
        return sessions;
      }

      cursor = String(sessions.length);
    }
  }

  async #buildMemoryManifest(workspace: WorkspaceRecord): Promise<string> {
    const entries = await this.#readMemoryTopicFiles(workspace);
    if (entries.length === 0) {
      return "";
    }

    return entries
      .map((entry) => `- ${entry.memoryType ? `[${entry.memoryType}] ` : ""}${entry.path}${entry.summary ? ` — ${entry.summary}` : ""}`)
      .join("\n");
  }

  async #selectRelevantMemoryTopics(
    workspace: WorkspaceRecord,
    session: Session,
    run: Run,
    messages: Message[]
  ): Promise<WorkspaceMemoryTopicFile[]> {
    const alreadySurfacedPaths = await this.#readRecentlyRecalledPaths(session.id, run.id);

    return selectRelevantWorkspaceMemoryTopics({
      logger: this.#logger,
      modelGateway: this.#modelGateway,
      resolveModelForRun: this.#resolveModelForRun,
      workspace,
      session,
      run,
      messages,
      topics: await this.#readMemoryTopicFiles(workspace),
      alreadySurfacedPaths,
      hiddenMessagePredicate: (message) => isHiddenEngineMemoryMessage(message)
    });
  }

  async #readRecentlyRecalledPaths(sessionId: string, currentRunId: string): Promise<Set<string>> {
    const previousCompletedRun = (await this.#runRepository.listBySessionId(sessionId))
      .filter((run) => run.id !== currentRunId && run.status === "completed")
      .sort((left, right) => (right.endedAt ?? right.createdAt).localeCompare(left.endedAt ?? left.createdAt))[0];
    if (!previousCompletedRun) {
      return new Set();
    }

    const recallStep = (await this.#runStepRepository.listByRunId(previousCompletedRun.id))
      .filter((step) => step.name === WORKSPACE_MEMORY_RECALL_STEP_NAME)
      .at(-1);
    const recallOutput = recallStep?.output as { recalledPaths?: unknown } | undefined;
    const recalledPaths = Array.isArray(recallOutput?.recalledPaths)
      ? recallOutput.recalledPaths.filter((value): value is string => typeof value === "string")
      : [];

    return new Set(recalledPaths);
  }

  async #readMemoryTopicFiles(workspace: WorkspaceRecord): Promise<WorkspaceMemoryTopicFile[]> {
    return this.#withWorkspaceFileAccess(workspace, "read", WORKSPACE_MEMORY_TOPICS_DIRECTORY, async (leasedWorkspace) => {
      const root = path.join(leasedWorkspace.rootPath, WORKSPACE_MEMORY_TOPICS_DIRECTORY);
      const discovered: WorkspaceMemoryTopicFile[] = [];

      const walk = async (absoluteDirectory: string, relativeDirectory: string): Promise<void> => {
        let entries;
        try {
          entries = await this.#workspaceFileSystem.readdir(absoluteDirectory);
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
            await walk(absoluteEntryPath, relativeEntryPath);
            continue;
          }

          if (
            entry.kind !== "file" ||
            !entry.name.endsWith(".md") ||
            relativeEntryPath === "MEMORY.md"
          ) {
            continue;
          }

          let raw: string;
          let stat;
          try {
            raw = (await this.#workspaceFileSystem.readFile(absoluteEntryPath)).toString("utf8");
            stat = await this.#workspaceFileSystem.stat(absoluteEntryPath);
          } catch (error) {
            if (getErrorCode(error) === "ENOENT") {
              continue;
            }

            throw error;
          }

          discovered.push(
            parseWorkspaceMemoryTopicFile({
              filePath: `${WORKSPACE_MEMORY_TOPICS_DIRECTORY}/${relativeEntryPath}`,
              rawContent: raw,
              mtimeMs: stat.mtimeMs
            })
          );
        }
      };

      await walk(root, "");
      return discovered.sort((left, right) => left.path.localeCompare(right.path));
    });
  }

  async #withWorkspaceFileAccess<T>(
    workspace: WorkspaceRecord,
    access: "read" | "write",
    relativePath: string,
    operation: (workspace: WorkspaceRecord) => Promise<T>
  ): Promise<T> {
    if (!this.#workspaceFileAccessProvider) {
      return operation(workspace);
    }

    const lease = await this.#workspaceFileAccessProvider.acquire({
      workspace,
      access,
      path: relativePath
    });

    try {
      return await operation(lease.workspace);
    } finally {
      await lease.release({
        dirty: access === "write" && !lease.workspace.readOnly && lease.workspace.kind === "project"
      });
    }
  }
}
