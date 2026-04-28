import React from "react";
import { Box, Text, useCursor, useWindowSize } from "ink";
import type { Run, Session, Workspace } from "@oah/api-contracts";

import type { Notice } from "../domain/types.js";
import { clampIndex, getSlashCommandMatches, shortId } from "../domain/utils.js";

export function PromptInput(props: {
  value: string;
  cursor: number;
  disabled?: boolean;
  running: boolean;
  workspace: Workspace | null;
  session: Session | null;
  run: Run | null;
  notice: Notice;
  streamState: string;
  agentMode: string;
}) {
  const beforeCursor = props.value.slice(0, props.cursor);
  const afterCursor = props.value.slice(props.cursor);
  const { setCursorPosition } = useCursor();
  const { columns, rows } = useWindowSize();
  const prompt = "❯ ";
  const cursorX = Math.min(Math.max(0, columns - 1), terminalWidth(prompt) + terminalWidth(beforeCursor));
  const cursorY = Math.max(0, rows - 3);

  setCursorPosition(
    !props.disabled
      ? {
          x: cursorX,
          y: cursorY
        }
      : undefined
  );

  return (
    <Box flexDirection="column" height={5} overflow="hidden">
      <Text dimColor>{"─".repeat(Math.max(0, columns))}</Text>
      <Box flexDirection="row" width="100%" height={1}>
        <Text {...(props.disabled ? { color: "gray" } : {})} dimColor={Boolean(props.disabled)}>
          {prompt}
        </Text>
        {props.value ? (
          <Text wrap="truncate-end">
            {beforeCursor}
            {afterCursor}
          </Text>
        ) : (
          <Text> </Text>
        )}
      </Box>
      <Text dimColor>{"─".repeat(Math.max(0, columns))}</Text>
      <PromptFooter
        {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
        workspace={props.workspace}
        session={props.session}
        run={props.run}
        notice={props.notice}
        streamState={props.streamState}
        agentMode={props.agentMode}
      />
    </Box>
  );
}

function terminalWidth(value: string) {
  return Array.from(value).reduce((width, char) => width + characterWidth(char), 0);
}

function characterWidth(char: string) {
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) {
    return 0;
  }
  if (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}

function PromptFooter(props: {
  disabled?: boolean;
  workspace: Workspace | null;
  session: Session | null;
  run: Run | null;
  notice: Notice;
  streamState: string;
  agentMode: string;
}) {
  const sessionLabel = props.session?.title ?? shortId(props.session?.id);
  const location = props.session ? `${props.workspace?.name ?? "no workspace"} / ${sessionLabel}` : props.workspace?.name ?? "no workspace";
  const activity = footerActivity(props.run, props.session, props.streamState);
  const shortcuts = props.disabled ? "modal · esc" : "? · ^W ws · ^O sess · ^C";
  const modelAgent = footerModelAgent(props.session, props.agentMode);

  return (
    <Box paddingX={2} flexDirection="column" width="100%">
      <Box flexDirection="row" width="100%">
        <Box flexShrink={1} flexGrow={1}>
          <Text dimColor wrap="truncate-end">
            <Text color="cyan" bold>
              OAH
            </Text>{" "}
            {location}
          </Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          {props.notice.level === "error" ? (
            <Text color="red" wrap="truncate-start">
              {props.notice.message}
            </Text>
          ) : (
            <Text dimColor wrap="truncate-start">
              {activity ? `${activity} · ` : ""}
              {shortcuts}
            </Text>
          )}
        </Box>
      </Box>
      <Box flexDirection="row" width="100%">
        <Box flexShrink={1} flexGrow={1}>
          <Text dimColor wrap="truncate-start">
            {modelAgent}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

function footerModelAgent(session: Session | null, agentMode: string) {
  if (!session) {
    return "model auto · agent none";
  }
  const model = session.modelRef ? session.modelRef.replace(/^(platform|workspace)\//u, "") : "auto";
  const agent = session.activeAgentName || session.agentName || "agent";
  const mode = agentMode || "unknown";
  return `model ${model} · agent ${agent} · mode ${mode}`;
}

function footerActivity(run: Run | null, session: Session | null, streamState: string) {
  const runStatus = run?.status;
  if (runStatus && runStatus !== "completed") {
    return `${session?.activeAgentName ?? "agent"} · ${runStatus}`;
  }
  if (!session || streamState === "idle") {
    return "";
  }
  return streamState === "open" ? "connected" : streamState;
}

export function SlashSuggestions(props: { value: string; selectedIndex: number }) {
  const matches = getSlashCommandMatches(props.value);
  if (matches.length === 0) {
    return null;
  }
  const selectedIndex = clampIndex(props.selectedIndex, matches.length);
  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      {matches.map((item, index) => (
        <Text key={item.command} {...(index === selectedIndex ? { color: "cyan" } : {})} dimColor={index !== selectedIndex}>
          {index === selectedIndex ? "❯" : " "} {item.command} <Text dimColor>{item.description}</Text>
        </Text>
      ))}
    </Box>
  );
}
