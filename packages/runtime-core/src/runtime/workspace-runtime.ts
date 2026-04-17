import path from "node:path";

import type { Workspace, WorkspaceCatalog } from "@oah/api-contracts";

import { AppError } from "../errors.js";
import { NATIVE_TOOL_NAMES } from "../native-tools.js";
import { runtimeToolNamesForCatalog as listRuntimeToolNamesForCatalog } from "../runtime-tooling.js";
import type {
  CreateWorkspaceParams,
  RuntimeServiceOptions,
  RuntimeWorkspaceCatalog,
  WorkspaceCommandExecutor,
  WorkspaceFileSystem,
  WorkspaceListResult,
  WorkspaceRecord
} from "../types.js";
import { createId, nowIso, parseCursor } from "../utils.js";
import { resolveWorkspacePath } from "../native-tools/paths.js";
import { buildArchiveMetadata } from "./internal-helpers.js";
import {
  type SortOrder,
  type WorkspaceDeleteResult,
  type WorkspaceEntry,
  type WorkspaceEntryPage,
  type WorkspaceEntrySortBy,
  type WorkspaceFileContentResult,
  type WorkspaceFileDownloadResult,
  type WorkspaceFileService
} from "../workspace-files.js";
import { normalizeWorkspaceRecord, toPublicWorkspace } from "../types.js";

export interface WorkspaceRuntimeServiceDependencies {
  workspaceRepository: RuntimeServiceOptions["workspaceRepository"];
  workspaceInitializer?: RuntimeServiceOptions["workspaceInitializer"] | undefined;
  workspaceArchiveRepository?: RuntimeServiceOptions["workspaceArchiveRepository"] | undefined;
  workspaceDeletionHandler?: RuntimeServiceOptions["workspaceDeletionHandler"] | undefined;
  workspaceFileAccessProvider?: RuntimeServiceOptions["workspaceFileAccessProvider"] | undefined;
  workspaceFiles: WorkspaceFileService;
  workspaceFileSystem: WorkspaceFileSystem;
  workspaceCommandExecutor: WorkspaceCommandExecutor;
}

export class WorkspaceRuntimeService {
  readonly #workspaceRepository: RuntimeServiceOptions["workspaceRepository"];
  readonly #workspaceInitializer: RuntimeServiceOptions["workspaceInitializer"];
  readonly #workspaceArchiveRepository: RuntimeServiceOptions["workspaceArchiveRepository"];
  readonly #workspaceDeletionHandler: RuntimeServiceOptions["workspaceDeletionHandler"];
  readonly #workspaceFileAccessProvider: RuntimeServiceOptions["workspaceFileAccessProvider"];
  readonly #workspaceFiles: WorkspaceFileService;
  readonly #workspaceFileSystem: WorkspaceFileSystem;
  readonly #workspaceCommandExecutor: WorkspaceCommandExecutor;

  constructor(dependencies: WorkspaceRuntimeServiceDependencies) {
    this.#workspaceRepository = dependencies.workspaceRepository;
    this.#workspaceInitializer = dependencies.workspaceInitializer;
    this.#workspaceArchiveRepository = dependencies.workspaceArchiveRepository;
    this.#workspaceDeletionHandler = dependencies.workspaceDeletionHandler;
    this.#workspaceFileAccessProvider = dependencies.workspaceFileAccessProvider;
    this.#workspaceFiles = dependencies.workspaceFiles;
    this.#workspaceFileSystem = dependencies.workspaceFileSystem;
    this.#workspaceCommandExecutor = dependencies.workspaceCommandExecutor;
  }

