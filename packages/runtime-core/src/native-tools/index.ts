import { stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { AppError } from "../errors.js";
import type { RuntimeToolSet } from "../types.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createGlobTool } from "./glob.js";
import { createGrepTool } from "./grep.js";
import { createReadTool } from "./read.js";
import { READ_STATE_DIRECTORY, TODO_STATE_DIRECTORY } from "./constants.js";
import { ensureParentDirectory, readJsonFile } from "./fs-utils.js";
import { createTodoWriteTool } from "./todo-write.js";
import { createWebFetchTool } from "./web-fetch.js";
import { createWriteTool } from "./write.js";
import {
  type NativeToolFactoryContext,
  type NativeToolSetOptions,
  type NativeToolName,
  NATIVE_TOOL_NAMES,
  getNativeToolRetryPolicy,
  isNativeToolName
} from "./types.js";

export { NATIVE_TOOL_NAMES, getNativeToolRetryPolicy, isNativeToolName };
export type { NativeToolName, NativeToolSetOptions };

export function createNativeToolSet(
  workspaceRoot: string,
  getVisibleToolNames: () => string[],
  options?: NativeToolSetOptions
): RuntimeToolSet {
  const sessionId = options?.sessionId ?? "default-session";
  const readHistoryPath = path.join(workspaceRoot, ...READ_STATE_DIRECTORY, `${sessionId}.json`);
  const todoPath = path.join(workspaceRoot, ...TODO_STATE_DIRECTORY, `${sessionId}.json`);

  const context: NativeToolFactoryContext = {
    workspaceRoot,
    sessionId,
    readHistoryPath,
    todoPath,
    options,
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
    async rememberRead(relativePath) {
      const existing = await readJsonFile<string[]>(readHistoryPath, []);
      if (!existing.includes(relativePath)) {
        await ensureParentDirectory(readHistoryPath);
        await writeFile(readHistoryPath, JSON.stringify([...existing, relativePath].sort(), null, 2), "utf8");
      }
    },
    async assertReadBeforeMutating(relativePath, toolName) {
      const entry = await stat(path.join(workspaceRoot, relativePath)).catch(() => null);
      if (!entry?.isFile()) {
        return;
      }

      const readHistory = await readJsonFile<string[]>(readHistoryPath, []);
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
    ...createBashTool(context),
    ...createReadTool(context),
    ...createWriteTool(context),
    ...createEditTool(context),
    ...createGlobTool(context),
    ...createGrepTool(context),
    ...createWebFetchTool(context),
    ...createTodoWriteTool(context)
  };
}
