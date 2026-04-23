import type { EngineService } from "./engine-service.js";
import type { EngineLogger, WorkspaceActivityTracker, WorkspacePrewarmer } from "./types.js";

type ControlPlaneRuntimeKernel = Pick<
  EngineService,
  | "createWorkspace"
  | "listWorkspaces"
  | "getWorkspace"
  | "getWorkspaceRecord"
  | "getWorkspaceCatalog"
  | "listWorkspaceEntries"
  | "getWorkspaceFileContent"
  | "putWorkspaceFileContent"
  | "uploadWorkspaceFile"
  | "getWorkspaceFileDownload"
  | "openWorkspaceFileDownload"
  | "getWorkspaceFileStat"
  | "runWorkspaceCommandForeground"
  | "runWorkspaceCommandProcess"
  | "runWorkspaceCommandBackground"
  | "createWorkspaceDirectory"
  | "deleteWorkspaceEntry"
  | "moveWorkspaceEntry"
  | "deleteWorkspace"
  | "createSession"
  | "listWorkspaceSessions"
  | "triggerActionRun"
  | "getSession"
  | "updateSession"
  | "deleteSession"
  | "listSessionMessages"
  | "listSessionRuns"
  | "listSessionQueuedRuns"
  | "compactSession"
  | "createSessionMessage"
  | "listSessionEvents"
  | "subscribeSessionEvents"
  | "getRun"
  | "listRunSteps"
  | "cancelRun"
  | "guideQueuedRun"
  | "requeueRun"
>;

export interface ControlPlaneRuntimeOperations extends ControlPlaneRuntimeKernel {}

export class ControlPlaneEngineService implements ControlPlaneRuntimeOperations {
  readonly #workspaceActivityTracker?: WorkspaceActivityTracker | undefined;
  readonly #workspacePrewarmer?: WorkspacePrewarmer | undefined;
  readonly #logger?: EngineLogger | undefined;
  readonly #getSessionRecord: EngineService["getSession"];
  readonly #getRunRecord: EngineService["getRun"];

  readonly createWorkspace: EngineService["createWorkspace"];
  readonly listWorkspaces: EngineService["listWorkspaces"];
  readonly getWorkspace: EngineService["getWorkspace"];
  readonly getWorkspaceRecord: EngineService["getWorkspaceRecord"];
  readonly getWorkspaceCatalog: EngineService["getWorkspaceCatalog"];
  readonly listWorkspaceEntries: EngineService["listWorkspaceEntries"];
  readonly getWorkspaceFileContent: EngineService["getWorkspaceFileContent"];
  readonly putWorkspaceFileContent: EngineService["putWorkspaceFileContent"];
  readonly uploadWorkspaceFile: EngineService["uploadWorkspaceFile"];
  readonly getWorkspaceFileDownload: EngineService["getWorkspaceFileDownload"];
  readonly openWorkspaceFileDownload: EngineService["openWorkspaceFileDownload"];
  readonly getWorkspaceFileStat: EngineService["getWorkspaceFileStat"];
  readonly runWorkspaceCommandForeground: EngineService["runWorkspaceCommandForeground"];
  readonly runWorkspaceCommandProcess: EngineService["runWorkspaceCommandProcess"];
  readonly runWorkspaceCommandBackground: EngineService["runWorkspaceCommandBackground"];
  readonly createWorkspaceDirectory: EngineService["createWorkspaceDirectory"];
  readonly deleteWorkspaceEntry: EngineService["deleteWorkspaceEntry"];
  readonly moveWorkspaceEntry: EngineService["moveWorkspaceEntry"];
  readonly deleteWorkspace: EngineService["deleteWorkspace"];
  readonly createSession: EngineService["createSession"];
  readonly listWorkspaceSessions: EngineService["listWorkspaceSessions"];
  readonly triggerActionRun: EngineService["triggerActionRun"];
  readonly getSession: EngineService["getSession"];
  readonly updateSession: EngineService["updateSession"];
  readonly deleteSession: EngineService["deleteSession"];
  readonly listSessionMessages: EngineService["listSessionMessages"];
  readonly listSessionRuns: EngineService["listSessionRuns"];
  readonly listSessionQueuedRuns: EngineService["listSessionQueuedRuns"];
  readonly compactSession: EngineService["compactSession"];
  readonly createSessionMessage: EngineService["createSessionMessage"];
  readonly listSessionEvents: EngineService["listSessionEvents"];
  readonly subscribeSessionEvents: EngineService["subscribeSessionEvents"];
  readonly getRun: EngineService["getRun"];
  readonly listRunSteps: EngineService["listRunSteps"];
  readonly cancelRun: EngineService["cancelRun"];
  readonly guideQueuedRun: EngineService["guideQueuedRun"];
  readonly requeueRun: EngineService["requeueRun"];