  async createWorkspace({ input }: CreateWorkspaceParams): Promise<Workspace> {
    if (!this.#workspaceInitializer) {
      throw new AppError(
        501,
        "workspace_initializer_not_configured",
        "Workspace creation requires a configured blueprint initializer."
      );
    }

    const initialized = await this.#workspaceInitializer.initialize(input);
    const now = nowIso();
    const requestedWorkspaceId = (
      input as CreateWorkspaceParams["input"] & {
        workspaceId?: string | undefined;
      }
    ).workspaceId?.trim();
    const initializedWorkspaceId = initialized.id?.trim();
    const workspaceId = requestedWorkspaceId || initializedWorkspaceId || createId("ws");

    if (requestedWorkspaceId || initializedWorkspaceId) {
      const existing = await this.#workspaceRepository.getById(workspaceId);
      if (existing) {
        return toPublicWorkspace(existing);
      }
    }

    const workspace: WorkspaceRecord = {
      id: workspaceId,
      kind: initialized.kind ?? "project",
      readOnly: initialized.readOnly ?? false,
      historyMirrorEnabled: (initialized.kind ?? "project") === "project",
      defaultAgent: initialized.defaultAgent,
      projectAgentsMd: initialized.projectAgentsMd,
      settings: initialized.settings,
      workspaceModels: initialized.workspaceModels,
      agents: initialized.agents,
      actions: initialized.actions,
      skills: initialized.skills,
      toolServers: initialized.toolServers,
      hooks: initialized.hooks,
      catalog: {
        ...initialized.catalog,
        workspaceId
      },
      externalRef: input.externalRef,
      ...(input.ownerId ? { ownerId: input.ownerId } : {}),
      ...(input.serviceName ? { serviceName: input.serviceName } : {}),
      name: input.name,
      rootPath: initialized.rootPath,
      executionPolicy: input.executionPolicy ?? "local",
      status: "active",
      createdAt: now,
      updatedAt: now
    };

    try {
      const created = await this.#workspaceRepository.create(workspace);
      return toPublicWorkspace(created);
    } catch (error) {
      if (!requestedWorkspaceId && !initializedWorkspaceId) {
        throw error;
      }

      const existing = await this.#workspaceRepository.getById(workspaceId);
      if (existing) {
        return toPublicWorkspace(existing);
      }

      throw error;
    }
  }

  async getWorkspace(workspaceId: string): Promise<Workspace> {
    return toPublicWorkspace(await this.getWorkspaceRecord(workspaceId));
  }

  async listWorkspaces(pageSize = 50, cursor?: string): Promise<WorkspaceListResult> {
    const startIndex = parseCursor(cursor);
    const workspaces = await this.#workspaceRepository.list(pageSize, cursor);
    const items = workspaces.map((workspace) => toPublicWorkspace(normalizeWorkspaceRecord(workspace)));
    const nextCursor = workspaces.length === pageSize ? String(startIndex + pageSize) : undefined;

    return nextCursor === undefined ? { items } : { items, nextCursor };
  }

  async getWorkspaceRecord(workspaceId: string): Promise<WorkspaceRecord> {
    const workspace = await this.#workspaceRepository.getById(workspaceId);
    if (!workspace) {
      throw new AppError(404, "workspace_not_found", `Workspace ${workspaceId} was not found.`);
    }

    return normalizeWorkspaceRecord(workspace);
  }

  async getWorkspaceCatalog(workspaceId: string): Promise<WorkspaceCatalog> {
    const workspace = await this.getWorkspaceRecord(workspaceId);
    return this.#publicWorkspaceCatalog(workspace);
  }

