import type { Readable } from "node:stream";
import type { CreateWorkspaceRequest, Run, Session, Workspace } from "@oah/api-contracts";

import type {
  ActionRetryPolicy,
  AgentMode,
  ModelDefinition,
  EngineWorkspaceCatalog,
  WorkspaceKind
} from "./engine.js";

export interface AgentDefinition {
  name: string;
  mode: AgentMode;
  description?: string | undefined;
  prompt: string;
  systemReminder?: string | undefined;
  modelRef?: string | undefined;
  temperature?: number | undefined;
  topP?: number | undefined;
  maxTokens?: number | undefined;
  background?: boolean | undefined;
  hidden?: boolean | undefined;
  color?: string | undefined;
  tools: {
    native?: string[] | undefined;
    external?: string[] | undefined;
    actions?: string[] | undefined;
    skills?: string[] | undefined;
  };
  actions?: string[] | undefined;
  skills?: string[] | undefined;
  disallowed?: {
    tools?: {
      native?: string[] | undefined;
      external?: string[] | undefined;
    } | undefined;
    actions?: string[] | undefined;
    skills?: string[] | undefined;
  } | undefined;
  switch: string[];
  subagents: string[];
  policy?: {
    maxSteps?: number | undefined;
    runTimeoutSeconds?: number | undefined;
    toolTimeoutSeconds?: number | undefined;
    parallelToolCalls?: boolean | undefined;
    maxConcurrentSubagents?: number | undefined;
  } | undefined;
}

export interface ActionDefinition {
  name: string;
  description: string;
  callableByApi: boolean;
  callableByUser: boolean;
  exposeToLlm: boolean;
  retryPolicy?: ActionRetryPolicy | undefined;
  inputSchema?: Record<string, unknown> | undefined;
  directory: string;
  entry: {
    command: string;
    environment?: Record<string, string> | undefined;
    cwd?: string | undefined;
    timeoutSeconds?: number | undefined;
  };
}

export interface SkillDefinition {
  name: string;
  description?: string | undefined;
  exposeToLlm: boolean;
  directory: string;
  sourceRoot: string;
  content: string;
}

export interface ToolServerDefinition {
  name: string;
  enabled: boolean;
  transportType: "stdio" | "http";
  toolPrefix?: string | undefined;
  command?: string | undefined;
  workingDirectory?: string | undefined;
  url?: string | undefined;
  environment?: Record<string, string> | undefined;
  headers?: Record<string, string> | undefined;
  timeout?: number | undefined;
  oauth?: boolean | Record<string, unknown> | undefined;
  include?: string[] | undefined;
  exclude?: string[] | undefined;
}

export interface HookDefinition {
  name: string;
  events: string[];
  matcher?: string | undefined;
  handlerType: "command" | "http" | "prompt" | "agent";
  capabilities: string[];
  definition: Record<string, unknown>;
}

export interface WorkspaceSystemPromptSettings {
  base?: {
    content: string;
  } | undefined;
  llmOptimized?: {
    providers?: Record<string, { content: string }> | undefined;
    models?: Record<string, { content: string }> | undefined;
  } | undefined;
  compose: {
    order: Array<
      | "base"
      | "llm_optimized"
      | "agent"
      | "actions"
      | "project_agents_md"
      | "skills"
      | "agent_switches"
      | "subagents"
      | "environment"
    >;
    includeEnvironment: boolean;
  };
}

export interface WorkspaceSettingsDefinition {
  defaultAgent?: string | undefined;
  runtime?: string | undefined;
  models?:
    | Record<
        string,
        {
          ref: string;
          temperature?: number | undefined;
          topP?: number | undefined;
          maxTokens?: number | undefined;
        }
      >
    | undefined;
  skillDirs?: string[] | undefined;
  engine?: WorkspaceEngineSettings | undefined;
  imports?:
    | {
        tools?: string[] | undefined;
        skills?: string[] | undefined;
      }
    | undefined;
  systemPrompt?: WorkspaceSystemPromptSettings | undefined;
}

export interface WorkspaceEngineSettings {
  compact?: WorkspaceEngineToggleSettings | undefined;
  sessionMemory?: WorkspaceEngineToggleSettings | undefined;
  workspaceMemory?: WorkspaceEngineToggleSettings | undefined;
}

export interface WorkspaceEngineToggleSettings {
  enabled?: boolean | undefined;
}

export interface WorkspaceRecord extends Workspace {
  kind: WorkspaceKind;
  readOnly: boolean;
  historyMirrorEnabled: boolean;
  defaultAgent?: string | undefined;
  projectAgentsMd?: string | undefined;
  settings: WorkspaceSettingsDefinition;
  workspaceModels: Record<string, ModelDefinition>;
  agents: Record<string, AgentDefinition>;
  actions: Record<string, ActionDefinition>;
  skills: Record<string, SkillDefinition>;
  toolServers: Record<string, ToolServerDefinition>;
  hooks: Record<string, HookDefinition>;
  catalog: EngineWorkspaceCatalog;
}

