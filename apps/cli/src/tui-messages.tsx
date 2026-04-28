import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { Run, Session, Workspace } from "@oah/api-contracts";

import type { ChatLine, Notice } from "./tui-types.js";
import { shortId, SPINNER_FRAMES } from "./tui-utils.js";

export function StatusLine(props: { workspace: Workspace | null; session: Session | null; run: Run | null; notice: Notice; streamState: string }) {
  const runStatus = props.run ? props.run.status : "idle";
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text wrap="truncate-end">
          <Text color="cyan" bold>
            OAH
          </Text>{" "}
          <Text dimColor>{props.workspace?.name ?? "no workspace"}</Text>
        </Text>
        <Text dimColor>
          {props.session?.title ?? shortId(props.session?.id)} · {props.session?.activeAgentName ?? "no session"} · {runStatus} · {props.streamState}
        </Text>
      </Box>
      {props.notice.level === "error" ? (
        <Text color="red" wrap="truncate-end">
          {props.notice.message}
        </Text>
      ) : null}
    </Box>
  );
}

export function Messages(props: { lines: ChatLine[]; session: Session | null; height: number }) {
  const visibleLines = props.lines.slice(-Math.max(4, props.height));
  if (!props.session) {
    return (
      <Box flexDirection="column" height={props.height} flexShrink={1} justifyContent="flex-end" overflow="hidden">
        <Text dimColor>Welcome. Press ctrl+w to choose a workspace, then ctrl+o to choose or create a session.</Text>
      </Box>
    );
  }

  if (visibleLines.length === 0) {
    return (
      <Box flexDirection="column" height={props.height} flexShrink={1} justifyContent="flex-end" overflow="hidden">
        <Text dimColor>Start typing. Enter sends. /workspace and /session open switchers.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={props.height} flexShrink={1} overflow="hidden">
      {visibleLines.map((line) => (
        <MessageRow key={line.id} line={line} />
      ))}
    </Box>
  );
}

function MessageRow(props: { line: ChatLine }) {
  if (props.line.role === "user") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyan" bold>
          ❯ <Text>{props.line.text}</Text>
        </Text>
      </Box>
    );
  }

  const color = props.line.tone === "error" ? "red" : props.line.role === "assistant" ? undefined : "gray";
  return (
    <Box flexDirection="row" marginBottom={1}>
      <Box flexShrink={0}>
        <Text dimColor>{"  "}⎿  </Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        <Text {...(color ? { color } : {})} dimColor={props.line.tone === "muted"} wrap="wrap">
          {props.line.text}
        </Text>
      </Box>
    </Box>
  );
}

export function SpinnerLine(props: { run: Run | null }) {
  const [frame, setFrame] = useState(0);
  const active = props.run?.status === "queued" || props.run?.status === "running" || props.run?.status === "waiting_tool";

  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => setFrame((current) => (current + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(timer);
  }, [active]);

  if (!active) {
    return null;
  }

  const verb = props.run?.status === "waiting_tool" ? "Waiting for tool" : props.run?.status === "queued" ? "Queued" : "Working";
  return (
    <Box marginTop={1}>
      <Text color="cyan">{SPINNER_FRAMES[frame]} </Text>
      <Text dimColor>
        {verb}… {shortId(props.run?.id)}
      </Text>
    </Box>
  );
}