  constructor(
    kernel: ControlPlaneRuntimeKernel,
    options?: {
      workspaceActivityTracker?: WorkspaceActivityTracker | undefined;
      workspacePrewarmer?: WorkspacePrewarmer | undefined;
      logger?: EngineLogger | undefined;
    }
  ) {
    this.#workspaceActivityTracker = options?.workspaceActivityTracker;
    this.#workspacePrewarmer = options?.workspacePrewarmer;
    this.#logger = options?.logger;
    this.#getSessionRecord = kernel.getSession.bind(kernel);
    this.#getRunRecord = kernel.getRun.bind(kernel);
    this.createWorkspace = kernel.createWorkspace.bind(kernel);
    this.listWorkspaces = kernel.listWorkspaces.bind(kernel);
    this.getWorkspace = async (workspaceId) => {
      const workspace = await kernel.getWorkspace(workspaceId);
      await this.#touchWorkspace(workspaceId);
      return workspace;
    };
    this.getWorkspaceRecord = async (workspaceId) => {
      const workspace = await kernel.getWorkspaceRecord(workspaceId);
      await this.#touchWorkspace(workspaceId);
      return workspace;
    };
    this.getWorkspaceCatalog = async (workspaceId) => {
      const catalog = await kernel.getWorkspaceCatalog(workspaceId);
      await this.#touchWorkspace(workspaceId);
      return catalog;
    };
    this.listWorkspaceEntries = async (workspaceId, input) => {
      const page = await kernel.listWorkspaceEntries(workspaceId, input);
      await this.#touchWorkspace(workspaceId);
      return page;
    };
    this.getWorkspaceFileContent = async (workspaceId, input) => {
      const file = await kernel.getWorkspaceFileContent(workspaceId, input);
      await this.#touchWorkspace(workspaceId);
      return file;
    };
    this.putWorkspaceFileContent = async (workspaceId, input) => {
      const entry = await kernel.putWorkspaceFileContent(workspaceId, input);
      await this.#touchWorkspace(workspaceId);
      return entry;
    };
    this.uploadWorkspaceFile = async (workspaceId, input) => {
      const entry = await kernel.uploadWorkspaceFile(workspaceId, input);
      await this.#touchWorkspace(workspaceId);
      return entry;
    };
    this.getWorkspaceFileDownload = async (workspaceId, targetPath) => {
      const file = await kernel.getWorkspaceFileDownload(workspaceId, targetPath);
      await this.#touchWorkspace(workspaceId);
      return file;
    };
    this.openWorkspaceFileDownload = async (workspaceId, targetPath) => {
      const handle = await kernel.openWorkspaceFileDownload(workspaceId, targetPath);
      await this.#touchWorkspace(workspaceId);
      return handle;
    };
    this.getWorkspaceFileStat = async (workspaceId, targetPath) => {
      const stats = await kernel.getWorkspaceFileStat(workspaceId, targetPath);
      await this.#touchWorkspace(workspaceId);
      return stats;
    };
    this.runWorkspaceCommandForeground = async (workspaceId, input) => {
      const result = await kernel.runWorkspaceCommandForeground(workspaceId, input);
      await this.#touchWorkspace(workspaceId);
      return result;
    };
    this.runWorkspaceCommandProcess = async (workspaceId, input) => {
      const result = await kernel.runWorkspaceCommandProcess(workspaceId, input);
      await this.#touchWorkspace(workspaceId);
      return result;
    };
    this.runWorkspaceCommandBackground = async (workspaceId, input) => {
      const result = await kernel.runWorkspaceCommandBackground(workspaceId, input);
      await this.#touchWorkspace(workspaceId);
      return result;
    };
    this.createWorkspaceDirectory = async (workspaceId, input) => {
      const entry = await kernel.createWorkspaceDirectory(workspaceId, input);
      await this.#touchWorkspace(workspaceId);
      return entry;
    };
    this.deleteWorkspaceEntry = async (workspaceId, input) => {
      const result = await kernel.deleteWorkspaceEntry(workspaceId, input);
      await this.#touchWorkspace(workspaceId);
      return result;
    };
    this.moveWorkspaceEntry = async (workspaceId, input) => {
      const entry = await kernel.moveWorkspaceEntry(workspaceId, input);
      await this.#touchWorkspace(workspaceId);
      return entry;
    };
    this.deleteWorkspace = async (workspaceId) => {
      await kernel.deleteWorkspace(workspaceId);
      await this.#touchWorkspace(workspaceId);
    };
    this.createSession = async (input) => {
      const session = await kernel.createSession(input);
      await this.#touchWorkspace(input.workspaceId);
      this.#scheduleWorkspacePrewarm(input.workspaceId);
      return session;
    };
    this.listWorkspaceSessions = async (workspaceId, pageSize, cursor) => {
      const sessions = await kernel.listWorkspaceSessions(workspaceId, pageSize, cursor);
      await this.#touchWorkspace(workspaceId);
      return sessions;
    };
    this.triggerActionRun = async (input) => {
      const result = await kernel.triggerActionRun(input);
      await this.#touchWorkspace(input.workspaceId);
      return result;
    };
    this.getSession = async (sessionId) => {
      const session = await this.#getSessionRecord(sessionId);
      await this.#touchWorkspace(session.workspaceId);
      return session;
    };
    this.updateSession = async (input) => {
      const session = await kernel.updateSession(input);
      await this.#touchWorkspace(session.workspaceId);
      return session;
    };
    this.deleteSession = async (sessionId) => {
      const session = await this.#getSessionRecord(sessionId);
      await kernel.deleteSession(sessionId);
      await this.#touchWorkspace(session.workspaceId);
    };
    this.listSessionMessages = async (sessionId, pageSize, cursor, direction) => {
      const messages = await kernel.listSessionMessages(sessionId, pageSize, cursor, direction);
      await this.#touchSessionWorkspace(sessionId);
      return messages;
    };
    this.listSessionRuns = async (sessionId, pageSize, cursor) => {
      const runs = await kernel.listSessionRuns(sessionId, pageSize, cursor);
      await this.#touchSessionWorkspace(sessionId);
      return runs;
    };
    this.listSessionQueuedRuns = async (sessionId) => {
      const queue = await kernel.listSessionQueuedRuns(sessionId);
      await this.#touchSessionWorkspace(sessionId);
      return queue;
    };
    this.compactSession = async (input) => {
      const result = await kernel.compactSession(input);
      await this.#touchSessionWorkspace(input.sessionId);
      return result;
    };
    this.createSessionMessage = async (input) => {
      const message = await kernel.createSessionMessage(input);
      await this.#touchSessionWorkspace(input.sessionId);
      return message;
    };
    this.listSessionEvents = async (sessionId, cursor, runId) => {
      const events = await kernel.listSessionEvents(sessionId, cursor, runId);
      await this.#touchSessionWorkspace(sessionId);
      return events;
    };
    this.subscribeSessionEvents = (sessionId, listener) => {
      const unsubscribe = kernel.subscribeSessionEvents(sessionId, listener);
      void this.#touchSessionWorkspace(sessionId);
      return unsubscribe;
    };
    this.getRun = async (runId) => {
      const run = await this.#getRunRecord(runId);
      await this.#touchWorkspace(run.workspaceId);
      return run;
    };
    this.listRunSteps = async (runId, pageSize, cursor) => {
      const steps = await kernel.listRunSteps(runId, pageSize, cursor);
      await this.#touchRunWorkspace(runId);
      return steps;
    };
    this.cancelRun = async (runId) => {
      const result = await kernel.cancelRun(runId);
      await this.#touchRunWorkspace(runId);
      return result;
    };
    this.guideQueuedRun = async (runId) => {
      const result = await kernel.guideQueuedRun(runId);
      await this.#touchRunWorkspace(runId);
      return result;
    };
    this.requeueRun = async (runId, requestedBy) => {
      const result = await kernel.requeueRun(runId, requestedBy);
      await this.#touchRunWorkspace(runId);
      return result;
    };
  }

  async #touchWorkspace(workspaceId: string): Promise<void> {
    await this.#workspaceActivityTracker?.touchWorkspace(workspaceId);
  }

  #scheduleWorkspacePrewarm(workspaceId: string): void {
    if (!this.#workspacePrewarmer) {
      return;
    }

    void Promise.resolve()
      .then(() => this.#workspacePrewarmer?.prewarmWorkspace(workspaceId))
      .catch((error: unknown) => {
        this.#logger?.warn?.("Workspace prewarm failed after session creation.", {
          workspaceId,
          errorMessage: error instanceof Error ? error.message : String(error)
        });
      });
  }

  async #touchSessionWorkspace(sessionId: string): Promise<void> {
    const session = await this.#getSessionRecord(sessionId);
    await this.#touchWorkspace(session.workspaceId);
  }

  async #touchRunWorkspace(runId: string): Promise<void> {
    const run = await this.#getRunRecord(runId);
    await this.#touchWorkspace(run.workspaceId);
  }
}
