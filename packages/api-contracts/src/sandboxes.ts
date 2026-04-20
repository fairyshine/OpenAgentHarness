import { z } from "zod";
import { timestampSchema } from "./common.js";
import { buildSandboxApiPath, buildSandboxCollectionApiPath } from "./sandbox-paths.js";
import {
  workspaceDeleteResultSchema,
  workspaceEntryPageSchema,
  workspaceEntrySchema,
  workspaceFileContentSchema,
  type CreateWorkspaceDirectoryRequest,
  type MoveWorkspaceEntryRequest,
  type PutWorkspaceFileRequest,
  type WorkspaceDeleteEntryQuery,
  type WorkspaceDeleteResult,
  type WorkspaceEntriesQuery,
  type WorkspaceEntry,
  type WorkspaceEntryPage,
  type WorkspaceEntryPathQuery,
  type WorkspaceFileContent,
  type WorkspaceFileContentQuery,
  type WorkspaceFileUploadQuery
} from "./workspaces.js";

export interface SandboxHttpTransport {
  requestJson<T>(path: string, init?: RequestInit): Promise<T>;
  requestBytes(path: string, init?: RequestInit): Promise<Uint8Array>;
}

export type SandboxHttpBody = NonNullable<RequestInit["body"]>;

function buildSandboxQueryString(input: Record<string, string | number | boolean | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) {
      continue;
    }

    query.set(key, String(value));
  }

  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

function jsonRequestInit(method: "POST" | "PUT" | "PATCH", body: unknown): RequestInit {
  return {
    method,
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  };
}

export const sandboxProviderKindSchema = z.enum(["embedded", "self_hosted", "e2b"]);
export const sandboxExecutionModelSchema = z.enum(["local_embedded", "sandbox_hosted"]);
export const sandboxWorkerPlacementSchema = z.enum(["api_process", "inside_sandbox"]);
export const sandboxTopologySchema = z.object({
  provider: sandboxProviderKindSchema,
  executionModel: sandboxExecutionModelSchema,
  workerPlacement: sandboxWorkerPlacementSchema
});

export const sandboxSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  provider: sandboxProviderKindSchema,
  executionModel: sandboxExecutionModelSchema,
  workerPlacement: sandboxWorkerPlacementSchema,
  rootPath: z.string(),
  name: z.string(),
  kind: z.literal("project"),
  executionPolicy: z.enum(["local", "container", "remote_runner"]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  ownerWorkerId: z.string().optional(),
  ownerBaseUrl: z.string().optional()
});

export const createSandboxRequestSchema = z
  .object({
    workspaceId: z.string().trim().min(1).optional(),
    externalRef: z.string().optional(),
    name: z.string().min(1).optional(),
    runtime: z.string().min(1).optional(),
    rootPath: z.string().min(1).optional(),
    ownerId: z.string().trim().min(1).optional(),
    serviceName: z
      .string()
      .trim()
      .min(1)
      .max(63)
      .regex(/^[a-z0-9](?:[a-z0-9-_]*[a-z0-9])?$/i, "serviceName may only contain letters, numbers, hyphen, and underscore.")
      .transform((value) => value.toLowerCase())
      .optional(),
    executionPolicy: z.enum(["local", "container", "remote_runner"]).default("local")
  })
  .superRefine((value, context) => {
    if (value.workspaceId || value.rootPath || (value.name && value.runtime)) {
      return;
    }

    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide workspaceId, rootPath, or both name and runtime."
    });
  });

export const sandboxCommandRequestSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  stdinText: z.string().optional()
});

export const sandboxProcessRequestSchema = z.object({
  executable: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  stdinText: z.string().optional()
});

export const sandboxBackgroundCommandRequestSchema = z.object({
  command: z.string().min(1),
  sessionId: z.string().trim().min(1).optional(),
  description: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional()
});

export const sandboxCommandResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int()
});

export const sandboxBackgroundCommandResultSchema = z.object({
  outputPath: z.string(),
  taskId: z.string(),
  pid: z.number().int().nonnegative()
});

export const sandboxFileStatSchema = z.object({
  kind: z.enum(["file", "directory"]),
  size: z.number().int().min(0),
  mtimeMs: z.number().min(0),
  birthtimeMs: z.number().min(0),
  path: z.string()
});

export const sandboxFileStatQuerySchema = z.object({
  path: z.string().min(1)
});

export type SandboxProviderKind = z.infer<typeof sandboxProviderKindSchema>;
export type SandboxExecutionModel = z.infer<typeof sandboxExecutionModelSchema>;
export type SandboxWorkerPlacement = z.infer<typeof sandboxWorkerPlacementSchema>;
export type SandboxTopology = z.infer<typeof sandboxTopologySchema>;
export type Sandbox = z.infer<typeof sandboxSchema>;
export type CreateSandboxRequest = z.infer<typeof createSandboxRequestSchema>;
export type SandboxCommandRequest = z.infer<typeof sandboxCommandRequestSchema>;
export type SandboxProcessRequest = z.infer<typeof sandboxProcessRequestSchema>;
export type SandboxBackgroundCommandRequest = z.infer<typeof sandboxBackgroundCommandRequestSchema>;
export type SandboxCommandResult = z.infer<typeof sandboxCommandResultSchema>;
export type SandboxBackgroundCommandResult = z.infer<typeof sandboxBackgroundCommandResultSchema>;
export type SandboxFileStat = z.infer<typeof sandboxFileStatSchema>;
export type SandboxFileStatQuery = z.infer<typeof sandboxFileStatQuerySchema>;

