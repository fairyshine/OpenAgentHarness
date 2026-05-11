import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { Run, Session, SystemProfile, Workspace } from "@oah/api-contracts";

import type { ChatLine } from "../domain/types.js";
import { shortId, SPINNER_FRAMES } from "../domain/utils.js";
import { Markdown, getMarkdownRowCount } from "./markdown.js";
import { MessageResponse } from "./message-response.js";
import { StartBanner } from "./start-banner.js";
import { rowCountForText, wrapTerminalRows } from "./terminal-text.js";
import { getToolLineRowCount, ToolLine } from "./tool-renderers.js";

type VisibleChatLine = ChatLine & {
  displayText: string;
  marginBottom: number;
};

export type TranscriptItem =
  | {
      id: string;
      kind: "banner";
      workspace: Workspace | null;
      session: Session | null;
      serviceUrl: string;
      systemProfile: SystemProfile | null;
      columns: number;
      subtitle: string;
      height: number;
      compact: boolean;
    }
  | {
      id: string;
      kind: "line";
      line: VisibleChatLine;
    };

export function Messages(props: {
  lines: ChatLine[];
  workspace: Workspace | null;
  session: Session | null;
  serviceUrl: string;
  systemProfile?: SystemProfile | null | undefined;
  height: number;
  columns: number;
  showBanner?: boolean | undefined;
}) {
  const showBanner = props.showBanner ?? true;
  const hasMessages = props.session !== null && props.lines.length > 0;
  const visibleLines = hasMessages ? getTranscriptLines(props.lines) : [];
  const bannerSubtitle = !props.session
    ? "Create or switch to a session with ^O"
    : hasMessages
      ? "Resuming your session"
      : "Start typing or use / for commands";

  if (!props.session && showBanner) {
    return (
      <Box flexDirection="column" height={props.height} flexShrink={1} justifyContent="flex-end" overflow="hidden">
        <StartBanner
          height={props.height}
          columns={props.columns}
          subtitle={bannerSubtitle}
          serviceUrl={props.serviceUrl}
          systemProfile={props.systemProfile ?? null}
          workspaceName={props.workspace?.name}
          compact={props.height < 9}
        />
      </Box>
    );
  }

  if (!props.session) {
    return null;
  }

  if (!hasMessages && showBanner) {
    return (
      <Box flexDirection="column" height={props.height} flexShrink={1} justifyContent="flex-end" overflow="hidden">
        <StartBanner
          height={props.height}
          columns={props.columns}
          subtitle={bannerSubtitle}
          serviceUrl={props.serviceUrl}
          systemProfile={props.systemProfile ?? null}
          workspaceName={props.workspace?.name}
          sessionTitle={props.session.title}
          sessionId={props.session.id}
          compact={props.height < 9}
        />
      </Box>
    );
  }

  const bannerHeight = getTranscriptBannerRows({
    columns: props.columns,
    hasMessages,
    height: props.height,
    lineRows: getChatLinesRowCount(visibleLines, props.columns)
  });

  return (
    <Box flexDirection="column">
      {showBanner && bannerHeight > 0 ? (
        <Box marginBottom={1}>
          <StartBanner
            height={bannerHeight}
            columns={props.columns}
            subtitle={bannerSubtitle}
            serviceUrl={props.serviceUrl}
            systemProfile={props.systemProfile ?? null}
            workspaceName={props.workspace?.name}
            sessionTitle={props.session.title}
            sessionId={props.session.id}
            compact={props.columns < 70 || bannerHeight < 9}
          />
        </Box>
      ) : null}
      <Box flexDirection="column">
        {visibleLines.map((line) => (
          <MessageRow key={line.id} line={line} columns={props.columns} />
        ))}
      </Box>
    </Box>
  );
}

export function getTranscriptItems(input: {
  lines: ChatLine[];
  workspace: Workspace | null;
  session: Session | null;
  serviceUrl: string;
  systemProfile?: SystemProfile | null | undefined;
  height: number;
  columns: number;
  includeBanner: boolean;
  bannerHeight?: number | undefined;
  hasMessages?: boolean | undefined;
}) {
  const hasMessages = input.hasMessages ?? (input.session !== null && input.lines.length > 0);
  const bannerSubtitle = !input.session
    ? "Create or switch to a session with ^O"
    : hasMessages
      ? "Resuming your session"
      : "Start typing or use / for commands";
  const items: TranscriptItem[] = [];

  const bannerHeight =
    input.bannerHeight ??
    getTranscriptBannerRows({
      columns: input.columns,
      hasMessages,
      height: input.height,
      lineRows: getChatLinesRowCount(input.lines, input.columns)
    });

  if (input.includeBanner && bannerHeight > 0) {
    items.push({
      id: `banner:${input.workspace?.id ?? "none"}:${input.session?.id ?? "none"}`,
      kind: "banner",
      workspace: input.workspace,
      session: input.session,
      serviceUrl: input.serviceUrl,
      systemProfile: input.systemProfile ?? null,
      columns: input.columns,
      subtitle: bannerSubtitle,
      height: bannerHeight,
      compact: input.columns < 70 || bannerHeight < 9
    });
  }

  items.push(...getTranscriptLineItems(input.lines));
  return items;
}

