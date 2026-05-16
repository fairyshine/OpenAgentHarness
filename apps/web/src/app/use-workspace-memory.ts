import { useCallback, useEffect, useRef, useState } from "react";

import type {
  Workspace,
  WorkspaceMemoryCorpus,
  WorkspaceMemoryIndex,
  WorkspaceMemoryProposalActionResult,
  WorkspaceMemoryProposalPage,
  WorkspaceMemoryReadResponse,
  WorkspaceMemorySearchResponse,
  WorkspaceMemoryStatus
} from "@oah/api-contracts";

import { toErrorMessage, type ConnectionSettings } from "./support";

type AppRequest = <T>(path: string, init?: RequestInit, options?: { auth?: boolean }) => Promise<T>;

export interface WorkspaceMemoryParams {
  connection: ConnectionSettings;
  request: AppRequest;
  workspaceId: string;
  workspace: Workspace | null;
  enabled: boolean;
  setActivity: (value: string) => void;
  setErrorMessage: (value: string) => void;
}

export function useWorkspaceMemory(params: WorkspaceMemoryParams) {
  const [status, setStatus] = useState<WorkspaceMemoryStatus | null>(null);
  const [index, setIndex] = useState<WorkspaceMemoryIndex | null>(null);
  const [proposals, setProposals] = useState<WorkspaceMemoryProposalPage | null>(null);
  const [selectedMemory, setSelectedMemory] = useState<WorkspaceMemoryReadResponse | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCorpus, setSearchCorpus] = useState<WorkspaceMemoryCorpus>("all");
  const [searchResults, setSearchResults] = useState<WorkspaceMemorySearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [searchBusy, setSearchBusy] = useState(false);
  const [readBusy, setReadBusy] = useState(false);
  const [proposalBusyPath, setProposalBusyPath] = useState("");
  const refreshSeqRef = useRef(0);
  const searchSeqRef = useRef(0);
  const readSeqRef = useRef(0);
  const workspaceId = params.workspaceId.trim();
  const canLoad = params.enabled && workspaceId.length > 0 && Boolean(params.workspace);

  const reset = useCallback(() => {
    setStatus(null);
    setIndex(null);
    setProposals(null);
    setSelectedMemory(null);
    setSearchResults(null);
    setBusy(false);
    setSearchBusy(false);
    setReadBusy(false);
    setProposalBusyPath("");
  }, []);

  const buildWorkspaceMemoryPath = useCallback(
    (suffix: string) => `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/memory${suffix}`,
    [workspaceId]
  );

  const refreshMemory = useCallback(async () => {
    if (!canLoad) {
      reset();
      return;
    }

    const seq = ++refreshSeqRef.current;
    setBusy(true);
    try {
      const [nextStatus, nextIndex, nextProposals] = await Promise.all([
        params.request<WorkspaceMemoryStatus>(buildWorkspaceMemoryPath("/status")),
        params.request<WorkspaceMemoryIndex>(buildWorkspaceMemoryPath("")),
        params.request<WorkspaceMemoryProposalPage>(buildWorkspaceMemoryPath("/proposals"))
      ]);
      if (seq !== refreshSeqRef.current) {
        return;
      }

      setStatus(nextStatus);
      setIndex(nextIndex);
      setProposals(nextProposals);
      params.setActivity(`Loaded workspace memory for ${workspaceId}`);
    } catch (error) {
      if (seq === refreshSeqRef.current) {
        params.setErrorMessage(toErrorMessage(error));
      }
    } finally {
      if (seq === refreshSeqRef.current) {
        setBusy(false);
      }
    }
  }, [buildWorkspaceMemoryPath, canLoad, params, reset, workspaceId]);

  const searchMemory = useCallback(async (queryOverride?: string, corpusOverride?: WorkspaceMemoryCorpus) => {
    if (!canLoad) {
      reset();
      return;
    }

    const query = (queryOverride ?? searchQuery).trim();
    const corpus = corpusOverride ?? searchCorpus;
    if (!query) {
      setSearchResults(null);
      return;
    }

    const seq = ++searchSeqRef.current;
    setSearchBusy(true);
    try {
      const searchParams = new URLSearchParams({
        query,
        corpus,
        maxResults: "12"
      });
      const response = await params.request<WorkspaceMemorySearchResponse>(buildWorkspaceMemoryPath(`/search?${searchParams.toString()}`));
      if (seq !== searchSeqRef.current) {
        return;
      }

      setSearchResults(response);
    } catch (error) {
      if (seq === searchSeqRef.current) {
        params.setErrorMessage(toErrorMessage(error));
      }
    } finally {
      if (seq === searchSeqRef.current) {
        setSearchBusy(false);
      }
    }
  }, [buildWorkspaceMemoryPath, canLoad, params, reset, searchCorpus, searchQuery]);

  const readMemory = useCallback(async (path: string) => {
    if (!canLoad || !path.trim()) {
      return;
    }

    const seq = ++readSeqRef.current;
    setReadBusy(true);
    try {
      const readParams = new URLSearchParams({
        path: path.trim(),
        from: "1",
        lines: "220"
      });
      const response = await params.request<WorkspaceMemoryReadResponse>(buildWorkspaceMemoryPath(`/read?${readParams.toString()}`));
      if (seq !== readSeqRef.current) {
        return;
      }

      setSelectedMemory(response);
    } catch (error) {
      if (seq === readSeqRef.current) {
        params.setErrorMessage(toErrorMessage(error));
      }
    } finally {
      if (seq === readSeqRef.current) {
        setReadBusy(false);
      }
    }
  }, [buildWorkspaceMemoryPath, canLoad, params]);

  const applyProposal = useCallback(async (path: string): Promise<WorkspaceMemoryProposalActionResult | null> => {
    if (!canLoad || !path.trim()) {
      return null;
    }

    setProposalBusyPath(path);
    try {
      const response = await params.request<WorkspaceMemoryProposalActionResult>(buildWorkspaceMemoryPath("/proposals/apply"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path })
      });
      params.setActivity(`Applied memory proposal ${path}`);
      await refreshMemory();
      return response;
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
      return null;
    } finally {
      setProposalBusyPath("");
    }
  }, [buildWorkspaceMemoryPath, canLoad, params, refreshMemory]);

  const rejectProposal = useCallback(async (path: string, reason?: string): Promise<WorkspaceMemoryProposalActionResult | null> => {
    if (!canLoad || !path.trim()) {
      return null;
    }

    setProposalBusyPath(path);
    try {
      const response = await params.request<WorkspaceMemoryProposalActionResult>(buildWorkspaceMemoryPath("/proposals/reject"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, ...(reason?.trim() ? { reason: reason.trim() } : {}) })
      });
      params.setActivity(`Rejected memory proposal ${path}`);
      await refreshMemory();
      return response;
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
      return null;
    } finally {
      setProposalBusyPath("");
    }
  }, [buildWorkspaceMemoryPath, canLoad, params, refreshMemory]);

  useEffect(() => {
    if (!canLoad) {
      reset();
      return;
    }

    void refreshMemory();
  }, [canLoad, refreshMemory, reset]);

  useEffect(() => {
    setSelectedMemory(null);
    setSearchResults(null);
  }, [workspaceId]);

  return {
    status,
    index,
    proposals,
    selectedMemory,
    searchQuery,
    searchCorpus,
    searchResults,
    busy,
    searchBusy,
    readBusy,
    proposalBusyPath,
    setSearchQuery,
    setSearchCorpus,
    refreshMemory,
    searchMemory,
    readMemory,
    applyProposal,
    rejectProposal
  };
}

export type WorkspaceMemoryController = ReturnType<typeof useWorkspaceMemory>;
