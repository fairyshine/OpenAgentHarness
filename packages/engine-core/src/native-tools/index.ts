import path from "node:path";

import { AppError } from "../errors.js";
import type { EngineToolSet, WorkspaceFileSystem } from "../types.js";
import { createAskUserQuestionTool } from "./ask-user-question.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createGlobTool } from "./glob.js";
import { createGrepTool } from "./grep.js";
import { createLsTool } from "./ls.js";
import { createMemoryTools } from "./memory.js";
import { createMultiEditTool } from "./multi-edit.js";
import { createReadTool } from "./read.js";
import { READ_STATE_DIRECTORY, TODO_STATE_DIRECTORY } from "./constants.js";
import { ensureParentDirectory, readJsonFile } from "./fs-utils.js";
import { createTerminalInputTool } from "./terminal-input.js";
import { createTerminalOutputTool } from "./terminal-output.js";
import { createTerminalStopTool } from "./terminal-stop.js";
import { createTodoWriteTool } from "./todo-write.js";
import { createViewImageTool } from "./view-image.js";
import { createWebFetchTool } from "./web-fetch.js";
import { createWriteTool } from "./write.js";
import { createLocalWorkspaceCommandExecutor } from "../workspace/workspace-command-executor.js";
import { createLocalWorkspaceFileSystem } from "../workspace/workspace-file-system.js";
import { resolveWorkspacePath } from "./paths.js";
import {
  type NativeToolFactoryContext,
  type NativeToolSetOptions,
  type NativeToolName,
  NATIVE_TOOL_NAMES,
  PUBLIC_NATIVE_TOOL_NAMES,
  getNativeToolRetryPolicy,
  isNativeToolName
} from "./types.js";

const WORKSPACE_MEMORY_DIRECTORY = ".openharness/memory";

export { NATIVE_TOOL_NAMES, PUBLIC_NATIVE_TOOL_NAMES, getNativeToolRetryPolicy, isNativeToolName };
export type { NativeToolName, NativeToolSetOptions };

function normalizeToolPathForPolicy(targetPath: string): string {
  return targetPath.trim().replaceAll("\\", "/").replace(/^\/+/, "");
}

async function assertWorkspaceMemoryExtractionPathAllowed(input: {
  fileSystem: WorkspaceFileSystem;
  workspaceRoot: string;
  targetPath: string | undefined;
}): Promise<void> {
  if (!input.targetPath) {
    throw new AppError(
      403,
      "native_tool_workspace_memory_path_not_allowed",
      `Workspace memory extraction runs can only access files under ${WORKSPACE_MEMORY_DIRECTORY}/.`
    );
  }

  const resolved = await resolveWorkspacePath(input.fileSystem, input.workspaceRoot, input.targetPath);
  const normalizedPath = normalizeToolPathForPolicy(resolved.relativePath);
  if (normalizedPath === WORKSPACE_MEMORY_DIRECTORY || normalizedPath.startsWith(`${WORKSPACE_MEMORY_DIRECTORY}/`)) {
    return;
  }

  throw new AppError(
    403,
    "native_tool_workspace_memory_path_not_allowed",
    `Workspace memory extraction runs can only access files under ${WORKSPACE_MEMORY_DIRECTORY}/.`
  );
}

