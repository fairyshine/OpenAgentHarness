import React from "react";
import { Box, Text } from "ink";

import { SLASH_COMMANDS } from "./tui-utils.js";

export function PromptInput(props: { value: string; cursor: number; disabled?: boolean; running: boolean }) {
  const beforeCursor = props.value.slice(0, props.cursor);
  const afterCursor = props.value.slice(props.cursor);
  return (
    <Box flexDirection="column">
      <Box
        flexDirection="row"
        alignItems="flex-start"
        borderStyle="round"
        borderColor={props.disabled ? "gray" : "cyan"}
        borderLeft={false}
        borderRight={false}
        borderBottom
        width="100%"
      >
        <Text {...(props.disabled ? { color: "gray" } : {})} dimColor={Boolean(props.running || props.disabled)}>
          ❯{" "}
        </Text>
        {props.value ? (
          <Text wrap="truncate-end">
            {beforeCursor}
            {!props.disabled ? <Text inverse>{afterCursor[0] ?? " "}</Text> : null}
            {afterCursor.slice(1)}
          </Text>
        ) : (
          <Text dimColor>
            message OAH, or type /workspace{!props.disabled ? <Text inverse> </Text> : null}
          </Text>
        )}
      </Box>
      <PromptFooter {...(props.disabled === undefined ? {} : { disabled: props.disabled })} />
    </Box>
  );
}

function PromptFooter(props: { disabled?: boolean }) {
  const help = props.disabled ? "modal active" : "? for shortcuts";
  return (
    <Box paddingX={2}>
      <Text dimColor wrap="truncate-end">
        {help} · ctrl+w workspace · ctrl+o session · enter send · ctrl+c quit
      </Text>
    </Box>
  );
}

export function SlashSuggestions(props: { value: string }) {
  if (!props.value.startsWith("/") || props.value.includes(" ")) {
    return null;
  }
  const matches = SLASH_COMMANDS.filter((item) => item.command.startsWith(props.value)).slice(0, 4);
  if (matches.length === 0) {
    return null;
  }
  return (
    <Box flexDirection="column" paddingX={2}>
      {matches.map((item, index) => (
        <Text key={item.command} {...(index === 0 ? { color: "cyan" } : {})} dimColor={index !== 0}>
          {index === 0 ? "❯" : " "} {item.command} <Text dimColor>{item.description}</Text>
        </Text>
      ))}
    </Box>
  );
}