  async listWorkspaceEntries(
    workspaceId: string,
    input: {
      path?: string | undefined;
      pageSize: number;
      cursor?: string | undefined;
      sortBy: WorkspaceEntrySortBy;
      sortOrder: SortOrder;
    }
  ): Promise<WorkspaceEntryPage> {
    return this.#withWorkspaceFileLease(workspaceId, "read", input.path, (workspace) =>
      this.#workspaceFiles.listEntries(workspace, input)
    );
  }

  async getWorkspaceFileContent(
    workspaceId: string,
    input: { path: string; encoding: "utf8" | "base64"; maxBytes?: number | undefined }
  ): Promise<WorkspaceFileContentResult> {
    return this.#withWorkspaceFileLease(workspaceId, "read", input.path, (workspace) =>
      this.#workspaceFiles.getFileContent(workspace, input)
    );
  }

  async putWorkspaceFileContent(
    workspaceId: string,
    input: {
      path: string;
      content: string;
      encoding: "utf8" | "base64";
      overwrite?: boolean | undefined;
      ifMatch?: string | undefined;
    }
  ): Promise<WorkspaceEntry> {
    return this.#withWorkspaceFileLease(workspaceId, "write", input.path, (workspace) =>
      this.#workspaceFiles.putFileContent(workspace, input)
    );
  }

  async uploadWorkspaceFile(
    workspaceId: string,
    input: { path: string; data: Buffer; overwrite?: boolean | undefined; ifMatch?: string | undefined }
  ): Promise<WorkspaceEntry> {
    return this.#withWorkspaceFileLease(workspaceId, "write", input.path, (workspace) =>
      this.#workspaceFiles.uploadFile(workspace, input)
    );
  }

  async createWorkspaceDirectory(
    workspaceId: string,
    input: { path: string; createParents: boolean }
  ): Promise<WorkspaceEntry> {
    return this.#withWorkspaceFileLease(workspaceId, "write", input.path, (workspace) =>
      this.#workspaceFiles.createDirectory(workspace, input)
    );
  }

  async deleteWorkspaceEntry(
    workspaceId: string,
    input: { path: string; recursive: boolean }
  ): Promise<WorkspaceDeleteResult> {
    return this.#withWorkspaceFileLease(workspaceId, "write", input.path, (workspace) =>
      this.#workspaceFiles.deleteEntry(workspace, input)
    );
  }

  async moveWorkspaceEntry(
    workspaceId: string,
    input: { sourcePath: string; targetPath: string; overwrite: boolean }
  ): Promise<WorkspaceEntry> {
    return this.#withWorkspaceFileLease(workspaceId, "write", input.targetPath, (workspace) =>
      this.#workspaceFiles.moveEntry(workspace, input)
    );
  }

  async getWorkspaceFileDownload(workspaceId: string, targetPath: string): Promise<WorkspaceFileDownloadResult> {
    return this.#workspaceFiles.getFileDownload(await this.getWorkspaceRecord(workspaceId), targetPath);
  }

  async openWorkspaceFileDownload(
    workspaceId: string,
    targetPath: string
  ): Promise<{
    file: WorkspaceFileDownloadResult;
    release(options?: { dirty?: boolean | undefined }): Promise<void>;
  }> {
    const workspace = await this.getWorkspaceRecord(workspaceId);
    if (!this.#workspaceFileAccessProvider) {
      return {
        file: await this.#workspaceFiles.getFileDownload(workspace, targetPath),
        async release() {
          return undefined;
        }
      };
    }

    const lease = await this.#workspaceFileAccessProvider.acquire({
      workspace,
      access: "read",
      path: targetPath
    });

    let released = false;
    try {
      return {
        file: await this.#workspaceFiles.getFileDownload(lease.workspace, targetPath),
        async release(options?: { dirty?: boolean | undefined }) {
          if (released) {
            return;
          }

          released = true;
          await lease.release(options);
        }
      };
    } catch (error) {
      await lease.release({ dirty: false });
      throw error;
    }
  }

  async runWorkspaceCommandForeground(
    workspaceId: string,
    input: {
      command: string;
      cwd?: string | undefined;
      env?: Record<string, string> | undefined;
      timeoutMs?: number | undefined;
      stdinText?: string | undefined;
      access?: "read" | "write" | undefined;
    }
  ) {
    return this.#withWorkspaceCommandLease(workspaceId, input.cwd, input.access ?? "write", async (workspace, cwd) =>
      this.#workspaceCommandExecutor.runForeground({
        workspace,
        command: input.command,
        ...(cwd ? { cwd } : {}),
        ...(input.env ? { env: input.env } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.stdinText !== undefined ? { stdinText: input.stdinText } : {})
      })
    );
  }

  async runWorkspaceCommandProcess(
    workspaceId: string,
    input: {
      executable: string;
      args: string[];
      cwd?: string | undefined;
      env?: Record<string, string> | undefined;
      timeoutMs?: number | undefined;
      stdinText?: string | undefined;
      access?: "read" | "write" | undefined;
    }
  ) {
    return this.#withWorkspaceCommandLease(workspaceId, input.cwd, input.access ?? "write", async (workspace, cwd) =>
      this.#workspaceCommandExecutor.runProcess({
        workspace,
        executable: input.executable,
        args: input.args,
        ...(cwd ? { cwd } : {}),
        ...(input.env ? { env: input.env } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.stdinText !== undefined ? { stdinText: input.stdinText } : {})
      })
    );
  }

  async runWorkspaceCommandBackground(
    workspaceId: string,
    input: {
      command: string;
      sessionId: string;
      description?: string | undefined;
      cwd?: string | undefined;
      env?: Record<string, string> | undefined;
      access?: "read" | "write" | undefined;
    }
  ) {
    return this.#withWorkspaceCommandLease(workspaceId, input.cwd, input.access ?? "write", async (workspace, cwd) =>
      this.#workspaceCommandExecutor.runBackground({
        workspace,
        command: input.command,
        sessionId: input.sessionId,
        ...(input.description ? { description: input.description } : {}),
        ...(cwd ? { cwd } : {}),
        ...(input.env ? { env: input.env } : {})
      })
    );
  }

  async getWorkspaceFileStat(workspaceId: string, targetPath: string) {
    return this.#withWorkspaceFileLease(workspaceId, "read", targetPath, async (workspace) => {
      const resolved = await resolveWorkspacePath(this.#workspaceFileSystem, workspace.rootPath, targetPath);
      const stats = await this.#workspaceFileSystem.stat(resolved.absolutePath);
      return {
        ...stats,
        path: targetPath
      };
    });
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    const workspace = await this.getWorkspaceRecord(workspaceId);
    if (this.#workspaceArchiveRepository) {
      await this.#workspaceArchiveRepository.archiveWorkspace({
        workspace,
        ...buildArchiveMetadata()
      });
    }
    await this.#workspaceDeletionHandler?.deleteWorkspace(workspace);
    await this.#workspaceRepository.delete(workspaceId);
  }

  async #withWorkspaceFileLease<T>(
    workspaceId: string,
    access: "read" | "write",
    targetPath: string | undefined,
    operation: (workspace: WorkspaceRecord) => Promise<T>
  ): Promise<T> {
    const workspace = await this.getWorkspaceRecord(workspaceId);
    if (!this.#workspaceFileAccessProvider) {
      return operation(workspace);
    }

    const lease = await this.#workspaceFileAccessProvider.acquire({
      workspace,
      access,
      ...(targetPath ? { path: targetPath } : {})
    });

    try {
      return await operation(lease.workspace);
    } finally {
      await lease.release({
        dirty: access === "write" && !lease.workspace.readOnly && lease.workspace.kind === "project"
      });
    }
  }

  async #withWorkspaceCommandLease<T>(
    workspaceId: string,
    commandPath: string | undefined,
    access: "read" | "write",
    operation: (workspace: WorkspaceRecord, cwd: string | undefined) => Promise<T>
  ): Promise<T> {
    return this.#withWorkspaceFileLease(workspaceId, access, commandPath, async (workspace) => {
      const cwd =
        commandPath !== undefined
          ? (await resolveWorkspacePath(this.#workspaceFileSystem, workspace.rootPath, commandPath)).absolutePath
          : undefined;
      return operation(workspace, cwd ?? path.resolve(workspace.rootPath));
    });
  }

  #publicWorkspaceCatalog(workspace: WorkspaceRecord): RuntimeWorkspaceCatalog {
    const tools = workspace.catalog.tools ?? [];
    return {
      ...workspace.catalog,
      tools,
      nativeTools: [...NATIVE_TOOL_NAMES],
      runtimeTools: listRuntimeToolNamesForCatalog(workspace)
    };
  }
}
