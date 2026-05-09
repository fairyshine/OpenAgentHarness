import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";

import type { Session } from "@oah/api-contracts";

type SessionMutationRef = {
  sessionId: string;
  promise: Promise<boolean>;
};

function useSessionSettingsActions(input: {
  sessionId: string;
  session: Session | null;
  refreshSessionRuns: (quiet?: boolean, options?: { includeSteps?: boolean }) => Promise<void>;
  refreshSessionById: (targetId: string, quiet?: boolean) => Promise<unknown>;
  switchSessionAgentById: (targetId: string, activeAgentName: string) => Promise<Session | null>;
  updateSessionModelById: (targetId: string, modelRef: string | null) => Promise<Session | null>;
  setSession: Dispatch<SetStateAction<Session | null>>;
  setPendingSessionAgentName: (value: string | null) => void;
  setSwitchingSessionAgentId: (value: string | null) => void;
  setPendingSessionModelRef: (value: string | null) => void;
  setSwitchingSessionModelId: (value: string | null) => void;
}) {
  const sessionAgentSwitchRef = useRef<SessionMutationRef | null>(null);
  const sessionAgentSwitchSeqRef = useRef(0);
  const sessionModelUpdateRef = useRef<SessionMutationRef | null>(null);
  const sessionModelUpdateSeqRef = useRef(0);

  useEffect(() => {
    input.setPendingSessionAgentName(null);
    input.setSwitchingSessionAgentId(null);
    sessionAgentSwitchRef.current = null;
    input.setPendingSessionModelRef(null);
    input.setSwitchingSessionModelId(null);
    sessionModelUpdateRef.current = null;
  }, [input.session?.id]);

  async function switchSessionAgent(targetId: string, activeAgentName: string) {
    const nextAgentName = activeAgentName.trim();
    if (!targetId.trim() || !nextAgentName) {
      return false;
    }

    const currentSession = input.session?.id === targetId ? input.session : null;
    const switchSeq = sessionAgentSwitchSeqRef.current + 1;
    sessionAgentSwitchSeqRef.current = switchSeq;
    input.setSwitchingSessionAgentId(targetId);
    if (currentSession) {
      input.setPendingSessionAgentName(nextAgentName);
      input.setSession({
        ...currentSession,
        activeAgentName: nextAgentName,
        updatedAt: new Date().toISOString()
      });
    }

    const switchPromise = input.switchSessionAgentById(targetId, nextAgentName).then((updated) => updated !== null);
    sessionAgentSwitchRef.current = {
      sessionId: targetId,
      promise: switchPromise
    };

    try {
      const switched = await switchPromise;
      if (!switched) {
        if (currentSession) {
          input.setSession(currentSession);
        }
        return false;
      }

      if (input.sessionId === targetId) {
        await input.refreshSessionById(targetId, true);
        await input.refreshSessionRuns(true, { includeSteps: true });
      }

      return true;
    } finally {
      if (sessionAgentSwitchSeqRef.current === switchSeq) {
        sessionAgentSwitchRef.current = null;
        input.setSwitchingSessionAgentId(null);
        input.setPendingSessionAgentName(null);
      }
    }
  }

  async function updateSessionModel(targetId: string, modelRef: string | null) {
    if (!targetId.trim()) {
      return false;
    }

    const currentSession = input.session?.id === targetId ? input.session : null;
    const normalizedModelRef = modelRef?.trim() ? modelRef.trim() : null;
    const updateSeq = sessionModelUpdateSeqRef.current + 1;
    sessionModelUpdateSeqRef.current = updateSeq;
    input.setSwitchingSessionModelId(targetId);
    input.setPendingSessionModelRef(normalizedModelRef);
    if (currentSession) {
      input.setSession({
        ...currentSession,
        ...(normalizedModelRef ? { modelRef: normalizedModelRef } : {}),
        ...(normalizedModelRef === null ? { modelRef: undefined } : {}),
        updatedAt: new Date().toISOString()
      });
    }

    const updatePromise = input.updateSessionModelById(targetId, normalizedModelRef).then((updated) => updated !== null);
    sessionModelUpdateRef.current = {
      sessionId: targetId,
      promise: updatePromise
    };

    try {
      const updated = await updatePromise;
      if (!updated) {
        if (currentSession) {
          input.setSession(currentSession);
        }
        return false;
      }

      if (input.sessionId === targetId) {
        await input.refreshSessionById(targetId, true);
      }

      return true;
    } finally {
      if (sessionModelUpdateSeqRef.current === updateSeq) {
        sessionModelUpdateRef.current = null;
        input.setSwitchingSessionModelId(null);
        input.setPendingSessionModelRef(null);
      }
    }
  }

  return {
    sessionAgentSwitchRef,
    sessionModelUpdateRef,
    switchSessionAgent,
    updateSessionModel
  };
}

export { useSessionSettingsActions };
