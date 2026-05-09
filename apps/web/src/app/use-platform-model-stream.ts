import { useEffect, useRef } from "react";

import {
  buildUrl,
  consumeSse,
  isNotFoundError,
  type ConnectionSettings,
  type PlatformModelRecord,
  type PlatformModelSnapshotResponse
} from "./support";

function usePlatformModelStream(params: {
  connection: ConnectionSettings;
  onSnapshot: (snapshot: PlatformModelSnapshotResponse, replace?: boolean) => void;
}) {
  const abortRef = useRef<AbortController | null>(null);
  const reconnectTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    abortRef.current?.abort();
    window.clearTimeout(reconnectTimerRef.current);

    let cancelled = false;

    const connect = () => {
      if (cancelled) {
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;

      void (async () => {
        try {
          const headers = new Headers();
          const token = params.connection.token.trim();
          if (token) {
            headers.set("authorization", `Bearer ${token}`);
          }

          const response = await fetch(buildUrl(params.connection.baseUrl, "/api/v1/platform-models/events"), {
            signal: controller.signal,
            headers
          });

          if (response.status === 404 || response.status === 501) {
            return;
          }

          if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
          }

          await consumeSse(
            response,
            (frame) => {
              const revision = frame.data.revision;
              const items = frame.data.items;
              if (typeof revision !== "number" || !Array.isArray(items)) {
                return;
              }

              params.onSnapshot(
                {
                  revision,
                  items: items as PlatformModelRecord[]
                },
                frame.event === "platform-models.snapshot"
              );
            },
            controller.signal
          );
        } catch (error) {
          if (controller.signal.aborted || cancelled) {
            return;
          }

          if (isNotFoundError(error)) {
            return;
          }
        }

        if (!controller.signal.aborted && !cancelled) {
          reconnectTimerRef.current = window.setTimeout(connect, 1_500);
        }
      })();
    };

    connect();

    return () => {
      cancelled = true;
      abortRef.current?.abort();
      window.clearTimeout(reconnectTimerRef.current);
    };
  }, [params.connection.baseUrl, params.connection.token, params.onSnapshot]);

  return {
    abortPlatformModelStream: () => abortRef.current?.abort(),
    clearPlatformModelReconnectTimer: () => window.clearTimeout(reconnectTimerRef.current)
  };
}

export { usePlatformModelStream };
