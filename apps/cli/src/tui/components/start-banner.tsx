import React from "react";
import { Box, Text } from "ink";

export function startBannerRows(params: { height: number; columns: number; hasMessages: boolean }) {
  if (params.height < 7) {
    return 0;
  }
  if (!params.hasMessages) {
    return params.height;
  }
  const target = params.columns >= 70 ? 12 : 7;
  return Math.max(0, Math.min(target, params.height - 6));
}

export function StartBanner(props: {
  height: number;
  columns: number;
  subtitle: string;
  serviceUrl: string;
  workspaceName?: string | undefined;
  sessionTitle?: string | undefined;
  sessionId?: string | undefined;
  compact?: boolean | undefined;
}) {
  if (props.height <= 0) {
    return null;
  }
  if (props.height < 5) {
    return (
      <Box height={props.height} overflow="hidden">
        <Text dimColor>{props.subtitle}</Text>
      </Box>
    );
  }

  const compact = props.compact || props.columns < 70 || props.height < 9;
  return (
    <Box height={props.height} overflow="hidden" flexDirection="column">
      {compact ? <CompactBanner {...props} /> : <FullBanner {...props} />}
    </Box>
  );
}

function FullBanner(props: {
  height: number;
  columns: number;
  subtitle: string;
  serviceUrl: string;
  workspaceName?: string | undefined;
  sessionTitle?: string | undefined;
  sessionId?: string | undefined;
}) {
  const title = " Open Agent Harness TUI v0.1.0 ";
  const rows = bannerRows(props.columns, props.subtitle, props.serviceUrl);
  return (
    <Box flexDirection="column" width="100%" overflow="hidden">
      <FrameTitle columns={props.columns} title={title} />
      {rows.map((row, index) => (
        <Text key={index}>
          <Text color="cyan">│</Text>
          <BannerMarkText index={index} text={row.mark} lastIndex={rows.length - 1} />
          <Text color="cyan">│</Text>
          <Text>{row.feed}</Text>
          <Text color="cyan">│</Text>
        </Text>
      ))}
      <FrameBottom columns={props.columns} />
    </Box>
  );
}

function BannerMarkText(props: { index: number; text: string; lastIndex: number }) {
  if (props.index === 0) {
    return <Text bold>{props.text}</Text>;
  }
  if (props.index === props.lastIndex) {
    return <Text dimColor>{props.text}</Text>;
  }
  return <Text color="cyan">{props.text}</Text>;
}

function bannerRows(columns: number, subtitle: string, serviceUrl: string) {
  const rawMark = welcomeMarkLines(serviceUrl);
  const feed = feedLines(subtitle);
  const artStart = 1;
  const artEnd = rawMark.length - 1;
  const artWidth = maxWidth(rawMark.slice(artStart, artEnd));
  const markContentWidth = Math.max(maxWidth(rawMark), artWidth);
  const innerWidth = Math.max(10, columns - 2);
  const markWidth = Math.min(Math.max(markContentWidth + 2, 24), Math.max(24, innerWidth - 24));
  const feedWidth = Math.max(0, innerWidth - markWidth - 1);
  const rowCount = Math.max(rawMark.length, feed.length);
  return Array.from({ length: rowCount }, (_, index) => ({
    mark: padCenter(formatMarkLine(rawMark[index] ?? "", index, artStart, artEnd, artWidth), markWidth),
    feed: padEnd(clipText(feed[index] ?? "", feedWidth), feedWidth)
  }));
}

function formatMarkLine(line: string, index: number, artStart: number, artEnd: number, artWidth: number) {
  if (index >= artStart && index < artEnd) {
    return padEnd(line, artWidth);
  }
  return line;
}

function feedLines(subtitle: string) {
  return [
    " Tips for getting started",
    ` ${subtitle}`,
    " Use / for commands, ^W for workspaces, ^O for sessions.",
    ` ${"─".repeat(44)}`,
    " What's new",
    " Workspace and session details stay visible in the status bar.",
    " SSE output streams live and remains pinned to the bottom.",
    ""
  ];
}