export interface WorkspaceInitializationResult {
  id?: string | undefined;
  rootPath: string;
  externalRef?: string | undefined;
  kind?: WorkspaceKind | undefined;
  readOnly?: boolean | undefined;
  defaultAgent?: string | undefined;
  projectAgentsMd?: string | undefined;
  settings: WorkspaceSettingsDefinition;
  workspaceModels: Record<string, ModelDefinition>;
  agents: Record<string, AgentDefinition>;
  actions: Record<string, ActionDefinition>;
  skills: Record<string, SkillDefinition>;
  toolServers: Record<string, ToolServerDefinition>;
  hooks: Record<string, HookDefinition>;
  catalog: EngineWorkspaceCatalog;
}

export interface WorkspaceInitializer {
  initialize(input: CreateWorkspaceRequest): Promise<WorkspaceInitializationResult>;
}

export interface WorkspaceDeletionHandler {
  deleteWorkspace(workspace: WorkspaceRecord): Promise<void>;
}

export interface WorkspaceExecutionLease {
  workspace: WorkspaceRecord;
  release(options?: { dirty?: boolean | undefined }): Promise<void> | void;
}

export interface WorkspaceExecutionProvider {
  acquire(input: {
    workspace: WorkspaceRecord;
    run: Run;
    session?: Session | undefined;
  }): Promise<WorkspaceExecutionLease>;
}

export interface WorkspaceFileAccessLease {
  workspace: WorkspaceRecord;
  release(options?: { dirty?: boolean | undefined }): Promise<void> | void;
}

export interface WorkspaceFileAccessProvider {
  acquire(input: {
    workspace: WorkspaceRecord;
    access: "read" | "write";
    path?: string | undefined;
  }): Promise<WorkspaceFileAccessLease>;
}

export type SandboxHostProviderKind = "embedded" | "self_hosted" | "e2b";

export interface SandboxHostDiagnostics {
  materialization?: Record<string, unknown> | undefined;
}

export interface WorkspaceForegroundCommandExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface WorkspaceBackgroundCommandExecutionResult {
  outputPath: string;
  taskId: string;
  pid: number;
}

export interface WorkspaceFileStat {
  kind: "file" | "directory" | "other";
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
  ino?: number | bigint | undefined;
}

export interface WorkspaceFileSystemEntry {
  name: string;
  kind: "file" | "directory" | "other";
  sizeBytes?: number | undefined;
  updatedAt?: string | undefined;
}

export interface WorkspaceFileSystem {
  realpath(targetPath: string): Promise<string>;
  stat(targetPath: string): Promise<WorkspaceFileStat>;
  readFile(targetPath: string): Promise<Buffer>;
  openReadStream(targetPath: string): Readable;
  readdir(targetPath: string): Promise<WorkspaceFileSystemEntry[]>;
  mkdir(targetPath: string, options?: { recursive?: boolean | undefined }): Promise<void>;
  writeFile(targetPath: string, data: Buffer, options?: { mtimeMs?: number | undefined }): Promise<void>;
  rm(targetPath: string, options?: { recursive?: boolean | undefined; force?: boolean | undefined }): Promise<void>;
  rename(sourcePath: string, targetPath: string): Promise<void>;
}

export interface WorkspaceCommandExecutor {
  runForeground(input: {
    workspace: WorkspaceRecord;
    command: string;
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
    timeoutMs?: number | undefined;
    stdinText?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<WorkspaceForegroundCommandExecutionResult>;
  runProcess(input: {
    workspace: WorkspaceRecord;
    executable: string;
    args: string[];
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
    timeoutMs?: number | undefined;
    stdinText?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<WorkspaceForegroundCommandExecutionResult>;
  runBackground(input: {
    workspace: WorkspaceRecord;
    command: string;
    sessionId: string;
    description?: string | undefined;
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
  }): Promise<WorkspaceBackgroundCommandExecutionResult>;
}

export interface SandboxHost {
  providerKind: SandboxHostProviderKind;
  workspaceCommandExecutor: WorkspaceCommandExecutor;
  workspaceFileSystem: WorkspaceFileSystem;
  workspaceExecutionProvider: WorkspaceExecutionProvider;
  workspaceFileAccessProvider: WorkspaceFileAccessProvider;
  diagnostics(): SandboxHostDiagnostics;
  maintain(options: { idleBefore: string }): Promise<void>;
  beginDrain(): Promise<void>;
  close(): Promise<void>;
}
