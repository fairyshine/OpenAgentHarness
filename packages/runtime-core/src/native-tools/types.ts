import type { ActionRetryPolicy, ModelGateway } from "../types.js";
import { AppError } from "../errors.js";

export const NATIVE_TOOL_NAMES = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "WebFetch",
  "TodoWrite"
] as const;

export type NativeToolName = (typeof NATIVE_TOOL_NAMES)[number];

const NATIVE_TOOL_RETRY_POLICY: Record<NativeToolName, ActionRetryPolicy> = {
  Bash: "manual",
  Read: "safe",
  Write: "manual",
  Edit: "manual",
  Glob: "safe",
  Grep: "safe",
  WebFetch: "safe",
  TodoWrite: "manual"
};

export interface NativeToolSetOptions {
  sessionId?: string | undefined;
  modelGateway?: ModelGateway | undefined;
  webFetchModel?: string | undefined;
}

export interface NativeToolFactoryContext {
  workspaceRoot: string;
  sessionId: string;
  readHistoryPath: string;
  todoPath: string;
  options?: NativeToolSetOptions | undefined;
  assertVisible: (toolName: NativeToolName) => void;
  omitLegacyKeys: <T extends Record<string, unknown>>(value: T, keys: string[]) => Record<string, unknown>;
  rememberRead: (relativePath: string) => Promise<void>;
  assertReadBeforeMutating: (relativePath: string, toolName: "Write" | "Edit") => Promise<void>;
}

function normalizeNativeToolName(toolName: string): NativeToolName | undefined {
  if ((NATIVE_TOOL_NAMES as readonly string[]).includes(toolName)) {
    return toolName as NativeToolName;
  }

  return undefined;
}

export function isNativeToolName(toolName: string): toolName is NativeToolName {
  return normalizeNativeToolName(toolName) !== undefined;
}

export function getNativeToolRetryPolicy(toolName: string): ActionRetryPolicy {
  const normalized = normalizeNativeToolName(toolName);
  if (!normalized) {
    throw new AppError(404, "native_tool_not_found", `Native tool ${toolName} was not found.`);
  }

  return NATIVE_TOOL_RETRY_POLICY[normalized];
}