function welcomeMarkLines(serviceUrl: string) {
  return [
    "Welcome Back!",
    "       ⣠⣶⣦⣶⡆",
    "      ⣸⣿⣿⣿⠟",
    "  ⣀⣤⣶⣶⣿⣿⠛⠁",
    " ⣾⣿⣿⣿⣿⣿⣿⣧⣤⣤⣤⣤⣤⣄⣀",
    " ⠉⠛⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣄",
    "   ⠘⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡆",
    "     ⠙⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⠆",
    "    ⠐⠿⠿⠋ ⠘⠿⠿⠿⠿⠿⠿⠟⠉⠁",
    serviceUrl
  ];
}

function FrameTitle(props: { columns: number; title: string }) {
  const width = Math.max(12, props.columns);
  const titleWidth = terminalWidth(props.title);
  const left = Math.max(1, Math.min(3, width - titleWidth - 4));
  const right = Math.max(0, width - 2 - left - titleWidth);
  return (
    <Text color="cyan">
      ╭{"─".repeat(left)}
      <Text bold>{props.title}</Text>
      {"─".repeat(right)}╮
    </Text>
  );
}

function FrameBottom(props: { columns: number }) {
  return <Text color="cyan">╰{"─".repeat(Math.max(0, props.columns - 2))}╯</Text>;
}

function maxWidth(lines: string[]) {
  return lines.reduce((max, line) => Math.max(max, terminalWidth(line)), 0);
}

function padCenter(value: string, width: number) {
  const available = Math.max(0, width - terminalWidth(value));
  const left = Math.floor(available / 2);
  const right = available - left;
  return `${" ".repeat(left)}${value}${" ".repeat(right)}`;
}

function padEnd(value: string, width: number) {
  return `${value}${" ".repeat(Math.max(0, width - terminalWidth(value)))}`;
}

function clipText(value: string, width: number) {
  if (terminalWidth(value) <= width) {
    return value;
  }
  if (width <= 1) {
    return "";
  }
  let result = "";
  let used = 0;
  for (const char of value) {
    const charWidth = characterWidth(char);
    if (used + charWidth > width - 1) {
      break;
    }
    result += char;
    used += charWidth;
  }
  return `${result}…`;
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

function CompactBanner(props: {
  subtitle: string;
  workspaceName?: string | undefined;
  sessionTitle?: string | undefined;
  sessionId?: string | undefined;
}) {
  return (
    <Box flexDirection="row" gap={2} alignItems="center" paddingX={1} overflow="hidden">
      <OahMark small />
      <Box flexDirection="column" flexShrink={1}>
        <Text>
          <Text bold>OAH TUI</Text> <Text dimColor>v0.1.0</Text>
        </Text>
        <Text dimColor wrap="truncate-end">
          {props.subtitle}
        </Text>
      </Box>
    </Box>
  );
}

function OahMark(props: { small?: boolean | undefined }) {
  if (props.small) {
    return (
      <Box flexDirection="column">
        <Text color="cyan">    ⢀⣴⣶⣶</Text>
        <Text color="cyan">  ⢀⣀⣼⣿⠟⠁</Text>
        <Text color="cyan">⢠⣾⣿⣿⣿⣷⣤⣤⣤⣄⣀</Text>
        <Text color="cyan"> ⠙⢿⣿⣿⣿⣿⣿⣿⣿⣿⣷⡄</Text>
        <Text color="cyan">  ⠈⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿⡀</Text>
        <Text color="cyan">   ⠴⠿⠋⠙⠿⠿⠿⠿⠟⠛⠁</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" alignItems="center">
      <Text color="cyan">       ⣠⣶⣦⣶⡆          </Text>
      <Text color="cyan">      ⣸⣿⣿⣿⠟          </Text>
      <Text color="cyan">  ⣀⣤⣶⣶⣿⣿⠛⠁         </Text>
      <Text color="cyan"> ⣾⣿⣿⣿⣿⣿⣿⣧⣤⣤⣤⣤⣤⣄⣀ </Text>
      <Text color="cyan"> ⠉⠛⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣄</Text>
      <Text color="cyan">   ⠘⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡆</Text>
      <Text color="cyan">     ⠙⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⠆</Text>
      <Text color="cyan">    ⠐⠿⠿⠋ ⠘⠿⠿⠿⠿⠿⠿⠟⠉⠁</Text>
    </Box>
  );
}