export function createSandboxHttpClient(transport: SandboxHttpTransport) {
  return {
    async createSandbox(input: CreateSandboxRequest): Promise<Sandbox> {
      return sandboxSchema.parse(
        await transport.requestJson<unknown>(buildSandboxCollectionApiPath(), jsonRequestInit("POST", input))
      );
    },
    async getSandbox(sandboxId: string): Promise<Sandbox> {
      return sandboxSchema.parse(await transport.requestJson<unknown>(buildSandboxApiPath(sandboxId)));
    },
    async listEntries(sandboxId: string, input: WorkspaceEntriesQuery): Promise<WorkspaceEntryPage> {
      return workspaceEntryPageSchema.parse(
        await transport.requestJson<unknown>(
          `${buildSandboxApiPath(sandboxId, "/files/entries")}${buildSandboxQueryString({
            ...(input.path ? { path: input.path } : {}),
            ...(input.pageSize !== undefined ? { pageSize: input.pageSize } : {}),
            ...(input.cursor ? { cursor: input.cursor } : {}),
            ...(input.sortBy ? { sortBy: input.sortBy } : {}),
            ...(input.sortOrder ? { sortOrder: input.sortOrder } : {})
          })}`
        )
      );
    },
    async getFileStat(sandboxId: string, input: SandboxFileStatQuery): Promise<SandboxFileStat> {
      return sandboxFileStatSchema.parse(
        await transport.requestJson<unknown>(
          `${buildSandboxApiPath(sandboxId, "/files/stat")}${buildSandboxQueryString({ path: input.path })}`
        )
      );
    },
    async getFileContent(sandboxId: string, input: WorkspaceFileContentQuery): Promise<WorkspaceFileContent> {
      return workspaceFileContentSchema.parse(
        await transport.requestJson<unknown>(
          `${buildSandboxApiPath(sandboxId, "/files/content")}${buildSandboxQueryString({
            path: input.path,
            ...(input.encoding ? { encoding: input.encoding } : {}),
            ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {})
          })}`
        )
      );
    },
    async putFileContent(sandboxId: string, input: PutWorkspaceFileRequest): Promise<WorkspaceEntry> {
      return workspaceEntrySchema.parse(
        await transport.requestJson<unknown>(buildSandboxApiPath(sandboxId, "/files/content"), jsonRequestInit("PUT", input))
      );
    },
    async createDirectory(sandboxId: string, input: CreateWorkspaceDirectoryRequest): Promise<WorkspaceEntry> {
      return workspaceEntrySchema.parse(
        await transport.requestJson<unknown>(buildSandboxApiPath(sandboxId, "/directories"), jsonRequestInit("POST", input))
      );
    },
    async uploadFile(
      sandboxId: string,
      input: WorkspaceFileUploadQuery & { data: SandboxHttpBody; contentType?: string | undefined }
    ): Promise<WorkspaceEntry> {
      return workspaceEntrySchema.parse(
        await transport.requestJson<unknown>(
          `${buildSandboxApiPath(sandboxId, "/files/upload")}${buildSandboxQueryString({
            path: input.path,
            ...(input.overwrite !== undefined ? { overwrite: input.overwrite } : {})
          })}`,
          {
            method: "PUT",
            headers: {
              "content-type": input.contentType ?? "application/octet-stream"
            },
            body: input.data
          }
        )
      );
    },
    async downloadFile(sandboxId: string, input: WorkspaceEntryPathQuery): Promise<Uint8Array> {
      return transport.requestBytes(
        `${buildSandboxApiPath(sandboxId, "/files/download")}${buildSandboxQueryString({ path: input.path })}`
      );
    },
    async deleteEntry(sandboxId: string, input: WorkspaceDeleteEntryQuery): Promise<WorkspaceDeleteResult> {
      return workspaceDeleteResultSchema.parse(
        await transport.requestJson<unknown>(
          `${buildSandboxApiPath(sandboxId, "/files/entry")}${buildSandboxQueryString({
            path: input.path,
            ...(input.recursive !== undefined ? { recursive: input.recursive } : {})
          })}`,
          {
            method: "DELETE"
          }
        )
      );
    },
    async moveEntry(sandboxId: string, input: MoveWorkspaceEntryRequest): Promise<WorkspaceEntry> {
      return workspaceEntrySchema.parse(
        await transport.requestJson<unknown>(buildSandboxApiPath(sandboxId, "/files/move"), jsonRequestInit("PATCH", input))
      );
    },
    async runForegroundCommand(sandboxId: string, input: SandboxCommandRequest): Promise<SandboxCommandResult> {
      return sandboxCommandResultSchema.parse(
        await transport.requestJson<unknown>(
          buildSandboxApiPath(sandboxId, "/commands/foreground"),
          jsonRequestInit("POST", input)
        )
      );
    },
    async runProcessCommand(sandboxId: string, input: SandboxProcessRequest): Promise<SandboxCommandResult> {
      return sandboxCommandResultSchema.parse(
        await transport.requestJson<unknown>(buildSandboxApiPath(sandboxId, "/commands/process"), jsonRequestInit("POST", input))
      );
    },
    async runBackgroundCommand(
      sandboxId: string,
      input: SandboxBackgroundCommandRequest
    ): Promise<SandboxBackgroundCommandResult> {
      return sandboxBackgroundCommandResultSchema.parse(
        await transport.requestJson<unknown>(
          buildSandboxApiPath(sandboxId, "/commands/background"),
          jsonRequestInit("POST", input)
        )
      );
    }
  };
}