export function createNativeToolSet(
  workspaceRoot: string,
  getVisibleToolNames: () => string[],
  options?: NativeToolSetOptions
): EngineToolSet {
  const sessionId = options?.sessionId ?? "default-session";
  const readHistoryPath = path.join(workspaceRoot, ...READ_STATE_DIRECTORY, `${sessionId}.json`);
  const todoPath = path.join(workspaceRoot, ...TODO_STATE_DIRECTORY, `${sessionId}.json`);
  const commandExecutor = options?.commandExecutor ?? createLocalWorkspaceCommandExecutor();
  const fileSystem = options?.fileSystem ?? createLocalWorkspaceFileSystem();
  const workspaceFileAccessProvider = options?.workspaceFileAccessProvider;
  const workspace = options?.workspace;
  const restrictToWorkspaceMemory = options?.run?.metadata?.workspaceMemoryExtraction === true;

  const context: NativeToolFactoryContext = {
    workspaceRoot,
    sessionId,
    readHistoryPath,
    todoPath,
    options,
    commandExecutor,
    fileSystem,
    async withFileSystem(access, targetPath, operation) {
      if (restrictToWorkspaceMemory) {
        await assertWorkspaceMemoryExtractionPathAllowed({ fileSystem, workspaceRoot, targetPath });
      }

      if (!workspaceFileAccessProvider || !workspace) {
        return operation({ workspaceRoot, fileSystem, workspace });
      }

      const lease = await workspaceFileAccessProvider.acquire({
        workspace,
        access,
        ...(targetPath ? { path: targetPath } : {})
      });

      try {
        if (restrictToWorkspaceMemory) {
          await assertWorkspaceMemoryExtractionPathAllowed({
            fileSystem,
            workspaceRoot: lease.workspace.rootPath,
            targetPath
          });
        }

        return await operation({
          workspaceRoot: lease.workspace.rootPath,
          fileSystem,
          workspace: lease.workspace
        });
      } finally {
        await lease.release({
          dirty: access === "write" && !lease.workspace.readOnly && lease.workspace.kind === "project"
        });
      }
    },
    async readVirtualFile(input) {
      if (restrictToWorkspaceMemory) {
        await assertWorkspaceMemoryExtractionPathAllowed({ fileSystem, workspaceRoot, targetPath: input.filePath });
      }

      return options?.readVirtualFile?.(input) ?? null;
    },
    injectModelContextMessage(message) {
      options?.injectModelContextMessage?.(message);
    },
    assertVisible(toolName) {
      if (!getVisibleToolNames().includes(toolName)) {
        throw new AppError(403, "native_tool_not_allowed", `Native tool ${toolName} is not allowed for the active agent.`);
      }
    },
    omitLegacyKeys(value, keys) {
      const clone: Record<string, unknown> = { ...value };
      for (const key of keys) {
        delete clone[key];
      }
      return clone;
    },
    async rememberRead(relativePath, activeWorkspaceRoot = workspaceRoot, activeFileSystem = fileSystem) {
      const activeReadHistoryPath = path.join(activeWorkspaceRoot, ...READ_STATE_DIRECTORY, `${sessionId}.json`);
      const existing = await readJsonFile<string[]>(activeFileSystem, activeReadHistoryPath, []);
      if (!existing.includes(relativePath)) {
        await ensureParentDirectory(activeFileSystem, activeReadHistoryPath);
        await activeFileSystem.writeFile(activeReadHistoryPath, Buffer.from(JSON.stringify([...existing, relativePath].sort(), null, 2), "utf8"));
      }
    },
    async assertReadBeforeMutating(relativePath, toolName, activeWorkspaceRoot = workspaceRoot, activeFileSystem = fileSystem) {
      const activeReadHistoryPath = path.join(activeWorkspaceRoot, ...READ_STATE_DIRECTORY, `${sessionId}.json`);
      const entry = await activeFileSystem.stat(path.join(activeWorkspaceRoot, relativePath)).catch(() => null);
      if (entry?.kind !== "file") {
        return;
      }

      const readHistory = await readJsonFile<string[]>(activeFileSystem, activeReadHistoryPath, []);
      if (!readHistory.includes(relativePath)) {
        throw new AppError(
          400,
          "native_tool_read_required",
          `${toolName} requires the target file to be read first in the current session: ${relativePath}`
        );
      }
    }
  };

  return {
    ...createAskUserQuestionTool(context),
    ...createBashTool(context),
    ...createLsTool(context),
    ...createReadTool(context),
    ...createWriteTool(context),
    ...createEditTool(context),
    ...createMultiEditTool(context),
    ...createGlobTool(context),
    ...createGrepTool(context),
    ...createMemoryTools(context),
    ...createViewImageTool(context),
    ...createWebFetchTool(context),
    ...createTodoWriteTool(context),
    ...createTerminalOutputTool(context),
    ...createTerminalInputTool(context),
    ...createTerminalStopTool(context)
  };
}
