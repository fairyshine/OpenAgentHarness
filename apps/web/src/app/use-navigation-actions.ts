import { startTransition } from "react";

import type {
  Session,
  SessionPage,
  Workspace,
  WorkspaceCatalog,
  WorkspaceRuntimeList
} from "@oah/api-contracts";

import {
  addRecentId,
  buildAuthHeaders,
  buildUrl,
  compareSavedSessionsByRecency,
  createHttpRequestError,
  isNotFoundError,
  pathLeaf,
  toErrorMessage,
  type SavedSessionRecord,
  type SavedWorkspaceRecord
} from "./support";
import type { NavigationActionParams } from "./navigation-action-types";
import { createNavigationStateActions } from "./navigation-state-actions";
import { isPendingSessionId } from "./app-controller-utils";

const DEFAULT_NEW_SESSION_TITLE = "New session";

function scheduleDeferredIdleTask(callback: () => void, delayMs: number, timeoutMs: number) {
  window.setTimeout(() => {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(callback, { timeout: timeoutMs });
      return;
    }

    callback();
  }, delayMs);
}

export function useNavigationActions(params: NavigationActionParams) {
  const {
    clearSessionSelection,
    clearWorkspaceSelection,
    collectSessionTreeIds,
    expandWorkspaceInSidebar,
    forgetWorkspace,
    forgetWorkspaces,
    rememberSession,
    rememberWorkspace,
    toggleWorkspaceExpansion,
    touchSavedWorkspace
  } = createNavigationStateActions(params);

  async function requestWorkspaceRuntimeEndpoint<T>(path: string, legacyPath: string, init?: RequestInit) {
    try {
      return await params.request<T>(path, init);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }

      return params.request<T>(legacyPath, init);
    }
  }

  async function fetchWorkspaceRuntimeEndpoint(path: string, legacyPath: string, init: RequestInit) {
    const response = await fetch(buildUrl(params.connection.baseUrl, path), init);
    if (response.status !== 404) {
      return response;
    }

    return fetch(buildUrl(params.connection.baseUrl, legacyPath), init);
  }

  async function deleteWorkspace(workspaceToRemoveId: string) {
    const targetWorkspace = params.navigation.savedWorkspaces.find((entry) => entry.id === workspaceToRemoveId);
    const confirmed = window.confirm(
      `确认删除 workspace "${targetWorkspace?.name ?? workspaceToRemoveId}" 吗？这会删除服务端记录，并同步清理受管目录中的 workspace 文件夹。`
    );
    if (!confirmed) {
      return;
    }

    try {
      await params.request<void>(`/api/v1/workspaces/${workspaceToRemoveId}`, {
        method: "DELETE"
      });
      forgetWorkspace(workspaceToRemoveId);
      void refreshWorkspaceIndex(true);
      params.setActivity(`Workspace ${workspaceToRemoveId} 已删除`);
      params.setErrorMessage("");
    } catch (error) {
      if (isNotFoundError(error)) {
        forgetWorkspace(workspaceToRemoveId);
        void refreshWorkspaceIndex(true);
        params.setActivity(`Workspace ${workspaceToRemoveId} 已从列表清理`);
        params.setErrorMessage("");
        return;
      }

      params.setErrorMessage(toErrorMessage(error));
    }
  }

  async function deleteWorkspacesForRuntime(runtimeName: string, workspaceIds: string[]): Promise<boolean> {
    const normalizedRuntimeName = runtimeName.trim();
    const workspaceIdsToRemove = Array.from(new Set(workspaceIds.map((entry) => entry.trim()).filter(Boolean)));
    if (!normalizedRuntimeName) {
      params.setErrorMessage("请先选择一个 runtime。");
      return false;
    }
    if (workspaceIdsToRemove.length === 0) {
      params.setActivity(`Runtime "${normalizedRuntimeName}" 下没有可删除的 workspace`);
      params.setErrorMessage("");
      return false;
    }

    const confirmed = window.confirm(
      `确认删除 runtime "${normalizedRuntimeName}" 下的 ${workspaceIdsToRemove.length} 个 workspace 吗？这会删除服务端记录，并同步清理受管目录中的 workspace 文件夹。`
    );
    if (!confirmed) {
      return false;
    }

    const results = await Promise.all(
      workspaceIdsToRemove.map(async (workspaceId) => {
        try {
          await params.request<void>(`/api/v1/workspaces/${workspaceId}`, {
            method: "DELETE"
          });
          return { workspaceId, ok: true as const };
        } catch (error) {
          if (isNotFoundError(error)) {
            return { workspaceId, ok: true as const };
          }
          return { workspaceId, error, ok: false as const };
        }
      })
    );

    const deletedWorkspaceIds = results.filter((result) => result.ok).map((result) => result.workspaceId);
    const failedResults = results.filter((result): result is Extract<(typeof results)[number], { ok: false }> => !result.ok);

    if (deletedWorkspaceIds.length > 0) {
      forgetWorkspaces(deletedWorkspaceIds);
      void refreshWorkspaceIndex(true);
    }

    if (failedResults.length > 0) {
      params.setActivity(
        `Runtime "${normalizedRuntimeName}" 下已删除 ${deletedWorkspaceIds.length} 个 workspace，${failedResults.length} 个删除失败`
      );
      params.setErrorMessage(failedResults.map((result) => `${result.workspaceId}: ${toErrorMessage(result.error)}`).join(" | "));
      return false;
    }

    params.setActivity(`Runtime "${normalizedRuntimeName}" 下的 ${deletedWorkspaceIds.length} 个 workspace 已删除`);
    params.setErrorMessage("");
    return true;
  }

  async function removeSavedSession(sessionToRemoveId: string) {
    if (isPendingSessionId(sessionToRemoveId)) {
      params.navigation.setSavedSessions((current) => current.filter((entry) => entry.id !== sessionToRemoveId));
      params.navigation.setRecentSessions((current) => current.filter((entry) => entry !== sessionToRemoveId));
      params.navigation.setExpandedSessionIds((current) => current.filter((entry) => entry !== sessionToRemoveId));
      return;
    }

    const sessionIdsToRemove = collectSessionTreeIds(sessionToRemoveId, params.navigation.savedSessions);
    const sessionIdsToRemoveSet = new Set(sessionIdsToRemove);
    const previousSavedSessions = params.navigation.savedSessions;
    const previousRecentSessions = params.navigation.recentSessions;
    const previousExpandedSessionIds = params.navigation.expandedSessionIds;
    const wasSelected = Boolean(params.navigation.sessionId && sessionIdsToRemoveSet.has(params.navigation.sessionId));

    params.navigation.setSavedSessions((current) => current.filter((entry) => !sessionIdsToRemoveSet.has(entry.id)));
    params.navigation.setRecentSessions((current) => current.filter((entry) => !sessionIdsToRemoveSet.has(entry)));
    params.navigation.setExpandedSessionIds((current) => current.filter((entry) => !sessionIdsToRemoveSet.has(entry)));

    if (wasSelected) {
      clearSessionSelection();
    }

    try {
      await params.request<void>(`/api/v1/sessions/${sessionToRemoveId}`, { method: "DELETE" });
    } catch (error) {
      if (!isNotFoundError(error)) {
        params.navigation.setSavedSessions(previousSavedSessions);
        params.navigation.setRecentSessions(previousRecentSessions);
        params.navigation.setExpandedSessionIds(previousExpandedSessionIds);
        params.setErrorMessage(toErrorMessage(error));
        return;
      }
    }

    const removedChildCount = Math.max(0, sessionIdsToRemove.length - 1);
    params.setActivity(
      removedChildCount > 0
        ? `Session ${sessionToRemoveId} 及其 ${removedChildCount} 个子 Session 已删除`
        : `Session ${sessionToRemoveId} 已删除`
    );
    params.setErrorMessage("");
  }

  async function renameSession(sessionToRenameId: string, title: string) {
    if (isPendingSessionId(sessionToRenameId)) {
      return;
    }

    const nextTitle = title.trim();
    if (!nextTitle) {
      params.setErrorMessage("Session 名称不能为空。");
      return;
    }

    try {
      const updated = await params.request<Session>(`/api/v1/sessions/${sessionToRenameId}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ title: nextTitle })
      });

      rememberSession(updated);
      if (params.navigation.session?.id === updated.id) {
        params.navigation.setSession(updated);
      }
      params.setActivity(`Session ${updated.id} 已重命名`);
      params.setErrorMessage("");
    } catch (error) {
      if (isNotFoundError(error)) {
        if (params.navigation.session?.id === sessionToRenameId || params.navigation.sessionId === sessionToRenameId) {
          clearSessionSelection(sessionToRenameId, { forgetSession: true });
        } else {
          params.navigation.setSavedSessions((current) => current.filter((entry) => entry.id !== sessionToRenameId));
          params.navigation.setRecentSessions((current) => current.filter((entry) => entry !== sessionToRenameId));
        }
      }
      params.setErrorMessage(toErrorMessage(error));
    }
  }

  async function switchSessionAgent(sessionToUpdateId: string, activeAgentName: string): Promise<Session | null> {
    if (isPendingSessionId(sessionToUpdateId)) {
      return null;
    }

    const nextAgentName = activeAgentName.trim();
    if (!nextAgentName) {
      params.setErrorMessage("Agent 名称不能为空。");
      return null;
    }

    try {
      const updated = await params.request<Session>(`/api/v1/sessions/${sessionToUpdateId}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ activeAgentName: nextAgentName })
      });

      rememberSession(updated);
      if (params.navigation.session?.id === updated.id) {
        params.navigation.setSession(updated);
      }
      params.setActivity(`Session ${updated.id} 已切换到 agent ${updated.activeAgentName}`);
      params.setErrorMessage("");
      return updated;
    } catch (error) {
      if (isNotFoundError(error)) {
        if (params.navigation.session?.id === sessionToUpdateId || params.navigation.sessionId === sessionToUpdateId) {
          clearSessionSelection(sessionToUpdateId, { forgetSession: true });
        } else {
          params.navigation.setSavedSessions((current) => current.filter((entry) => entry.id !== sessionToUpdateId));
          params.navigation.setRecentSessions((current) => current.filter((entry) => entry !== sessionToUpdateId));
        }
      }
      params.setErrorMessage(toErrorMessage(error));
      return null;
    }
  }

  async function updateSessionModel(sessionToUpdateId: string, modelRef: string | null): Promise<Session | null> {
    if (isPendingSessionId(sessionToUpdateId)) {
      return null;
    }

    try {
      const updated = await params.request<Session>(`/api/v1/sessions/${sessionToUpdateId}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ modelRef })
      });

      rememberSession(updated);
      if (params.navigation.session?.id === updated.id) {
        params.navigation.setSession(updated);
      }
      params.setActivity(
        updated.modelRef ? `Session ${updated.id} 已绑定模型 ${updated.modelRef}` : `Session ${updated.id} 已恢复默认模型策略`
      );
      params.setErrorMessage("");
      return updated;
    } catch (error) {
      if (isNotFoundError(error)) {
        if (params.navigation.session?.id === sessionToUpdateId || params.navigation.sessionId === sessionToUpdateId) {
          clearSessionSelection(sessionToUpdateId, { forgetSession: true });
        } else {
          params.navigation.setSavedSessions((current) => current.filter((entry) => entry.id !== sessionToUpdateId));
          params.navigation.setRecentSessions((current) => current.filter((entry) => entry !== sessionToUpdateId));
        }
      }
      params.setErrorMessage(toErrorMessage(error));
      return null;
    }
  }

  async function refreshWorkspaceRuntimes(quiet = false) {
    try {
      const response = await requestWorkspaceRuntimeEndpoint<WorkspaceRuntimeList>(
        "/api/v1/runtimes",
        "/api/v1/blueprints"
      );
      startTransition(() => {
        params.navigation.setWorkspaceManagementEnabled(true);
        params.navigation.setWorkspaceRuntimes(response.items.map((item) => item.name));
      });
      if (!quiet) {
        params.setActivity(`已加载 ${response.items.length} 个运行时`);
        params.setErrorMessage("");
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("workspace_runtimes_unavailable") ||
          error.message.includes("workspace_blueprints_unavailable") ||
          error.message.toLowerCase().includes("workspace runtimes are not available") ||
          error.message.toLowerCase().includes("workspace blueprints are not available"))
      ) {
        startTransition(() => {
          params.navigation.setWorkspaceManagementEnabled(false);
          params.navigation.setWorkspaceRuntimes([]);
        });
        if (!quiet) {
          params.setErrorMessage("");
        }
        return;
      }

      if (!quiet) {
        params.setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function uploadWorkspaceRuntime(file: File, name: string, overwrite: boolean): Promise<boolean> {
    try {
      const query = new URLSearchParams({ name });
      if (overwrite) {
        query.set("overwrite", "true");
      }
      const response = await fetchWorkspaceRuntimeEndpoint(
        `/api/v1/runtimes/upload?${query.toString()}`,
        `/api/v1/blueprints/upload?${query.toString()}`,
        {
          method: "POST",
          headers: buildAuthHeaders(params.connection, { "content-type": "application/octet-stream" }),
          body: file
        }
      );
      if (!response.ok) {
        throw await createHttpRequestError(response);
      }
      await refreshWorkspaceRuntimes(true);
      params.setActivity(`运行时 "${name}" 上传成功`);
      params.setErrorMessage("");
      return true;
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
      return false;
    }
  }

  async function deleteWorkspaceRuntime(runtimeName: string): Promise<boolean> {
    try {
      const encodedRuntimeName = encodeURIComponent(runtimeName);
      const response = await fetchWorkspaceRuntimeEndpoint(
        `/api/v1/runtimes/${encodedRuntimeName}`,
        `/api/v1/blueprints/${encodedRuntimeName}`,
        {
          method: "DELETE",
          headers: buildAuthHeaders(params.connection)
        }
      );
      if (!response.ok) {
        throw await createHttpRequestError(response);
      }
      await refreshWorkspaceRuntimes(true);
      params.setActivity(`运行时 "${runtimeName}" 已删除`);
      params.setErrorMessage("");
      return true;
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
      return false;
    }
  }

  async function updateWorkspaceRuntime(runtimeName: string, file: File): Promise<boolean> {
    try {
      const normalizedRuntimeName = runtimeName.trim();
      if (!normalizedRuntimeName) {
        params.setErrorMessage("请先选择一个 runtime。");
        return false;
      }

      const encodedRuntimeName = encodeURIComponent(normalizedRuntimeName);
      const response = await fetchWorkspaceRuntimeEndpoint(
        `/api/v1/runtimes/${encodedRuntimeName}`,
        `/api/v1/blueprints/${encodedRuntimeName}`,
        {
          method: "PUT",
          headers: buildAuthHeaders(params.connection, { "content-type": "application/octet-stream" }),
          body: file
        }
      );
      if (!response.ok) {
        throw await createHttpRequestError(response);
      }
      await refreshWorkspaceRuntimes(true);
      params.setActivity(`运行时 "${normalizedRuntimeName}" 已更新`);
      params.setErrorMessage("");
      return true;
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
      return false;
    }
  }

  async function refreshWorkspaceIndex(quiet = false) {
    try {
      const response = await params.request<{ items: Workspace[]; nextCursor?: string }>("/api/v1/workspaces?pageSize=200");
      const visibleWorkspaceIds = new Set(response.items.map((item) => item.id));
      const existingSessionById = new Map(params.navigation.savedSessions.map((entry) => [entry.id, entry]));
      startTransition(() => {
        params.navigation.setSavedWorkspaces((current) => {
          const currentById = new Map(current.map((entry) => [entry.id, entry]));
          return response.items.map((item) => {
            const existing = currentById.get(item.id);
            const existingName = existing?.name.trim() ?? "";
            const responseName = item.name.trim();
            const responseLooksLikeManagedDirectoryName =
              responseName === pathLeaf(item.rootPath) && /^ws_[a-f0-9]{32}$/i.test(responseName);
            const name = existingName && responseLooksLikeManagedDirectoryName ? existingName : item.name;
            return {
              id: item.id,
              name,
              rootPath: item.rootPath,
              status: item.status,
              createdAt: item.createdAt,
              lastOpenedAt: existing?.lastOpenedAt ?? item.updatedAt,
              ...(item.serviceName ? { serviceName: item.serviceName } : {}),
              ...(item.runtime
                ? { runtime: item.runtime }
                : existing?.runtime
                  ? { runtime: existing.runtime }
                  : {})
            } satisfies SavedWorkspaceRecord;
          });
        });
        params.navigation.setRecentWorkspaces((current) => current.filter((entry) => visibleWorkspaceIds.has(entry)));
        params.navigation.setExpandedWorkspaceIds((current) => current.filter((entry) => visibleWorkspaceIds.has(entry)));
      });

      const sessionPages = await Promise.all(
        response.items.map(async (workspace) => {
          try {
            const sessions: Session[] = [];
            let cursor: string | undefined;

            do {
              const query = new URLSearchParams({
                pageSize: "200"
              });
              if (cursor) {
                query.set("cursor", cursor);
              }
              const page = await params.request<SessionPage>(`/api/v1/workspaces/${workspace.id}/sessions?${query.toString()}`);
              sessions.push(...page.items);
              cursor = page.nextCursor;
            } while (cursor);

            return {
              workspaceId: workspace.id,
              items: sessions,
              ok: true as const
            };
          } catch (error) {
            return {
              workspaceId: workspace.id,
              error,
              ok: false as const
            };
          }
        })
      );
      const syncedSessions = new Map<string, SavedSessionRecord>();
      const failedWorkspaceIds = new Set<string>();

      for (const result of sessionPages) {
        if (result.ok) {
          for (const session of result.items) {
            const existing = existingSessionById.get(session.id);
            syncedSessions.set(session.id, {
              id: session.id,
              workspaceId: session.workspaceId,
              ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
              title: session.title,
              modelRef: session.modelRef,
              agentName: session.activeAgentName,
              lastRunAt: session.lastRunAt,
              createdAt: session.createdAt,
              lastOpenedAt: existing?.lastOpenedAt ?? session.createdAt
            });
          }
        } else {
          failedWorkspaceIds.add(result.workspaceId);
        }
      }

      for (const entry of params.navigation.savedSessions) {
        if (!visibleWorkspaceIds.has(entry.workspaceId)) {
          continue;
        }
        if (syncedSessions.has(entry.id)) {
          continue;
        }
        if (!failedWorkspaceIds.has(entry.workspaceId)) {
          continue;
        }
        syncedSessions.set(entry.id, entry);
      }

      startTransition(() => {
        params.navigation.setSavedSessions((current) => {
          const currentById = new Map(current.map((entry) => [entry.id, entry]));
          const next: SavedSessionRecord[] = [];

          for (const entry of current) {
            const synced = syncedSessions.get(entry.id);
            if (synced) {
              next.push({
                ...entry,
                ...synced
              });
            }
          }

          for (const entry of syncedSessions.values()) {
            if (!currentById.has(entry.id)) {
              next.push(entry);
            }
          }

          return next.sort(compareSavedSessionsByRecency);
        });
        params.navigation.setRecentSessions((current) =>
          current.filter((entry) => {
            const sessionRecord = syncedSessions.get(entry);
            return Boolean(sessionRecord && visibleWorkspaceIds.has(sessionRecord.workspaceId));
          })
        );
      });

      const selectedWorkspaceId = params.navigation.workspaceId.trim();
      const selectedWorkspaceExists =
        selectedWorkspaceId.length > 0 && response.items.some((item) => item.id === selectedWorkspaceId);

      if (!params.navigation.sessionId.trim() && selectedWorkspaceId) {
        if (selectedWorkspaceExists) {
          if (params.navigation.workspace?.id !== selectedWorkspaceId) {
            expandWorkspaceInSidebar(selectedWorkspaceId);
            void refreshWorkspace(selectedWorkspaceId, true);
          }
        } else {
          clearWorkspaceSelection(selectedWorkspaceId);
        }
      } else if (response.items.length === 1) {
        const onlyWorkspace = response.items[0]!;
        if (!params.navigation.sessionId.trim() && params.navigation.workspaceId !== onlyWorkspace.id) {
          expandWorkspaceInSidebar(onlyWorkspace.id);
          void refreshWorkspace(onlyWorkspace.id, true);
        }
      }

      if (!quiet) {
        params.setActivity(`已同步 ${response.items.length} 个 workspace`);
        params.setErrorMessage("");
      }
    } catch (error) {
      if (!quiet) {
        params.setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function refreshWorkspace(targetId = params.navigation.workspaceId, quiet = false) {
    if (!targetId.trim()) {
      return;
    }

    try {
      const workspaceResponse = await params.request<Workspace>(`/api/v1/workspaces/${targetId}`);
      const [catalogResponse] = await Promise.allSettled([
        params.request<WorkspaceCatalog>(`/api/v1/workspaces/${targetId}/catalog`)
      ]);
      const refreshWarnings = [catalogResponse]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => toErrorMessage(result.reason));

      startTransition(() => {
        params.navigation.setWorkspace(workspaceResponse);
        params.navigation.setCatalog(catalogResponse.status === "fulfilled" ? catalogResponse.value : null);
        params.navigation.setWorkspaceId(targetId);
        params.navigation.setRecentWorkspaces((current) => addRecentId(current, targetId));
      });
      expandWorkspaceInSidebar(targetId);
      rememberWorkspace(workspaceResponse);
      params.setActivity(`Workspace ${targetId} 已加载`);
      if (!quiet && refreshWarnings.length > 0) {
        params.setErrorMessage(refreshWarnings.join(" | "));
      } else if (!quiet) {
        params.setErrorMessage("");
      }
    } catch (error) {
      params.navigation.setWorkspace(null);
      params.navigation.setCatalog(null);
      if (isNotFoundError(error)) {
        forgetWorkspace(targetId);
        void refreshWorkspaceIndex(true);
        if (!quiet) {
          params.setActivity(`Workspace ${targetId} 不存在，已从列表清理`);
          params.setErrorMessage("");
        }
        return;
      }
      if (!quiet) {
        params.setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function createWorkspace() {
    try {
      const rootPath = params.navigation.workspaceDraft.rootPath?.trim() ?? "";
      const ownerId = params.navigation.workspaceDraft.ownerId?.trim() ?? "";
      const serviceName = params.navigation.workspaceDraft.serviceName?.trim() ?? "";
      const runtime = params.navigation.workspaceDraft.runtime?.trim() ?? "";
      const created = await params.request<Workspace>("/api/v1/workspaces", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          name: params.navigation.workspaceDraft.name.trim(),
          runtime,
          ...(rootPath ? { rootPath } : {}),
          ...(ownerId ? { ownerId } : {}),
          ...(serviceName ? { serviceName } : {}),
          executionPolicy: "local"
        })
      });

      startTransition(() => {
        params.navigation.activeWorkspaceIdRef.current = created.id;
        params.navigation.setWorkspaceId(created.id);
        params.runtime.setSelectedRunId("");
        params.runtime.setRun(null);
        params.runtime.setRunSteps([]);
        params.navigation.setSession(null);
        params.navigation.setSessionId("");
        params.runtime.setMessages([]);
        params.runtime.setEvents([]);
        params.runtime.setLiveMessagesByKey({});
        params.runtime.setStreamState("idle");
        params.navigation.setWorkspace(created);
        params.navigation.setCatalog(null);
        params.navigation.setSavedSessions((current) => current.filter((entry) => entry.workspaceId !== created.id));
        params.navigation.setRecentWorkspaces((current) => addRecentId(current, created.id));
      });
      rememberWorkspace(created, {
        runtime
      });
      params.runtime.lastCursorRef.current = undefined;
      params.navigation.setWorkspaceDraft((current) => ({
        ...current,
        runtime: "",
        ownerId: "",
        serviceName: ""
      }));
      params.navigation.setShowWorkspaceCreator(false);
      expandWorkspaceInSidebar(created.id);
      const folderName = pathLeaf(created.rootPath);
      params.setActivity(
        folderName
          ? `Workspace ${created.name} 已创建 · ${created.id} · dir ${folderName}`
          : `Workspace ${created.name} 已创建 · ${created.id}`
      );
      params.setErrorMessage("");
      void params.request<WorkspaceCatalog>(`/api/v1/workspaces/${created.id}/catalog`).then(
        (catalog) => {
          if (params.navigation.activeWorkspaceIdRef.current === created.id) {
            startTransition(() => {
              params.navigation.setCatalog(catalog);
            });
          }
        },
        () => {
          // Catalog hydration is best-effort here; the workspace is already usable.
        }
      );
      scheduleDeferredIdleTask(() => {
        void refreshWorkspaceIndex(true);
      }, 1_500, 5_000);
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
    }
  }

  async function refreshSession(targetId = params.navigation.sessionId, quiet = false) {
      const nextSessionId = targetId.trim();
    if (!nextSessionId) {
      return;
    }
    if (isPendingSessionId(nextSessionId)) {
      return;
    }

    const switchingSession = nextSessionId !== params.navigation.sessionId;

    if (switchingSession) {
      const cachedSession = params.navigation.savedSessions.find((entry) => entry.id === nextSessionId);
      params.runtime.lastExplicitSessionRefreshRef.current = { sessionId: nextSessionId, at: Date.now() };
      params.runtime.streamAbortRef.current?.abort();
      params.runtime.lastCursorRef.current = undefined;
      window.clearTimeout(params.runtime.runPollingTimerRef.current);
      startTransition(() => {
        params.runtime.setStreamState("idle");
        params.navigation.setSessionId(nextSessionId);
        params.navigation.setSession(
          cachedSession
            ? {
                id: cachedSession.id,
                workspaceId: cachedSession.workspaceId,
                subjectRef: "",
                agentName: cachedSession.agentName,
                activeAgentName: cachedSession.agentName,
                status: "active",
                title: cachedSession.title,
                modelRef: cachedSession.modelRef,
                createdAt: cachedSession.createdAt,
                updatedAt: cachedSession.lastRunAt ?? cachedSession.createdAt,
                ...(cachedSession.parentSessionId ? { parentSessionId: cachedSession.parentSessionId } : {})
              }
            : null
        );
        params.runtime.setMessages([]);
        params.runtime.setEvents([]);
        params.runtime.setSelectedRunId("");
        params.runtime.setRun(null);
        params.runtime.setRunSteps([]);
        params.runtime.setLiveMessagesByKey({});
      });
    }

    try {
      const sessionResponse = await params.request<Session>(`/api/v1/sessions/${nextSessionId}`);
      params.runtime.lastExplicitSessionRefreshRef.current = { sessionId: nextSessionId, at: Date.now() };
      const nextWorkspaceId = sessionResponse.workspaceId;
      const workspaceChanged = params.navigation.workspace?.id !== nextWorkspaceId;

      startTransition(() => {
        params.navigation.setSession(sessionResponse);
        params.navigation.setSessionId(nextSessionId);
        params.navigation.setWorkspaceId(nextWorkspaceId);
        params.navigation.setRecentSessions((current) => addRecentId(current, nextSessionId));
        if (workspaceChanged) {
          params.navigation.setWorkspace(null);
          params.navigation.setCatalog(null);
        }
      });
      expandWorkspaceInSidebar(nextWorkspaceId);
      touchSavedWorkspace(nextWorkspaceId);
      rememberSession(sessionResponse);
      if (workspaceChanged) {
        window.setTimeout(() => {
          void refreshWorkspace(nextWorkspaceId, true);
        }, 250);
      }
      params.setActivity(`Session ${nextSessionId} 已加载`);
      if (!quiet) {
        params.setErrorMessage("");
      }
    } catch (error) {
      params.navigation.setSession(null);
      params.runtime.setMessages([]);
      if (isNotFoundError(error)) {
        clearSessionSelection(nextSessionId, { forgetSession: true });
      }
      if (!quiet) {
        params.setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function createSession() {
    if (!params.navigation.workspaceId.trim()) {
      params.setErrorMessage("请先创建或加载 workspace。");
      return;
    }

    if (params.runtime.newEmptySessionIdRef.current?.startsWith("pending-session:")) {
      return;
    }

    const pendingSessionId = `pending-session:${crypto.randomUUID()}`;
    const pendingCreatedAt = new Date().toISOString();
    const pendingSession: Session = {
      id: pendingSessionId,
      workspaceId: params.navigation.workspaceId,
      subjectRef: "",
      agentName: "",
      activeAgentName: "",
      status: "active",
      title: DEFAULT_NEW_SESSION_TITLE,
      createdAt: pendingCreatedAt,
      updatedAt: pendingCreatedAt
    };

    params.runtime.streamAbortRef.current?.abort();
    params.runtime.activeSessionIdRef.current = pendingSessionId;
    params.runtime.lastCursorRef.current = undefined;
    params.runtime.newEmptySessionIdRef.current = pendingSessionId;
    window.clearTimeout(params.runtime.runPollingTimerRef.current);
    startTransition(() => {
      params.navigation.setSession(pendingSession);
      params.navigation.setSessionId(pendingSessionId);
      params.navigation.setSavedSessions((current) =>
        [
          {
            id: pendingSessionId,
            workspaceId: params.navigation.workspaceId,
            title: pendingSession.title,
            agentName: pendingSession.activeAgentName,
            createdAt: pendingCreatedAt,
            lastOpenedAt: pendingCreatedAt
          },
          ...current.filter((entry) => entry.id !== pendingSessionId)
        ].sort(compareSavedSessionsByRecency)
      );
      params.navigation.setRecentSessions((current) => addRecentId(current, pendingSessionId));
      params.runtime.setStreamState("idle");
      params.runtime.setMessages([]);
      params.runtime.setEvents([]);
      params.runtime.setSelectedRunId("");
      params.runtime.setRun(null);
      params.runtime.setRunSteps([]);
      params.runtime.setLiveMessagesByKey({});
    });
    expandWorkspaceInSidebar(params.navigation.workspaceId);
    params.setActivity("Session 正在创建…");
    params.setErrorMessage("");

    try {
      const created = await params.request<Session>(`/api/v1/workspaces/${params.navigation.workspaceId}/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ title: DEFAULT_NEW_SESSION_TITLE })
      });

      if (params.runtime.activeSessionIdRef.current !== pendingSessionId) {
        if (params.runtime.newEmptySessionIdRef.current === pendingSessionId) {
          params.runtime.newEmptySessionIdRef.current = null;
        }
        params.navigation.setSavedSessions((current) => current.filter((entry) => entry.id !== pendingSessionId));
        params.navigation.setRecentSessions((current) => current.filter((entry) => entry !== pendingSessionId));
        rememberSession(created);
        return;
      }

      params.runtime.activeSessionIdRef.current = created.id;
      params.runtime.lastExplicitSessionRefreshRef.current = { sessionId: created.id, at: Date.now() };
      params.runtime.newEmptySessionIdRef.current = created.id;
      startTransition(() => {
        params.navigation.setSession(created);
        params.navigation.setSessionId(created.id);
        params.navigation.setWorkspaceId(created.workspaceId);
        params.navigation.setSavedSessions((current) =>
          current.map((entry) =>
            entry.id === pendingSessionId
              ? {
                  id: created.id,
                  workspaceId: created.workspaceId,
                  ...(created.parentSessionId ? { parentSessionId: created.parentSessionId } : {}),
                  title: created.title,
                  modelRef: created.modelRef,
                  agentName: created.activeAgentName,
                  lastRunAt: created.lastRunAt,
                  createdAt: created.createdAt,
                  lastOpenedAt: entry.lastOpenedAt
                }
              : entry
          )
        );
        params.navigation.setRecentSessions((current) => addRecentId(current.filter((entry) => entry !== pendingSessionId), created.id));
      });
      rememberSession(created);
      touchSavedWorkspace(created.workspaceId);
      expandWorkspaceInSidebar(created.workspaceId);
      params.setActivity(`Session ${created.id} 已创建`);
      params.setErrorMessage("");
    } catch (error) {
      if (params.runtime.activeSessionIdRef.current === pendingSessionId) {
        params.runtime.activeSessionIdRef.current = "";
        params.runtime.newEmptySessionIdRef.current = null;
        startTransition(() => {
          params.navigation.setSession(null);
          params.navigation.setSessionId("");
          params.navigation.setSavedSessions((current) => current.filter((entry) => entry.id !== pendingSessionId));
          params.navigation.setRecentSessions((current) => current.filter((entry) => entry !== pendingSessionId));
          params.runtime.setMessages([]);
          params.runtime.setEvents([]);
          params.runtime.setLiveMessagesByKey({});
        });
      }
      params.setErrorMessage(toErrorMessage(error));
    }
  }

  function openWorkspace(targetId: string) {
    const nextWorkspaceId = targetId.trim();
    if (!nextWorkspaceId) {
      return;
    }

    const shouldClearSession =
      Boolean(params.navigation.sessionId.trim()) &&
      ((params.navigation.session?.workspaceId && params.navigation.session.workspaceId !== nextWorkspaceId) ||
        (!params.navigation.session?.workspaceId && params.navigation.workspaceId.trim() !== nextWorkspaceId));

    if (shouldClearSession) {
      clearSessionSelection();
    }

    expandWorkspaceInSidebar(nextWorkspaceId);
    params.navigation.setWorkspaceId(nextWorkspaceId);
    void refreshWorkspace(nextWorkspaceId);
  }

  return {
    expandWorkspaceInSidebar,
    toggleWorkspaceExpansion,
    deleteWorkspace,
    deleteWorkspacesForRuntime,
    removeSavedSession,
    renameSession,
    switchSessionAgent,
    updateSessionModel,
    clearSessionSelection,
    clearWorkspaceSelection,
    openWorkspace,
    refreshWorkspaceRuntimes,
    uploadWorkspaceRuntime,
    updateWorkspaceRuntime,
    deleteWorkspaceRuntime,
    refreshWorkspaceIndex,
    refreshWorkspace,
    createWorkspace,
    refreshSession,
    createSession
  };
}
