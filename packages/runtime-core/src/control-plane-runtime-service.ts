import type { RuntimeService } from "./runtime-service.js";
import type { WorkspaceActivityTracker } from "./types.js";

type ControlPlaneRuntimeKernel = Pick<
  RuntimeService,
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
  | "createSessionMessage"
  | "listSessionEvents"
  | "subscribeSessionEvents"
  | "getRun"
  | "listRunSteps"
  | "cancelRun"
  | "requeueRun"
>;

export interface ControlPlaneRuntimeOperations extends ControlPlaneRuntimeKernel {}

export class ControlPlaneRuntimeService implements ControlPlaneRuntimeOperations {
  readonly #workspaceActivityTracker?: WorkspaceActivityTracker | undefined;
  readonly #getSessionRecord: RuntimeService["getSession"];
  readonly #getRunRecord: RuntimeService["getRun"];

  readonly createWorkspace: RuntimeService["createWorkspace"];
  readonly listWorkspaces: RuntimeService["listWorkspaces"];
  readonly getWorkspace: RuntimeService["getWorkspace"];
  readonly getWorkspaceRecord: RuntimeService["getWorkspaceRecord"];
  readonly getWorkspaceCatalog: RuntimeService["getWorkspaceCatalog"];
  readonly listWorkspaceEntries: RuntimeService["listWorkspaceEntries"];
  readonly getWorkspaceFileContent: RuntimeService["getWorkspaceFileContent"];
  readonly putWorkspaceFileContent: RuntimeService["putWorkspaceFileContent"];
  readonly uploadWorkspaceFile: RuntimeService["uploadWorkspaceFile"];
  readonly getWorkspaceFileDownload: RuntimeService["getWorkspaceFileDownload"];
  readonly openWorkspaceFileDownload: RuntimeService["openWorkspaceFileDownload"];
  readonly getWorkspaceFileStat: RuntimeService["getWorkspaceFileStat"];
  readonly runWorkspaceCommandForeground: RuntimeService["runWorkspaceCommandForeground"];
  readonly runWorkspaceCommandProcess: RuntimeService["runWorkspaceCommandProcess"];
  readonly runWorkspaceCommandBackground: RuntimeService["runWorkspaceCommandBackground"];
  readonly createWorkspaceDirectory: RuntimeService["createWorkspaceDirectory"];
  readonly deleteWorkspaceEntry: RuntimeService["deleteWorkspaceEntry"];
  readonly moveWorkspaceEntry: RuntimeService["moveWorkspaceEntry"];
  readonly deleteWorkspace: RuntimeService["deleteWorkspace"];
  readonly createSession: RuntimeService["createSession"];
  readonly listWorkspaceSessions: RuntimeService["listWorkspaceSessions"];
  readonly triggerActionRun: RuntimeService["triggerActionRun"];
  readonly getSession: RuntimeService["getSession"];
  readonly updateSession: RuntimeService["updateSession"];
  readonly deleteSession: RuntimeService["deleteSession"];
  readonly listSessionMessages: RuntimeService["listSessionMessages"];
  readonly listSessionRuns: RuntimeService["listSessionRuns"];
  readonly createSessionMessage: RuntimeService["createSessionMessage"];
  readonly listSessionEvents: RuntimeService["listSessionEvents"];
  readonly subscribeSessionEvents: RuntimeService["subscribeSessionEvents"];
  readonly getRun: RuntimeService["getRun"];
  readonly listRunSteps: RuntimeService["listRunSteps"];
  readonly cancelRun: RuntimeService["cancelRun"];
  readonly requeueRun: RuntimeService["requeueRun"];

  constructor(
    kernel: ControlPlaneRuntimeKernel,
    options?: {
      workspaceActivityTracker?: WorkspaceActivityTracker | undefined;
    }
  ) {
    this.#workspaceActivityTracker = options?.workspaceActivityTracker;
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
    this.listSessionMessages = async (sessionId, pageSize, cursor) => {
      const messages = await kernel.listSessionMessages(sessionId, pageSize, cursor);
      await this.#touchSessionWorkspace(sessionId);
      return messages;
    };
    this.listSessionRuns = async (sessionId, pageSize, cursor) => {
      const runs = await kernel.listSessionRuns(sessionId, pageSize, cursor);
      await this.#touchSessionWorkspace(sessionId);
      return runs;
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
    this.requeueRun = async (runId, requestedBy) => {
      const result = await kernel.requeueRun(runId, requestedBy);
      await this.#touchRunWorkspace(runId);
      return result;
    };
  }

  async #touchWorkspace(workspaceId: string): Promise<void> {
    await this.#workspaceActivityTracker?.touchWorkspace(workspaceId);
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