export function getTranscriptLineItems(lines: ChatLine[]) {
  return getTranscriptLines(lines).map((line) => ({
    id: `line:${line.id}`,
    kind: "line" as const,
    line: {
      ...line,
      marginBottom: 1
    }
  }));
}

export function TranscriptItemView(props: { item: TranscriptItem; columns: number }) {
  if (props.item.kind === "banner") {
    return (
      <Box key={props.item.id} marginBottom={1}>
        <StartBanner
          height={props.item.height}
          columns={props.item.columns}
          subtitle={props.item.subtitle}
          serviceUrl={props.item.serviceUrl}
          systemProfile={props.item.systemProfile}
          workspaceName={props.item.workspace?.name}
          sessionTitle={props.item.session?.title}
          sessionId={props.item.session?.id}
          compact={props.item.compact}
        />
      </Box>
    );
  }

  return <MessageRow key={props.item.id} line={props.item.line} columns={props.columns} />;
}

export function getMessagesRowCount(input: { lines: ChatLine[]; session: Session | null; height: number; columns: number }) {
  const hasMessages = input.session !== null && input.lines.length > 0;
  if (!input.session || !hasMessages) {
    return input.height;
  }

  const lineRows = getChatLinesRowCount(input.lines, input.columns);
  const bannerRows = getTranscriptBannerRows({
    columns: input.columns,
    hasMessages,
    height: input.height,
    lineRows
  });
  const bannerMargin = bannerRows > 0 ? 1 : 0;
  return bannerRows + bannerMargin + lineRows;
}

export function getChatLinesRowCount(lines: ChatLine[], columns: number) {
  return lines.reduce((rows, line, index) => rows + lineRowCount(line, columns, index === lines.length - 1), 0);
}

export function getTranscriptBannerNaturalRows(columns: number) {
  return columns >= 70 ? 12 : 7;
}

export function getTranscriptBannerRows(input: {
  columns: number;
  hasMessages: boolean;
  height: number;
  lineRows: number;
}) {
  if (input.height < 7) {
    return 0;
  }
  if (!input.hasMessages) {
    return input.height;
  }

  const naturalRows = getTranscriptBannerNaturalRows(input.columns);
  const bannerMargin = 1;
  const extraRows = Math.max(0, input.height - naturalRows - bannerMargin - input.lineRows);
  return Math.min(input.height, naturalRows + extraRows);
}

function MessageRow(props: { line: VisibleChatLine; columns: number }) {
  if (props.line.role === "user") {
    return (
      <Box flexDirection="column" marginBottom={props.line.marginBottom}>
        <Text color="cyan">
          ❯ <Text wrap="wrap">{props.line.displayText}</Text>
        </Text>
      </Box>
    );
  }

  if (props.line.kind === "tool") {
    return <ToolLine line={props.line} columns={props.columns} />;
  }

  if (props.line.role === "assistant") {
    return (
      <Box flexDirection="column" marginBottom={props.line.marginBottom} paddingLeft={2}>
        <Markdown text={props.line.displayText} />
      </Box>
    );
  }

  if (props.line.kind === "attachment" || props.line.kind === "approval" || props.line.kind === "reasoning") {
    return <DecoratedLine line={props.line} />;
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
            <Text {...(color ? { color } : {})} dimColor={props.line.tone === "muted"} wrap="wrap">
              {props.line.displayText}
            </Text>
          ) : null}
        </Box>
      </MessageResponse>
    </Box>
  );
}

function getTranscriptLines(lines: ChatLine[]): VisibleChatLine[] {
  return lines.map((line, index) => ({
    ...line,
    displayText: linePlainText(line),
    marginBottom: index === lines.length - 1 ? 0 : 1
  }));
}

function lineRowCount(line: ChatLine, columns: number, isLast: boolean) {
  const marginBottom = isLast ? 0 : 1;
  if (line.kind === "tool") {
    return getToolLineRowCount(line, columns) + marginBottom;
  }
  if (line.kind === "attachment" || line.kind === "approval" || line.kind === "reasoning") {
    const titleRows = 1;
    const detailRows = line.title && line.text && line.text !== line.title ? wrapTerminalRows(line.text, Math.max(1, columns - 5)).length : 0;
    return titleRows + detailRows + marginBottom;
  }
  if (line.role === "assistant") {
    return getMarkdownRowCount(line.text, columns) + marginBottom;
  }
  return rowCountForText(linePlainText(line), lineTextWidth(line, columns)) + marginBottom;
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
    const response = line.toolOutputText ?? line.text;
    return response && response.trim() !== header.trim() ? `${header}\n${response}` : header;
  }
  if (line.title && line.text && line.text !== line.title) {
    return `${line.title}${line.detail ? ` (${line.detail})` : ""}\n${line.text}`;
  }
  return line.text;
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
