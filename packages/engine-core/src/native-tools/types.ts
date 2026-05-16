import type {
  ActionRetryPolicy,
  ModelGateway,
  WorkspaceCommandExecutor,
  WorkspaceFileAccessProvider,
  WorkspaceFileSystem,
  WorkspaceRecord
} from "../types.js";
import type { ChatMessage, Run, Session } from "@oah/api-contracts";
import { AppError } from "../errors.js";

export const PUBLIC_NATIVE_TOOL_NAMES = [
  "AskUserQuestion",
  "Bash",
  "LS",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "MemorySearch",
  "MemoryRead",
  "MemoryRemember",
  "MemoryUpdate",
  "MemoryForget",
  "MemoryCaptureSession",
  "MemoryAppendDaily",
  "MemoryRecordDream",
  "MemoryApplyProposal",
  "MemoryRejectProposal",
  "ViewImage",
  "WebFetch",
  "TodoWrite",
  "TerminalOutput",
  "TerminalInput",
  "TerminalStop"
] as const;

export const NATIVE_TOOL_NAMES = [...PUBLIC_NATIVE_TOOL_NAMES] as const;

export type NativeToolName = (typeof NATIVE_TOOL_NAMES)[number];

const NATIVE_TOOL_RETRY_POLICY: Record<NativeToolName, ActionRetryPolicy> = {
  AskUserQuestion: "safe",
  Bash: "manual",
  LS: "safe",
  Read: "safe",
  Write: "manual",
  Edit: "manual",
  MultiEdit: "manual",
  Glob: "safe",
  Grep: "safe",
  MemorySearch: "safe",
  MemoryRead: "safe",
  MemoryRemember: "manual",
  MemoryUpdate: "manual",
  MemoryForget: "manual",
  MemoryCaptureSession: "manual",
  MemoryAppendDaily: "manual",
  MemoryRecordDream: "manual",
  MemoryApplyProposal: "manual",
  MemoryRejectProposal: "manual",
  ViewImage: "safe",
  WebFetch: "safe",
  TodoWrite: "manual",
  TerminalOutput: "safe",
  TerminalInput: "manual",
  TerminalStop: "manual"
};

export interface NativeToolSetOptions {
  sessionId?: string | undefined;
  modelGateway?: ModelGateway | undefined;
  webFetchModel?: string | undefined;
  injectModelContextMessage?: ((message: ChatMessage) => void) | undefined;
  commandExecutor?: WorkspaceCommandExecutor | undefined;
  fileSystem?: WorkspaceFileSystem | undefined;
  workspace?: WorkspaceRecord | undefined;
  getActiveAgentName?: (() => string) | undefined;
  session?: Session | undefined;
  run?: Run | undefined;
  workspaceFileAccessProvider?: WorkspaceFileAccessProvider | undefined;
  readVirtualFile?: ((input: { filePath: string; abortSignal?: AbortSignal | undefined }) => Promise<{
    filePath: string;
    content: string;
  } | null>) | undefined;
}

export interface NativeToolFileAccess {
  workspaceRoot: string;
  fileSystem: WorkspaceFileSystem;
  workspace?: WorkspaceRecord | undefined;
}

export interface NativeToolFactoryContext {
  workspaceRoot: string;
  sessionId: string;
  readHistoryPath: string;
  todoPath: string;
  options?: NativeToolSetOptions | undefined;
  commandExecutor: WorkspaceCommandExecutor;
  fileSystem: WorkspaceFileSystem;
  withFileSystem: <T>(
    access: "read" | "write",
    targetPath: string | undefined,
    operation: (input: NativeToolFileAccess) => Promise<T>
  ) => Promise<T>;
  readVirtualFile: (input: { filePath: string; abortSignal?: AbortSignal | undefined }) => Promise<{
    filePath: string;
    content: string;
  } | null>;
  injectModelContextMessage: (message: ChatMessage) => void;
  assertVisible: (toolName: NativeToolName) => void;
  omitLegacyKeys: <T extends Record<string, unknown>>(value: T, keys: string[]) => Record<string, unknown>;
  rememberRead: (relativePath: string, workspaceRoot?: string, fileSystem?: WorkspaceFileSystem) => Promise<void>;
  assertReadBeforeMutating: (
    relativePath: string,
    toolName: "Write" | "Edit" | "MultiEdit",
    workspaceRoot?: string,
    fileSystem?: WorkspaceFileSystem
  ) => Promise<void>;
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
