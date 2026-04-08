import { startTransition, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import type {
  Message,
  Run,
  RunStep,
  Session,
  SessionPage,
  Workspace,
  WorkspaceHistoryMirrorStatus,
  WorkspaceCatalog,
  WorkspaceTemplateList
} from "@oah/api-contracts";

import {
  addRecentId,
  isNotFoundError,
  pathLeaf,
  toErrorMessage,
  type SavedSessionRecord,
  type SavedWorkspaceRecord,
  type WorkspaceDraft
} from "./support";

type AppRequest = <T>(path: string, init?: RequestInit, options?: { auth?: boolean }) => Promise<T>;

export function useNavigationActions(params: {
  request: AppRequest;
  setActivity: (value: string) => void;
  setErrorMessage: (value: string) => void;
  navigation: {
    workspaceDraft: WorkspaceDraft;
    setWorkspaceDraft: Dispatch<SetStateAction<WorkspaceDraft>>;
    workspaceId: string;
    setWorkspaceId: Dispatch<SetStateAction<string>>;
    sessionId: string;
    setSessionId: Dispatch<SetStateAction<string>>;
    savedWorkspaces: SavedWorkspaceRecord[];
    setSavedWorkspaces: Dispatch<SetStateAction<SavedWorkspaceRecord[]>>;
    savedSessions: SavedSessionRecord[];
    setSavedSessions: Dispatch<SetStateAction<SavedSessionRecord[]>>;
    recentWorkspaces: string[];
    setRecentWorkspaces: Dispatch<SetStateAction<string[]>>;
    setRecentSessions: Dispatch<SetStateAction<string[]>>;
    expandedWorkspaceIds: string[];
    setExpandedWorkspaceIds: Dispatch<SetStateAction<string[]>>;
    setExpandedSessionIds: Dispatch<SetStateAction<string[]>>;
    workspace: Workspace | null;
    setWorkspace: Dispatch<SetStateAction<Workspace | null>>;
    setWorkspaceTemplates: Dispatch<SetStateAction<string[]>>;
    setCatalog: Dispatch<SetStateAction<WorkspaceCatalog | null>>;
    setMirrorStatus: Dispatch<SetStateAction<WorkspaceHistoryMirrorStatus | null>>;
    session: Session | null;
    setSession: Dispatch<SetStateAction<Session | null>>;
    setShowWorkspaceCreator: Dispatch<SetStateAction<boolean>>;
    setMirrorRebuildBusy: Dispatch<SetStateAction<boolean>>;
    setWorkspaceManagementEnabled: Dispatch<SetStateAction<boolean>>;
  };
  runtime: {
    setMessages: Dispatch<SetStateAction<Message[]>>;
    setEvents: Dispatch<SetStateAction<import("@oah/api-contracts").SessionEventContract[]>>;
    setSelectedRunId: Dispatch<SetStateAction<string>>;
    setRun: Dispatch<SetStateAction<Run | null>>;
    setRunSteps: Dispatch<SetStateAction<RunStep[]>>;
    setLiveOutput: Dispatch<SetStateAction<Record<string, string>>>;
    setStreamState: Dispatch<SetStateAction<"idle" | "connecting" | "listening" | "open" | "error">>;
    streamAbortRef: MutableRefObject<AbortController | null>;
    lastCursorRef: MutableRefObject<string | undefined>;
    runPollingTimerRef: MutableRefObject<number | undefined>;
  };
}) {
  function rememberWorkspace(
    workspaceRecord: Workspace,
    options?: {
      template?: string;
    }
  ) {
    const now = new Date().toISOString();
    params.navigation.setSavedWorkspaces((current) => {
      const existing = current.find((entry) => entry.id === workspaceRecord.id);
      const nextRecord: SavedWorkspaceRecord = {
        id: workspaceRecord.id,
        name: workspaceRecord.name,
        rootPath: workspaceRecord.rootPath,
        status: workspaceRecord.status,
        createdAt: workspaceRecord.createdAt ?? existing?.createdAt,
        lastOpenedAt: now
      };
      const templateValue = options?.template ?? existing?.template;
      if (templateValue) {
        nextRecord.template = templateValue;
      }

      if (existing) {
        return current.map((entry) => (entry.id === workspaceRecord.id ? nextRecord : entry));
      }

      return [...current, nextRecord].slice(-24);
    });
  }

  function touchSavedWorkspace(targetWorkspaceId: string) {
    if (!targetWorkspaceId.trim()) {
      return;
    }

    const now = new Date().toISOString();
    params.navigation.setSavedWorkspaces((current) =>
      current.map((entry) =>
        entry.id === targetWorkspaceId
          ? {
              ...entry,
              lastOpenedAt: now
            }
          : entry
      )
    );
    params.navigation.setRecentWorkspaces((current) => addRecentId(current, targetWorkspaceId));
  }

  function rememberSession(sessionRecord: Session) {
    const now = new Date().toISOString();
    const nextRecord: SavedSessionRecord = {
      id: sessionRecord.id,
      workspaceId: sessionRecord.workspaceId,
      ...(sessionRecord.parentSessionId ? { parentSessionId: sessionRecord.parentSessionId } : {}),
      title: sessionRecord.title,
      modelRef: sessionRecord.modelRef,
      agentName: sessionRecord.activeAgentName,
      lastRunAt: sessionRecord.lastRunAt,
      createdAt: sessionRecord.createdAt,
      lastOpenedAt: now
    };

    params.navigation.setSavedSessions((current) => {
      const existingIndex = current.findIndex((entry) => entry.id === sessionRecord.id);
      if (existingIndex >= 0) {
        return current.map((entry, index) => (index === existingIndex ? { ...entry, ...nextRecord } : entry));
      }

      return [...current, nextRecord].slice(-48);
    });
  }

  function collectSessionTreeIds(rootSessionId: string, sessions: SavedSessionRecord[]): string[] {
    const childIdsByParentId = new Map<string, string[]>();
    for (const entry of sessions) {
      if (!entry.parentSessionId) {
        continue;
      }

      const childIds = childIdsByParentId.get(entry.parentSessionId) ?? [];
      childIds.push(entry.id);
      childIdsByParentId.set(entry.parentSessionId, childIds);
    }

    const collectedIds: string[] = [];
    const visit = (sessionId: string) => {
      collectedIds.push(sessionId);
      for (const childSessionId of childIdsByParentId.get(sessionId) ?? []) {
        visit(childSessionId);
      }
    };

    visit(rootSessionId);
    return collectedIds;
  }

  function expandWorkspaceInSidebar(targetWorkspaceId: string) {
    if (!targetWorkspaceId.trim()) {
      return;
    }

    params.navigation.setExpandedWorkspaceIds((current) =>
      current.includes(targetWorkspaceId) ? current : [targetWorkspaceId, ...current].slice(0, 24)
    );
  }

  function toggleWorkspaceExpansion(targetWorkspaceId: string) {
    if (!targetWorkspaceId.trim()) {
      return;
    }

    params.navigation.setExpandedWorkspaceIds((current) =>
      current.includes(targetWorkspaceId)
        ? current.filter((entry) => entry !== targetWorkspaceId)
        : [targetWorkspaceId, ...current].slice(0, 24)
    );
  }

  function clearSessionSelection(sessionToClearId?: string, options?: { forgetSession?: boolean }) {
    const targetId = sessionToClearId ?? params.navigation.sessionId;
    params.runtime.lastCursorRef.current = undefined;
    params.runtime.streamAbortRef.current?.abort();
    window.clearTimeout(params.runtime.runPollingTimerRef.current);
    params.runtime.setStreamState("idle");
    params.navigation.setSessionId("");
    params.navigation.setSession(null);
    params.runtime.setMessages([]);
    params.runtime.setEvents([]);
    params.runtime.setSelectedRunId("");
    params.runtime.setRun(null);
    params.runtime.setRunSteps([]);
    params.runtime.setLiveOutput({});

    if (targetId && options?.forgetSession) {
      params.navigation.setSavedSessions((current) => current.filter((entry) => entry.id !== targetId));
      params.navigation.setRecentSessions((current) => current.filter((entry) => entry !== targetId));
    }
  }

  function clearWorkspaceSelection(workspaceToClearId?: string) {
    const targetId = workspaceToClearId ?? params.navigation.workspaceId;
    clearSessionSelection();
    params.navigation.setWorkspaceId("");
    params.navigation.setWorkspace(null);
    params.navigation.setCatalog(null);
    params.navigation.setMirrorStatus(null);

    if (targetId) {
      params.navigation.setSavedWorkspaces((current) => current.filter((entry) => entry.id !== targetId));
      params.navigation.setRecentWorkspaces((current) => current.filter((entry) => entry !== targetId));
      params.navigation.setSavedSessions((current) => current.filter((entry) => entry.workspaceId !== targetId));
      params.navigation.setRecentSessions((current) =>
        current.filter(
          (entryId) => !params.navigation.savedSessions.some((entry) => entry.id === entryId && entry.workspaceId === targetId)
        )
      );
      params.navigation.setExpandedWorkspaceIds((current) => current.filter((entry) => entry !== targetId));
    }
  }

  function forgetWorkspace(workspaceToRemoveId: string) {
    if (params.navigation.workspaceId === workspaceToRemoveId) {
      clearWorkspaceSelection(workspaceToRemoveId);
      return;
    }

    params.navigation.setSavedWorkspaces((current) => current.filter((entry) => entry.id !== workspaceToRemoveId));
    params.navigation.setSavedSessions((current) => current.filter((entry) => entry.workspaceId !== workspaceToRemoveId));
    params.navigation.setRecentWorkspaces((current) => current.filter((entry) => entry !== workspaceToRemoveId));
    params.navigation.setRecentSessions((current) =>
      current.filter(
        (entryId) =>
          !params.navigation.savedSessions.some((entry) => entry.id === entryId && entry.workspaceId === workspaceToRemoveId)
      )
    );
    params.navigation.setExpandedWorkspaceIds((current) => current.filter((entry) => entry !== workspaceToRemoveId));
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
        params.setActivity(`Workspace ${workspaceToRemoveId} 已从列表清理`);
        params.setErrorMessage("");
        return;
      }

      params.setErrorMessage(toErrorMessage(error));
    }
  }

  async function removeSavedSession(sessionToRemoveId: string) {
    const sessionIdsToRemove = collectSessionTreeIds(sessionToRemoveId, params.navigation.savedSessions);
    const sessionIdsToRemoveSet = new Set(sessionIdsToRemove);

    try {
      await params.request<void>(`/api/v1/sessions/${sessionToRemoveId}`, { method: "DELETE" });
    } catch (error) {
      if (!isNotFoundError(error)) {
        params.setErrorMessage(toErrorMessage(error));
        return;
      }
    }

    params.navigation.setSavedSessions((current) => current.filter((entry) => !sessionIdsToRemoveSet.has(entry.id)));
    params.navigation.setRecentSessions((current) => current.filter((entry) => !sessionIdsToRemoveSet.has(entry)));
    params.navigation.setExpandedSessionIds((current) => current.filter((entry) => !sessionIdsToRemoveSet.has(entry)));

    if (params.navigation.sessionId && sessionIdsToRemoveSet.has(params.navigation.sessionId)) {
      clearSessionSelection();
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

  async function refreshWorkspaceTemplates(quiet = false) {
    try {
      const response = await params.request<WorkspaceTemplateList>("/api/v1/workspace-templates");
      startTransition(() => {
        params.navigation.setWorkspaceManagementEnabled(true);
        params.navigation.setWorkspaceTemplates(response.items.map((item) => item.name));
      });
      if (!quiet) {
        params.setActivity(`已加载 ${response.items.length} 个模板`);
        params.setErrorMessage("");
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("workspace_templates_unavailable") ||
          error.message.toLowerCase().includes("workspace templates are not available"))
      ) {
        startTransition(() => {
          params.navigation.setWorkspaceManagementEnabled(false);
          params.navigation.setWorkspaceTemplates([]);
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

  async function refreshWorkspaceIndex(quiet = false) {
    try {
      const response = await params.request<{ items: Workspace[]; nextCursor?: string }>("/api/v1/workspaces?pageSize=200");
      const visibleWorkspaceIds = new Set(response.items.map((item) => item.id));
      const existingSessionById = new Map(params.navigation.savedSessions.map((entry) => [entry.id, entry]));
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
        params.navigation.setSavedWorkspaces((current) => {
          const currentById = new Map(current.map((entry) => [entry.id, entry]));
          return response.items.map((item) => {
            const existing = currentById.get(item.id);
            return {
              id: item.id,
              name: item.name,
              rootPath: item.rootPath,
              status: item.status,
              createdAt: item.createdAt,
              lastOpenedAt: existing?.lastOpenedAt ?? item.updatedAt,
              ...(item.template ? { template: item.template } : existing?.template ? { template: existing.template } : {})
            } satisfies SavedWorkspaceRecord;
          });
        });
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

          return next;
        });
        params.navigation.setRecentWorkspaces((current) => current.filter((entry) => visibleWorkspaceIds.has(entry)));
        params.navigation.setRecentSessions((current) =>
          current.filter((entry) => {
            const sessionRecord = syncedSessions.get(entry);
            return Boolean(sessionRecord && visibleWorkspaceIds.has(sessionRecord.workspaceId));
          })
        );
        params.navigation.setExpandedWorkspaceIds((current) => current.filter((entry) => visibleWorkspaceIds.has(entry)));
      });

      if (response.items.length === 1) {
        const onlyWorkspace = response.items[0]!;
        if (!params.navigation.sessionId.trim() && params.navigation.workspaceId !== onlyWorkspace.id) {
          expandWorkspaceInSidebar(onlyWorkspace.id);
          void refreshWorkspace(onlyWorkspace.id, true);
        }
      } else if (
        params.navigation.workspaceId.trim() &&
        !response.items.some((item) => item.id === params.navigation.workspaceId)
      ) {
        clearWorkspaceSelection(params.navigation.workspaceId);
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
      const [catalogResponse, mirrorStatusResponse] = await Promise.allSettled([
        params.request<WorkspaceCatalog>(`/api/v1/workspaces/${targetId}/catalog`),
        params.request<WorkspaceHistoryMirrorStatus>(`/api/v1/workspaces/${targetId}/history-mirror`)
      ]);
      const refreshWarnings = [catalogResponse, mirrorStatusResponse]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => toErrorMessage(result.reason));

      startTransition(() => {
        params.navigation.setWorkspace(workspaceResponse);
        params.navigation.setCatalog(catalogResponse.status === "fulfilled" ? catalogResponse.value : null);
        params.navigation.setMirrorStatus(mirrorStatusResponse.status === "fulfilled" ? mirrorStatusResponse.value : null);
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
      params.navigation.setMirrorStatus(null);
      if (isNotFoundError(error)) {
        clearWorkspaceSelection(targetId);
      }
      if (!quiet) {
        params.setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function createWorkspace() {
    try {
      const created = await params.request<Workspace>("/api/v1/workspaces", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          name: params.navigation.workspaceDraft.name.trim(),
          template: params.navigation.workspaceDraft.template.trim(),
          ...(params.navigation.workspaceDraft.rootPath.trim() ? { rootPath: params.navigation.workspaceDraft.rootPath.trim() } : {}),
          executionPolicy: "local"
        })
      });

      startTransition(() => {
        params.navigation.setWorkspaceId(created.id);
        params.runtime.setSelectedRunId("");
        params.runtime.setRun(null);
        params.runtime.setRunSteps([]);
        params.navigation.setSession(null);
        params.navigation.setSessionId("");
        params.runtime.setMessages([]);
        params.runtime.setEvents([]);
        params.navigation.setWorkspace(created);
        params.navigation.setRecentWorkspaces((current) => addRecentId(current, created.id));
      });
      rememberWorkspace(created, {
        template: params.navigation.workspaceDraft.template.trim()
      });
      params.runtime.lastCursorRef.current = undefined;
      params.navigation.setWorkspaceDraft((current) => ({
        ...current,
        template: ""
      }));
      params.navigation.setShowWorkspaceCreator(false);
      expandWorkspaceInSidebar(created.id);
      await refreshWorkspace(created.id, true);
      await refreshWorkspaceIndex(true);
      const folderName = pathLeaf(created.rootPath);
      params.setActivity(
        folderName
          ? `Workspace ${created.name} 已创建 · ${created.id} · dir ${folderName}`
          : `Workspace ${created.name} 已创建 · ${created.id}`
      );
      params.setErrorMessage("");
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
    }
  }

  async function rebuildWorkspaceHistoryMirror() {
    if (!params.navigation.workspaceId.trim() || !params.navigation.workspace) {
      params.setErrorMessage("请先加载 workspace。");
      return;
    }

    try {
      params.navigation.setMirrorRebuildBusy(true);
      const nextMirrorStatus = await params.request<WorkspaceHistoryMirrorStatus>(
        `/api/v1/workspaces/${params.navigation.workspaceId}/history-mirror/rebuild`,
        {
          method: "POST"
        }
      );
      startTransition(() => {
        params.navigation.setMirrorStatus(nextMirrorStatus);
      });
      params.setActivity("Mirror sync 已重建");
      params.setErrorMessage("");
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
    } finally {
      params.navigation.setMirrorRebuildBusy(false);
    }
  }

  async function refreshSession(targetId = params.navigation.sessionId, quiet = false) {
    const nextSessionId = targetId.trim();
    if (!nextSessionId) {
      return;
    }

    const switchingSession = nextSessionId !== params.navigation.sessionId;

    if (switchingSession) {
      params.runtime.streamAbortRef.current?.abort();
      params.runtime.lastCursorRef.current = undefined;
      window.clearTimeout(params.runtime.runPollingTimerRef.current);
      startTransition(() => {
        params.runtime.setStreamState("idle");
        params.navigation.setSessionId(nextSessionId);
        params.navigation.setSession(null);
        params.runtime.setMessages([]);
        params.runtime.setEvents([]);
        params.runtime.setSelectedRunId("");
        params.runtime.setRun(null);
        params.runtime.setRunSteps([]);
        params.runtime.setLiveOutput({});
      });
    }

    try {
      const [sessionResponse, messagePage] = await Promise.all([
        params.request<Session>(`/api/v1/sessions/${nextSessionId}`),
        params.request<{ items: Message[] }>(`/api/v1/sessions/${nextSessionId}/messages?pageSize=200`)
      ]);
      const nextWorkspaceId = sessionResponse.workspaceId;
      const workspaceChanged = params.navigation.workspace?.id !== nextWorkspaceId;

      startTransition(() => {
        params.navigation.setSession(sessionResponse);
        params.navigation.setSessionId(nextSessionId);
        params.navigation.setWorkspaceId(nextWorkspaceId);
        params.runtime.setMessages(messagePage.items);
        params.navigation.setRecentSessions((current) => addRecentId(current, nextSessionId));
        if (workspaceChanged) {
          params.navigation.setWorkspace(null);
          params.navigation.setCatalog(null);
          params.navigation.setMirrorStatus(null);
        }
      });
      expandWorkspaceInSidebar(nextWorkspaceId);
      touchSavedWorkspace(nextWorkspaceId);
      rememberSession(sessionResponse);
      void refreshWorkspace(nextWorkspaceId, true);
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

    try {
      const created = await params.request<Session>(`/api/v1/workspaces/${params.navigation.workspaceId}/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({})
      });

      params.runtime.lastCursorRef.current = undefined;
      startTransition(() => {
        params.runtime.setEvents([]);
        params.runtime.setSelectedRunId("");
        params.runtime.setRun(null);
        params.runtime.setRunSteps([]);
        params.runtime.setLiveOutput({});
      });
      await refreshSession(created.id, true);
      rememberSession(created);
      params.setActivity(`Session ${created.id} 已创建`);
      params.setErrorMessage("");
    } catch (error) {
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
    removeSavedSession,
    renameSession,
    switchSessionAgent,
    updateSessionModel,
    clearSessionSelection,
    clearWorkspaceSelection,
    openWorkspace,
    refreshWorkspaceTemplates,
    refreshWorkspaceIndex,
    refreshWorkspace,
    createWorkspace,
    rebuildWorkspaceHistoryMirror,
    refreshSession,
    createSession
  };
}
