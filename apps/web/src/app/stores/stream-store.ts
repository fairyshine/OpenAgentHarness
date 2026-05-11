import type { Dispatch, SetStateAction } from "react";

import { create } from "zustand";

import type { Message, ModelGenerateResponse, Run, RunStep, SessionEventContract } from "@oah/api-contracts";

import type { LiveConversationMessageRecord } from "../support";
import type { DraftImageAttachment } from "../chat/composer-content";

export type StreamStatus = "idle" | "connecting" | "listening" | "open" | "error";

type StreamState = {
  messages: Message[];
  events: SessionEventContract[];
  selectedRunId: string;
  sessionRuns: Run[];
  run: Run | null;
  runSteps: RunStep[];
  draftMessage: string;
  draftAttachments: DraftImageAttachment[];
  liveMessagesByKey: Record<string, LiveConversationMessageRecord>;
  streamState: StreamStatus;
  generateOutput: ModelGenerateResponse | null;
  generateBusy: boolean;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setEvents: Dispatch<SetStateAction<SessionEventContract[]>>;
  setSelectedRunId: Dispatch<SetStateAction<string>>;
  setSessionRuns: Dispatch<SetStateAction<Run[]>>;
  setRun: Dispatch<SetStateAction<Run | null>>;
  setRunSteps: Dispatch<SetStateAction<RunStep[]>>;
  setDraftMessage: Dispatch<SetStateAction<string>>;
  setDraftAttachments: Dispatch<SetStateAction<DraftImageAttachment[]>>;
  setLiveMessagesByKey: Dispatch<SetStateAction<Record<string, LiveConversationMessageRecord>>>;
  setStreamState: Dispatch<SetStateAction<StreamStatus>>;
  setGenerateOutput: Dispatch<SetStateAction<ModelGenerateResponse | null>>;
  setGenerateBusy: Dispatch<SetStateAction<boolean>>;
};

const DRAFT_MESSAGE_STORAGE_KEY = "oah.web.draftMessage";

function resolve<T>(updater: SetStateAction<T>, current: T): T {
  return typeof updater === "function" ? (updater as (prev: T) => T)(current) : updater;
}

function readStoredDraftMessage() {
  if (typeof window === "undefined") {
    return "";
  }

  try {
    return window.sessionStorage.getItem(DRAFT_MESSAGE_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeStoredDraftMessage(value: string) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (value.length === 0) {
      window.sessionStorage.removeItem(DRAFT_MESSAGE_STORAGE_KEY);
      return;
    }

    window.sessionStorage.setItem(DRAFT_MESSAGE_STORAGE_KEY, value);
  } catch {
    // Safari private windows and storage quota errors should not break typing.
  }
}

export const useStreamStore = create<StreamState>((set, get) => ({
  messages: [],
  events: [],
  selectedRunId: "",
  sessionRuns: [],
  run: null,
  runSteps: [],
  draftMessage: readStoredDraftMessage(),
  draftAttachments: [],
  liveMessagesByKey: {},
  streamState: "idle",
  generateOutput: null,
  generateBusy: false,
  setMessages: (updater) => set({ messages: resolve(updater, get().messages) }),
  setEvents: (updater) => set({ events: resolve(updater, get().events) }),
  setSelectedRunId: (updater) => set({ selectedRunId: resolve(updater, get().selectedRunId) }),
  setSessionRuns: (updater) => set({ sessionRuns: resolve(updater, get().sessionRuns) }),
  setRun: (updater) => set({ run: resolve(updater, get().run) }),
  setRunSteps: (updater) => set({ runSteps: resolve(updater, get().runSteps) }),
  setDraftMessage: (updater) => {
    const draftMessage = resolve(updater, get().draftMessage);
    writeStoredDraftMessage(draftMessage);
    set({ draftMessage });
  },
  setDraftAttachments: (updater) => set({ draftAttachments: resolve(updater, get().draftAttachments) }),
  setLiveMessagesByKey: (updater) => set({ liveMessagesByKey: resolve(updater, get().liveMessagesByKey) }),
  setStreamState: (updater) => set({ streamState: resolve(updater, get().streamState) }),
  setGenerateOutput: (updater) => set({ generateOutput: resolve(updater, get().generateOutput) }),
  setGenerateBusy: (updater) => set({ generateBusy: resolve(updater, get().generateBusy) })
}));
