import { startTransition, type Dispatch, type SetStateAction } from "react";

import type {
  ActionRunAccepted,
  ModelGenerateResponse,
  Run,
  RunStep,
  Session,
  SessionTerminalInputAccepted,
  SessionTerminalSnapshot
} from "@oah/api-contracts";

import type { ModelDraft } from "./support";
import { isPendingSessionId } from "./app-controller-utils";

export function useSessionUtilityActions(input: {
  sessionId: string;
  session: Session | null;
  modelDraft: ModelDraft;
  request: <T>(path: string, init?: RequestInit, options?: { auth?: boolean }) => Promise<T>;
  refreshSessionById: (targetId: string, quiet?: boolean) => Promise<unknown>;
  refreshSessionRuns: (quiet?: boolean, options?: { includeSteps?: boolean | "selected" }) => Promise<void>;
  refreshRun: (targetId?: string, quiet?: boolean) => Promise<void>;
  refreshRunSteps: (targetId?: string, quiet?: boolean) => Promise<void>;
  setActivity: (value: string) => void;
  clearActiveError: () => void;
  reportError: (error: unknown) => void;
  openConsoleForErrors: () => void;
  setSelectedRunId: Dispatch<SetStateAction<string>>;
  setGenerateOutput: Dispatch<SetStateAction<ModelGenerateResponse | null>>;
  setGenerateBusy: Dispatch<SetStateAction<boolean>>;
}) {
  async function refreshSessionTerminal(
    targetSessionId: string,
    terminalId: string
  ): Promise<SessionTerminalSnapshot | null> {
    const normalizedSessionId = targetSessionId.trim();
    const normalizedTerminalId = terminalId.trim();
    if (!normalizedSessionId || isPendingSessionId(normalizedSessionId) || !normalizedTerminalId) {
      return null;
    }

    return input.request<SessionTerminalSnapshot>(
      `/api/v1/sessions/${normalizedSessionId}/terminals/${encodeURIComponent(normalizedTerminalId)}?maxBytes=262144`
    );
  }

  async function sendSessionTerminalInput(params: {
    sessionId: string;
    terminalId: string;
    input: string;
    appendNewline?: boolean | undefined;
  }): Promise<SessionTerminalInputAccepted | null> {
    const normalizedSessionId = params.sessionId.trim();
    const normalizedTerminalId = params.terminalId.trim();
    if (!normalizedSessionId || isPendingSessionId(normalizedSessionId) || !normalizedTerminalId) {
      return null;
    }

    return input.request<SessionTerminalInputAccepted>(
      `/api/v1/sessions/${normalizedSessionId}/terminals/${encodeURIComponent(normalizedTerminalId)}/input`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: params.input,
          appendNewline: params.appendNewline ?? true
        })
      }
    );
  }

  async function triggerWorkspaceAction(params: {
    workspaceId: string;
    actionName: string;
    input?: unknown;
  }): Promise<boolean> {
    const targetWorkspaceId = params.workspaceId.trim();
    const targetActionName = params.actionName.trim();
    if (!targetWorkspaceId || !targetActionName) {
      return false;
    }

    try {
      const attachedSessionId =
        input.session?.workspaceId === targetWorkspaceId &&
        input.session.id.trim().length > 0 &&
        !isPendingSessionId(input.session.id)
          ? input.session.id
          : undefined;
      const accepted = await input.request<ActionRunAccepted>(
        `/api/v1/workspaces/${targetWorkspaceId}/actions/${encodeURIComponent(targetActionName)}/runs`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            ...(attachedSessionId ? { sessionId: attachedSessionId } : {}),
            ...(params.input !== undefined ? { input: params.input } : {}),
            triggerSource: "user"
          })
        }
      );

      if (accepted.sessionId && accepted.sessionId !== input.sessionId) {
        await input.refreshSessionById(accepted.sessionId, true);
      } else if (accepted.sessionId) {
        await input.refreshSessionRuns(true, { includeSteps: "selected" });
      }

      startTransition(() => {
        input.setSelectedRunId(accepted.runId);
      });
      await Promise.all([input.refreshRun(accepted.runId, true), input.refreshRunSteps(accepted.runId, true)]);
      input.setActivity(`Action 已入队，run=${accepted.runId}`);
      input.clearActiveError();
      return true;
    } catch (error) {
      input.reportError(error);
      return false;
    }
  }

  async function generateOnce() {
    try {
      input.setGenerateBusy(true);
      const response = await input.request<ModelGenerateResponse>(
        "/internal/v1/models/generate",
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            prompt: input.modelDraft.prompt.trim(),
            ...(input.modelDraft.model.trim() ? { model: input.modelDraft.model.trim() } : {})
          })
        }
      );
      input.setGenerateOutput(response);
      input.setActivity(`内部模型运行时 generate 成功，model=${response.model}`);
      input.clearActiveError();
    } catch (error) {
      input.reportError(error);
      input.openConsoleForErrors();
    } finally {
      input.setGenerateBusy(false);
    }
  }

  return {
    refreshSessionTerminal,
    sendSessionTerminalInput,
    triggerWorkspaceAction,
    generateOnce
  };
}
