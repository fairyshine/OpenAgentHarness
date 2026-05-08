import { memo } from "react";
import { CornerDownRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { formatTimestamp } from "../support";
import type { RuntimeProps } from "./conversation-model";

type QueuedRunsPanelProps = Pick<RuntimeProps, "guideQueuedSessionInput" | "guideMessageSupported"> & {
  items: RuntimeProps["queuedSessionRuns"];
};

export const QueuedRunsPanel = memo(function QueuedRunsPanel(props: QueuedRunsPanelProps) {
  if (props.items.length === 0) {
    return null;
  }

  return (
    <div
      className="conversation-queued-panel pointer-events-auto mb-3 rounded-2xl border px-3 py-3 shadow-lg"
      style={{
        background: "color-mix(in srgb, var(--background) 88%, transparent)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        borderColor: "color-mix(in srgb, var(--foreground) 10%, transparent)"
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-[0.12em] text-muted-foreground">后续消息队列</p>
          <p className="mt-1 text-xs text-muted-foreground">当前 run 结束后，会按顺序自动发起后续轮次。</p>
        </div>
        <Badge variant="secondary">{props.items.length}</Badge>
      </div>
      <div className="mt-3 space-y-2">
        {props.items.map((item, index) => (
          <div key={item.runId} className="flex items-start justify-between gap-3 rounded-xl border border-border/60 bg-background/70 px-3 py-2">
            <CornerDownRight className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span>{`#${item.position || index + 1}`}</span>
                <span>{formatTimestamp(item.createdAt)}</span>
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">{item.content}</p>
            </div>
            {props.guideMessageSupported ? (
              <Button
                variant="secondary"
                size="sm"
                className="h-8 flex-shrink-0 px-3 text-xs"
                onClick={() => props.guideQueuedSessionInput(item.runId)}
              >
                引导
              </Button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
});

