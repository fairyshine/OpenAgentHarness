import type { FastifyRequest } from "fastify";

import type { CallerContext, ModelGateway, RuntimeService, WorkspaceRecord } from "@oah/runtime-core";
import type { HistoryMirrorStatus } from "../history-mirror.js";
import type { StorageAdmin } from "../storage-admin.js";

declare module "fastify" {
  interface FastifyRequest {
    callerContext?: CallerContext;
  }
}

export interface AppDependencies {
  runtimeService: {
    createWorkspace: RuntimeService["createWorkspace"];
    listWorkspaces: RuntimeService["listWorkspaces"];
    getWorkspace: RuntimeService["getWorkspace"];
    getWorkspaceRecord: RuntimeService["getWorkspaceRecord"];
    getWorkspaceCatalog: RuntimeService["getWorkspaceCatalog"];
    listWorkspaceEntries: (
      workspaceId: string,
      input: {
        path?: string | undefined;
        pageSize: number;
        cursor?: string | undefined;
        sortBy: "name" | "updatedAt" | "sizeBytes" | "type";
        sortOrder: "asc" | "desc";
      }
    ) => Promise<unknown>;
    getWorkspaceFileContent: (
      workspaceId: string,
      input: { path: string; encoding: "utf8" | "base64"; maxBytes?: number | undefined }
    ) => Promise<unknown>;
    putWorkspaceFileContent: (
      workspaceId: string,
      input: {
        path: string;
        content: string;
        encoding: "utf8" | "base64";
        overwrite?: boolean | undefined;
        ifMatch?: string | undefined;
      }
    ) => Promise<unknown>;
    uploadWorkspaceFile: (
      workspaceId: string,
      input: {
        path: string;
        data: Buffer;
        overwrite?: boolean | undefined;
        ifMatch?: string | undefined;
      }
    ) => Promise<unknown>;
    getWorkspaceFileDownload: (
      workspaceId: string,
      targetPath: string
    ) => Promise<{ absolutePath: string; name: string; sizeBytes: number; mimeType?: string | undefined; etag: string; updatedAt: string }>;
    createWorkspaceDirectory: (
      workspaceId: string,
      input: { path: string; createParents: boolean }
    ) => Promise<unknown>;
    deleteWorkspaceEntry: (workspaceId: string, input: { path: string; recursive: boolean }) => Promise<unknown>;
    moveWorkspaceEntry: (
      workspaceId: string,
      input: { sourcePath: string; targetPath: string; overwrite: boolean }
    ) => Promise<unknown>;
    deleteWorkspace: RuntimeService["deleteWorkspace"];
    createSession: RuntimeService["createSession"];
    listWorkspaceSessions: RuntimeService["listWorkspaceSessions"];
    triggerActionRun: RuntimeService["triggerActionRun"];
    getSession: RuntimeService["getSession"];
    updateSession: RuntimeService["updateSession"];
    deleteSession: RuntimeService["deleteSession"];
    listSessionMessages: RuntimeService["listSessionMessages"];
    listSessionRuns: RuntimeService["listSessionRuns"];
    createSessionMessage: RuntimeService["createSessionMessage"];
    listSessionEvents: RuntimeService["listSessionEvents"];
    subscribeSessionEvents: RuntimeService["subscribeSessionEvents"];
    getRun: RuntimeService["getRun"];
    listRunSteps: RuntimeService["listRunSteps"];
    cancelRun: RuntimeService["cancelRun"];
  };
  modelGateway: ModelGateway;
  defaultModel: string;
  logger?: boolean;
  workspaceMode?: "multi" | "single";
  resolveCallerContext?: ((request: FastifyRequest) => Promise<CallerContext | undefined> | CallerContext | undefined) | undefined;
  listWorkspaceTemplates?: (() => Promise<import("@oah/config").WorkspaceTemplateDescriptor[]>) | undefined;
  listPlatformModels?: (() => Promise<
    Array<{
      id: string;
      provider: string;
      modelName: string;
      url?: string;
      hasKey: boolean;
      metadata?: Record<string, unknown>;
      isDefault: boolean;
    }>
  >) | undefined;
  importWorkspace?: (input: {
    rootPath: string;
    kind?: "project" | "chat";
    name?: string;
    externalRef?: string;
  }) => Promise<import("@oah/api-contracts").Workspace>;
  healthCheck?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  readinessCheck?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  getWorkspaceHistoryMirrorStatus?: (workspace: WorkspaceRecord) => Promise<HistoryMirrorStatus>;
  rebuildWorkspaceHistoryMirror?: (workspace: WorkspaceRecord) => Promise<HistoryMirrorStatus>;
  storageAdmin?: StorageAdmin;
}

export interface AppRouteOptions {
  workspaceMode: "multi" | "single";
}
