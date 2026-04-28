import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { Run, Session, Workspace } from "@oah/api-contracts";

import type { ChatLine } from "../domain/types.js";
import { shortId, SPINNER_FRAMES } from "../domain/utils.js";
import { StartBanner, startBannerRows } from "./start-banner.js";

type VisibleChatLine = ChatLine & {
  displayText: string;
  marginBottom: number;
  clipped?: boolean;
};

export function Messages(props: {
  lines: ChatLine[];
  workspace: Workspace | null;
  session: Session | null;
  serviceUrl: string;
  height: number;
  columns: number;
}) {
  const hasMessages = props.session !== null && props.lines.length > 0;
  const bannerRows = startBannerRows({ height: props.height, columns: props.columns, hasMessages });
  const messageRows = hasMessages ? Math.max(1, props.height - bannerRows) : 0;
  const visibleLines = hasMessages ? getBottomAnchoredLines(props.lines, messageRows, props.columns) : [];
  const bannerSubtitle = !props.session
    ? "Create or switch to a session with ^O"
    : hasMessages
      ? "Resuming your session"
      : "Start typing or use / for commands";

  if (!props.session) {
    return (
      <Box flexDirection="column" height={props.height} flexShrink={1} justifyContent="flex-end" overflow="hidden">
        <StartBanner
          height={props.height}
          columns={props.columns}
          subtitle={bannerSubtitle}
          serviceUrl={props.serviceUrl}
          workspaceName={props.workspace?.name}
          compact={props.height < 9}
        />
      </Box>
    );
  }

  if (!hasMessages) {
    return (
      <Box flexDirection="column" height={props.height} flexShrink={1} justifyContent="flex-end" overflow="hidden">
        <StartBanner
          height={props.height}
          columns={props.columns}
          subtitle={bannerSubtitle}
          serviceUrl={props.serviceUrl}
          workspaceName={props.workspace?.name}
          sessionTitle={props.session.title}
          sessionId={props.session.id}
          compact={props.height < 9}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={props.height} flexShrink={1} overflow="hidden">
      {bannerRows > 0 ? (
        <StartBanner
          height={bannerRows}
          columns={props.columns}
          subtitle={bannerSubtitle}
          serviceUrl={props.serviceUrl}
          workspaceName={props.workspace?.name}
          sessionTitle={props.session.title}
          sessionId={props.session.id}
          compact={bannerRows < 9}
        />
      ) : null}
      <Box flexDirection="column" height={messageRows} flexShrink={1} justifyContent="flex-end" overflow="hidden">
        {visibleLines.map((line) => (
          <MessageRow key={line.id} line={line} />
        ))}
      </Box>
    </Box>
  );
}

function MessageRow(props: { line: VisibleChatLine }) {
  if (props.line.clipped) {
    return <ClippedLine line={props.line} />;
  }

  if (props.line.role === "user") {
    return (
      <Box flexDirection="column" marginBottom={props.line.marginBottom}>
        <Text color="cyan">
          ❯ <Text>{props.line.displayText}</Text>
        </Text>
      </Box>
    );
  }

  if (props.line.role === "assistant") {
    return (
      <Box flexDirection="column" marginBottom={props.line.marginBottom} paddingLeft={2}>
        <MarkdownLite text={props.line.displayText} />
      </Box>
    );
  }

  if (props.line.kind === "tool") {
    return <ToolLine line={props.line} />;
  }

  if (props.line.kind === "attachment" || props.line.kind === "approval" || props.line.kind === "reasoning") {
    return <DecoratedLine line={props.line} />;
  }

  const color = props.line.tone === "error" ? "red" : props.line.role === "assistant" ? undefined : "gray";
  return (
    <Box flexDirection="row" marginBottom={props.line.marginBottom}>
      <Box flexShrink={0}>
        <Text dimColor>{"  "}⎿  </Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        <Text {...(color ? { color } : {})} dimColor={props.line.tone === "muted"} wrap="wrap">
          {props.line.displayText}
        </Text>
      </Box>
    </Box>
  );
}

function MarkdownLite(props: { text: string }) {
  const rows = props.text.split("\n");
  let inFence = false;
  return (
    <Box flexDirection="column">
      {rows.map((row, index) => {
        const trimmed = row.trim();
        if (trimmed.startsWith("```")) {
          inFence = !inFence;
          return (
            <Text key={index} dimColor>
              {row}
            </Text>
          );
        }
        if (inFence) {
          return (
            <Text key={index} color="gray">
              {row}
            </Text>
          );
        }
        if (/^#{1,4}\s/u.test(trimmed)) {
          return (
            <Text key={index} color="cyan" bold>
              {trimmed.replace(/^#{1,4}\s/u, "")}
            </Text>
          );
        }
        const bullet = row.match(/^(\s*)([-*+])\s+(.*)$/u);
        if (bullet) {
          return (
            <Text key={index}>
              {bullet[1]}
              <Text dimColor>{bullet[2]}</Text> {bullet[3]}
            </Text>
          );
        }
        const numbered = row.match(/^(\s*)(\d+\.)\s+(.*)$/u);
        if (numbered) {
          return (
            <Text key={index}>
              {numbered[1]}
              <Text dimColor>{numbered[2]}</Text> {numbered[3]}
            </Text>
          );
        }
        return <Text key={index}>{row}</Text>;
      })}
    </Box>
  );
}

function ToolLine(props: { line: VisibleChatLine }) {
  const status = props.line.toolStatus ?? (props.line.tone === "error" ? "failed" : "completed");
  const isError = status === "failed" || status === "denied";
  const response = toolResponseText(props.line);
  return (
    <Box flexDirection="column" marginBottom={props.line.marginBottom}>
      <Box flexDirection="row" flexWrap="nowrap">
        <ToolStatusDot status={status} />
        <Text bold wrap="truncate-end" {...(isError ? { color: "red" } : {})}>
          {props.line.title ?? props.line.toolName ?? "Tool"}
        </Text>
        {props.line.detail ? <Text dimColor> ({props.line.detail})</Text> : null}
        {props.line.sourceType ? <Text dimColor> · {props.line.sourceType}</Text> : null}
      </Box>
      {response ? (
        <MessageResponse>
          <CappedText text={response} {...(isError ? { color: "red" } : {})} />
        </MessageResponse>
      ) : status === "running" ? (
        <MessageResponse>
          <Text dimColor>Running…</Text>
        </MessageResponse>
      ) : null}
    </Box>
  );
}

function ToolStatusDot(props: { status: NonNullable<ChatLine["toolStatus"]> }) {
  const [visible, setVisible] = useState(true);
  const running = props.status === "running" || props.status === "queued" || props.status === "waiting";

  useEffect(() => {
    if (!running) {
      setVisible(true);
      return;
    }
    const timer = setInterval(() => setVisible((current) => !current), 420);
    return () => clearInterval(timer);
  }, [running]);

  const color = props.status === "failed" || props.status === "denied" ? "red" : props.status === "completed" ? "green" : "cyan";
  return (
    <Box minWidth={2}>
      <Text color={color} dimColor={running}>
        {running && !visible ? " " : "●"}
      </Text>
    </Box>
  );
}

function DecoratedLine(props: { line: VisibleChatLine }) {
  const color = props.line.tone === "error" ? "red" : undefined;
  return (
    <Box flexDirection="column" marginBottom={props.line.marginBottom}>
      <MessageResponse>
        <Box flexDirection="column">
          <Text {...(color ? { color } : {})} dimColor={props.line.tone === "muted"}>
            {props.line.title ?? props.line.displayText}
            {props.line.detail ? <Text dimColor> ({props.line.detail})</Text> : null}
          </Text>
          {props.line.title && props.line.displayText !== props.line.title ? (
            <Text {...(color ? { color } : {})} dimColor={props.line.tone === "muted"}>
              {props.line.displayText}
            </Text>
          ) : null}
        </Box>
      </MessageResponse>
    </Box>
  );
}

function ClippedLine(props: { line: VisibleChatLine }) {
  if (props.line.role === "user") {
    return (
      <Box flexDirection="column" marginBottom={props.line.marginBottom}>
        <Text color="cyan">
          ❯ <Text>{props.line.displayText}</Text>
        </Text>
      </Box>
    );
  }

  if (props.line.role === "assistant") {
    return (
      <Box flexDirection="column" marginBottom={props.line.marginBottom} paddingLeft={2}>
        <MarkdownLite text={props.line.displayText} />
      </Box>
    );
  }

  const color = props.line.tone === "error" ? "red" : undefined;
  return (
    <Box flexDirection="column" marginBottom={props.line.marginBottom}>
      <MessageResponse>
        <Text {...(color ? { color } : {})} dimColor={props.line.tone === "muted"} wrap="wrap">
          {props.line.displayText}
        </Text>
      </MessageResponse>
    </Box>
  );
}

function MessageResponse(props: { children: React.ReactNode }) {
  return (
    <Box flexDirection="row">
      <Box flexShrink={0}>
        <Text dimColor>{"  "}⎿  </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} flexDirection="column">
        {props.children}
      </Box>
    </Box>
  );
}

function CappedText(props: { text: string; color?: string | undefined }) {
  const lines = props.text.split("\n");
  const maxLines = 8;
  const visible = lines.slice(0, maxLines);
  const hidden = lines.length - visible.length;
  return (
    <Box flexDirection="column">
      <Text {...(props.color ? { color: props.color } : {})}>{visible.join("\n")}</Text>
      {hidden > 0 ? (
        <Text dimColor>
          … +{hidden} {hidden === 1 ? "line" : "lines"}
        </Text>
      ) : null}
    </Box>
  );
}

function toolResponseText(line: ChatLine) {
  const title = line.title ?? line.toolName;
  if (!line.text.trim()) {
    return "";
  }
  if (title && line.text.trim() === title.trim()) {
    return "";
  }
  const compactHeader = title && line.detail ? `${title} (${line.detail})` : title;
  if (compactHeader && line.text.trim() === compactHeader.trim()) {
    return "";
  }
  return line.text;
}

function getBottomAnchoredLines(lines: ChatLine[], height: number, columns: number): VisibleChatLine[] {
  const maxRows = Math.max(1, height);
  const visible: VisibleChatLine[] = [];
  let remainingRows = maxRows;

  for (let index = lines.length - 1; index >= 0 && remainingRows > 0; index -= 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }
    const textWidth = lineTextWidth(line, columns);
    const rows = wrapTerminalRows(linePlainText(line), textWidth);
    const marginBottom = visible.length === 0 ? 0 : 1;
    const fullHeight = rows.length + marginBottom;

    if (fullHeight <= remainingRows) {
      visible.unshift({
        ...line,
        displayText: rows.join("\n"),
        marginBottom
      });
      remainingRows -= fullHeight;
      continue;
    }

    const availableTextRows = remainingRows - marginBottom;
    if (availableTextRows > 0) {
      visible.unshift({
        ...line,
        displayText: rows.slice(-availableTextRows).join("\n"),
        marginBottom,
        clipped: true
      });
    } else if (visible.length === 0 && remainingRows > 0) {
      visible.unshift({
        ...line,
        displayText: rows.slice(-remainingRows).join("\n"),
        marginBottom: 0,
        clipped: true
      });
    }
    break;
  }

  return visible;
}

function lineTextWidth(line: ChatLine, columns: number) {
  if (line.role === "user") {
    return Math.max(1, columns - 2);
  }
  if (line.role === "assistant") {
    return Math.max(1, columns - 2);
  }
  return Math.max(1, columns - 5);
}

function linePlainText(line: ChatLine) {
  if (line.kind === "tool") {
    const header = `${line.title ?? line.toolName ?? "Tool"}${line.detail ? ` (${line.detail})` : ""}`;
    const response = toolResponseText(line);
    return response ? `${header}\n${response}` : header;
  }
  if (line.title && line.text && line.text !== line.title) {
    return `${line.title}${line.detail ? ` (${line.detail})` : ""}\n${line.text}`;
  }
  return line.text;
}

function wrapTerminalRows(value: string, width: number) {
  const rows: string[] = [];
  for (const rawLine of value.split("\n")) {
    if (!rawLine) {
      rows.push("");
      continue;
    }

    let row = "";
    let rowWidth = 0;
    for (const char of Array.from(rawLine)) {
      const charWidth = characterWidth(char);
      if (row && rowWidth + charWidth > width) {
        rows.push(row);
        row = "";
        rowWidth = 0;
      }
      row += char;
      rowWidth += charWidth;
    }
    rows.push(row);
  }
  return rows.length > 0 ? rows : [""];
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
      <Text color="cyan">✻ </Text>
      <Text dimColor>{verb}… </Text>
      <Text dimColor>{shortId(props.run?.id)}</Text>
      <Text dimColor> {SPINNER_FRAMES[frame]}</Text>
    </Box>
  );
}
