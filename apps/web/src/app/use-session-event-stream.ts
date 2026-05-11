import { useEffect, type MutableRefObject } from "react";

import {
  buildUrl,
  consumeSse,
  isNotFoundError,
  type ConnectionSettings,
  type SseFrame
} from "./support";

function useSessionEventStream(params: {
  connection: ConnectionSettings;
  sessionId: string;
  sessionRecordId?: string;
  enabled?: boolean;
  streamRevision: number;
  streamAbortRef: MutableRefObject<AbortController | null>;
  lastCursorRef: MutableRefObject<string | undefined>;
  setStreamState: (value: "idle" | "connecting" | "listening" | "open" | "error" | ((current: "idle" | "connecting" | "listening" | "open" | "error") => "idle" | "connecting" | "listening" | "open" | "error")) => void;
  onFrame: (frame: SseFrame) => void;
  onMissingSession: () => void;
  reportError: (error: unknown) => void;
  openConsoleForErrors: () => void;
}) {
  useEffect(() => {
    if (params.enabled === false || !params.sessionId.trim() || params.sessionRecordId !== params.sessionId) {
      params.streamAbortRef.current?.abort();
      params.setStreamState("idle");
      return;
    }

    const controller = new AbortController();
    params.streamAbortRef.current?.abort();
    params.streamAbortRef.current = controller;
    params.setStreamState("connecting");
    const listeningTimer = window.setTimeout(() => {
      if (!controller.signal.aborted) {
        params.setStreamState((current) => (current === "connecting" ? "listening" : current));
      }
    }, 1200);

    const query = new URLSearchParams();
    if (params.lastCursorRef.current) {
      query.set("cursor", params.lastCursorRef.current);
    }

    void (async () => {
      try {
        const headers = new Headers();
        const token = params.connection.token.trim();
        if (token) {
          headers.set("authorization", `Bearer ${token}`);
        }
        const response = await fetch(
          buildUrl(params.connection.baseUrl, `/api/v1/sessions/${params.sessionId}/events${query.size > 0 ? `?${query.toString()}` : ""}`),
          {
            signal: controller.signal,
            headers
          }
        );

        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }

        params.setStreamState("open");
        await consumeSse(response, params.onFrame, controller.signal);
        if (!controller.signal.aborted) {
          params.setStreamState("idle");
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          if (isNotFoundError(error)) {
            params.onMissingSession();
            return;
          }
          params.setStreamState("error");
          params.reportError(error);
          params.openConsoleForErrors();
        }
      }
    })();

    return () => {
      window.clearTimeout(listeningTimer);
      controller.abort();
    };
  }, [
    params.connection.baseUrl,
    params.connection.token,
    params.enabled,
    params.sessionRecordId,
    params.sessionId,
    params.streamRevision
  ]);
}

export { useSessionEventStream };
