import type { Dispatch, SetStateAction } from "react";

import { create } from "zustand";

import type { Message, ModelGenerateResponse, Run, RunStep, SessionEventContract } from "@oah/api-contracts";

import type { LiveConversationMessageRecord } from "../support";

export type StreamStatus = "idle" | "connecting" | "listening" | "open" | "error";

type StreamState = {
  messages: Message[];
  events: SessionEventContract[];
  selectedRunId: string;
  sessionRuns: Run[];
  run: Run | null;
  runSteps: RunStep[];
  draftMessage: string;
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
  setLiveMessagesByKey: Dispatch<SetStateAction<Record<string, LiveConversationMessageRecord>>>;
  setStreamState: Dispatch<SetStateAction<StreamStatus>>;
  setGenerateOutput: Dispatch<SetStateAction<ModelGenerateResponse | null>>;
  setGenerateBusy: Dispatch<SetStateAction<boolean>>;
};

function resolve<T>(updater: SetStateAction<T>, current: T): T {
  return typeof updater === "function" ? (updater as (prev: T) => T)(current) : updater;
}

export const useStreamStore = create<StreamState>((set, get) => ({
  messages: [],
  events: [],
  selectedRunId: "",
  sessionRuns: [],
  run: null,
  runSteps: [],
  draftMessage: "",
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
  setDraftMessage: (updater) => set({ draftMessage: resolve(updater, get().draftMessage) }),
  setLiveMessagesByKey: (updater) => set({ liveMessagesByKey: resolve(updater, get().liveMessagesByKey) }),
  setStreamState: (updater) => set({ streamState: resolve(updater, get().streamState) }),
  setGenerateOutput: (updater) => set({ generateOutput: resolve(updater, get().generateOutput) }),
  setGenerateBusy: (updater) => set({ generateBusy: resolve(updater, get().generateBusy) })
}));
