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
  | "getSessionTerminalSnapshot"
  | "writeSessionTerminalInput"
  | "createWorkspaceDirectory"
  | "deleteWorkspaceEntry"
  | "moveWorkspaceEntry"
  | "deleteWorkspace"
  | "createSession"
  | "listWorkspaceSessions"
  | "listChildSessions"
  | "triggerActionRun"
  | "getSession"
  | "updateSession"
  | "deleteSession"
  | "listSessionMessages"
  | "getSessionMessage"
  | "getSessionMessageContext"
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

interface WorkspaceDefinitionRefresher {
  refreshWorkspaceDefinition(workspaceId: string): Promise<void> | void;
}

export class ControlPlaneEngineService implements ControlPlaneRuntimeOperations {
  readonly #workspaceActivityTracker?: WorkspaceActivityTracker | undefined;
  readonly #workspacePrewarmer?: WorkspacePrewarmer | undefined;
  readonly #workspaceDefinitionRefresher?: WorkspaceDefinitionRefresher | undefined;
  readonly #logger?: EngineLogger | undefined;
  readonly #getSessionRecord: EngineService["getSession"];
  readonly #getRunRecord: EngineService["getRun"];
  readonly #workspaceDefinitionRefreshes = new Map<string, Promise<void>>();

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
  readonly getSessionTerminalSnapshot: EngineService["getSessionTerminalSnapshot"];
  readonly writeSessionTerminalInput: EngineService["writeSessionTerminalInput"];
  readonly createWorkspaceDirectory: EngineService["createWorkspaceDirectory"];
  readonly deleteWorkspaceEntry: EngineService["deleteWorkspaceEntry"];
  readonly moveWorkspaceEntry: EngineService["moveWorkspaceEntry"];
  readonly deleteWorkspace: EngineService["deleteWorkspace"];
  readonly createSession: EngineService["createSession"];
  readonly listWorkspaceSessions: EngineService["listWorkspaceSessions"];
  readonly listChildSessions: EngineService["listChildSessions"];
  readonly triggerActionRun: EngineService["triggerActionRun"];
  readonly getSession: EngineService["getSession"];
  readonly updateSession: EngineService["updateSession"];
  readonly deleteSession: EngineService["deleteSession"];
  readonly listSessionMessages: EngineService["listSessionMessages"];
  readonly getSessionMessage: EngineService["getSessionMessage"];
  readonly getSessionMessageContext: EngineService["getSessionMessageContext"];
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
      workspaceDefinitionRefresher?: WorkspaceDefinitionRefresher | undefined;
      logger?: EngineLogger | undefined;
    }
  ) {
    this.#workspaceActivityTracker = options?.workspaceActivityTracker;
    this.#workspacePrewarmer = options?.workspacePrewarmer;
    this.#workspaceDefinitionRefresher = options?.workspaceDefinitionRefresher;
    this.#logger = options?.logger;
    this.#getSessionRecord = kernel.getSession.bind(kernel);
    this.#getRunRecord = kernel.getRun.bind(kernel);
    this.createWorkspace = kernel.createWorkspace.bind(kernel);
    this.listWorkspaces = kernel.listWorkspaces.bind(kernel);
    this.getWorkspace = async (workspaceId) => {
      await this.#waitForWorkspaceDefinitionRefresh(workspaceId);
      const workspace = await kernel.getWorkspace(workspaceId);
      await this.#touchWorkspace(workspaceId);
      return workspace;
    };
    this.getWorkspaceRecord = async (workspaceId) => {
      await this.#waitForWorkspaceDefinitionRefresh(workspaceId);
      const workspace = await kernel.getWorkspaceRecord(workspaceId);
      await this.#touchWorkspace(workspaceId);
      return workspace;
    };
    this.getWorkspaceCatalog = async (workspaceId) => {
      await this.#waitForWorkspaceDefinitionRefresh(workspaceId);
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
    this.getSessionTerminalSnapshot = async (sessionId, terminalId, input) => {
      const snapshot = await kernel.getSessionTerminalSnapshot(sessionId, terminalId, input);
      await this.#touchSessionWorkspace(sessionId);
      return snapshot;
    };
    this.writeSessionTerminalInput = async (sessionId, terminalId, input) => {
      const result = await kernel.writeSessionTerminalInput(sessionId, terminalId, input);
      await this.#touchSessionWorkspace(sessionId);
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
      this.#touchWorkspaceBestEffort(input.workspaceId, "session creation");
      this.#scheduleWorkspaceDefinitionRefresh(input.workspaceId);
      this.#scheduleWorkspacePrewarm(input.workspaceId);
      return session;
    };
    this.listWorkspaceSessions = async (workspaceId, pageSize, cursor) => {
      const sessions = await kernel.listWorkspaceSessions(workspaceId, pageSize, cursor);
      this.#touchWorkspaceBestEffort(workspaceId, "list workspace sessions");
      return sessions;
    };
    this.listChildSessions = async (parentSessionId, pageSize, cursor) => {
      const sessions = await kernel.listChildSessions(parentSessionId, pageSize, cursor);
      this.#touchSessionWorkspaceBestEffort(parentSessionId, "list child sessions");
      return sessions;
    };
    this.triggerActionRun = async (input) => {
      const result = await kernel.triggerActionRun(input);
      await this.#touchWorkspace(input.workspaceId);
      return result;
    };
    this.getSession = async (sessionId) => {
      const session = await this.#getSessionRecord(sessionId);
      this.#touchWorkspaceBestEffort(session.workspaceId, "get session");
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
      this.#touchSessionWorkspaceBestEffort(sessionId, "list session messages");
      return messages;
    };
    this.getSessionMessage = async (sessionId, messageId) => {
      const message = await kernel.getSessionMessage(sessionId, messageId);
      this.#touchSessionWorkspaceBestEffort(sessionId, "get session message");
      return message;
    };
    this.getSessionMessageContext = async (sessionId, messageId, before, after) => {
      const context = await kernel.getSessionMessageContext(sessionId, messageId, before, after);
      this.#touchSessionWorkspaceBestEffort(sessionId, "get session message context");
      return context;
    };
    this.listSessionRuns = async (sessionId, pageSize, cursor) => {
      const runs = await kernel.listSessionRuns(sessionId, pageSize, cursor);
      this.#touchSessionWorkspaceBestEffort(sessionId, "list session runs");
      return runs;
    };
    this.listSessionQueuedRuns = async (sessionId) => {
      const queue = await kernel.listSessionQueuedRuns(sessionId);
      this.#touchSessionWorkspaceBestEffort(sessionId, "list session queued runs");
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
    this.listSessionEvents = async (sessionId, cursor, runId, limit) => {
      const events = await kernel.listSessionEvents(sessionId, cursor, runId, limit);
      this.#touchSessionWorkspaceBestEffort(sessionId, "list session events");
      return events;
    };
    this.subscribeSessionEvents = (sessionId, listener) => {
      const unsubscribe = kernel.subscribeSessionEvents(sessionId, listener);
      void this.#touchSessionWorkspace(sessionId);
      return unsubscribe;
    };
    this.getRun = async (runId) => {
      const run = await this.#getRunRecord(runId);
      this.#touchWorkspaceBestEffort(run.workspaceId, "get run");
      return run;
    };
    this.listRunSteps = async (runId, pageSize, cursor) => {
      const steps = await kernel.listRunSteps(runId, pageSize, cursor);
      this.#touchRunWorkspaceBestEffort(runId, "list run steps");
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

  #touchWorkspaceBestEffort(workspaceId: string, context: string): void {
    void Promise.resolve()
      .then(() => this.#workspaceActivityTracker?.touchWorkspace(workspaceId))
      .catch((error: unknown) => {
        this.#logger?.warn?.("Workspace activity touch failed.", {
          workspaceId,
          context,
          errorMessage: error instanceof Error ? error.message : String(error)
        });
      });
  }

  #touchSessionWorkspaceBestEffort(sessionId: string, context: string): void {
    void this.#getSessionRecord(sessionId)
      .then((session) => this.#workspaceActivityTracker?.touchWorkspace(session.workspaceId))
      .catch((error: unknown) => {
        this.#logger?.warn?.("Session workspace activity touch failed.", {
          sessionId,
          context,
          errorMessage: error instanceof Error ? error.message : String(error)
        });
      });
  }

  #touchRunWorkspaceBestEffort(runId: string, context: string): void {
    void this.#getRunRecord(runId)
      .then((run) => this.#workspaceActivityTracker?.touchWorkspace(run.workspaceId))
      .catch((error: unknown) => {
        this.#logger?.warn?.("Run workspace activity touch failed.", {
          runId,
          context,
          errorMessage: error instanceof Error ? error.message : String(error)
        });
      });
  }

  #scheduleWorkspaceDefinitionRefresh(workspaceId: string): void {
    if (!this.#workspaceDefinitionRefresher) {
      return;
    }

    const previous = this.#workspaceDefinitionRefreshes.get(workspaceId);
    const startRefresh = () => this.#workspaceDefinitionRefresher?.refreshWorkspaceDefinition(workspaceId);
    const refresh = (previous ? previous.catch(() => undefined).then(startRefresh) : Promise.resolve(startRefresh()))
      .catch((error: unknown) => {
        this.#logger?.warn?.("Workspace definition refresh failed after session creation.", {
          workspaceId,
          errorMessage: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => {
        if (this.#workspaceDefinitionRefreshes.get(workspaceId) === refresh) {
          this.#workspaceDefinitionRefreshes.delete(workspaceId);
        }
      });

    this.#workspaceDefinitionRefreshes.set(workspaceId, refresh);
  }

  async #waitForWorkspaceDefinitionRefresh(workspaceId: string): Promise<void> {
    await this.#workspaceDefinitionRefreshes.get(workspaceId);
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
