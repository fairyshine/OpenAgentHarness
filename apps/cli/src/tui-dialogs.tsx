import React from "react";
import { Box, Text, useWindowSize } from "ink";
import type { Session, Workspace, WorkspaceRuntime } from "@oah/api-contracts";

import type { Dialog } from "./tui-types.js";
import { formatTime, shortId, SLASH_COMMANDS, STATUS_COLORS, visibleWindow } from "./tui-utils.js";

export function WorkspaceDialog(props: {
  dialog: Extract<Dialog, { kind: "workspace-list" | "workspace-create" }>;
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  runtimes: WorkspaceRuntime[];
  rows: number;
}) {
  if (props.dialog.kind === "workspace-create") {
    return (
      <DialogBox title="New Workspace" rows={props.rows}>
        <WorkspaceCreateFieldRow label="Name" value={props.dialog.name} placeholder="Workspace name" selected={props.dialog.field === "name"} />
        <WorkspaceCreateFieldRow
          label="Runtime"
          value={props.dialog.runtime}
          placeholder={props.runtimes.length > 0 ? "Select runtime" : "No runtimes available"}
          selected={props.dialog.field === "runtime"}
        />
        <RuntimeChoiceLine runtimes={props.runtimes} selectedRuntime={props.dialog.runtime} active={props.dialog.field === "runtime"} />
        <WorkspaceCreateFieldRow label="Root path" value={props.dialog.rootPath} placeholder="Managed workspace" selected={props.dialog.field === "rootPath"} />
        <WorkspaceCreateFieldRow label="Owner ID" value={props.dialog.ownerId} placeholder="optional" selected={props.dialog.field === "ownerId"} />
        <WorkspaceCreateFieldRow label="Service" value={props.dialog.serviceName} placeholder="optional" selected={props.dialog.field === "serviceName"} />
        <Text dimColor>tab/up/down field · ←/→ runtime · ctrl+r refresh · enter create · esc back</Text>
      </DialogBox>
    );
  }
  const selectedIndex = props.dialog.selectedIndex;
  const limit = Math.max(6, props.rows - 5);
  const window = visibleWindow(props.workspaces, selectedIndex, limit);

  return (
    <DialogBox title={`Workspaces ${props.workspaces.length > 0 ? `${selectedIndex + 1}/${props.workspaces.length}` : ""}`} rows={props.rows}>
      {props.workspaces.length === 0 ? (
        <Text dimColor>No workspaces. Press n to create one.</Text>
      ) : (
        window.items.map((workspace, index) => {
          const absoluteIndex = window.offset + index;
          const selected = absoluteIndex === selectedIndex;
          const current = props.currentWorkspace?.id === workspace.id;
          const color = selected ? "cyan" : current ? "green" : STATUS_COLORS[workspace.status];
          return (
            <Text key={workspace.id} {...(color ? { color } : {})} bold={selected || current} wrap="truncate-end">
              {selected ? "❯" : current ? "•" : " "} {workspace.name} <Text dimColor>{shortId(workspace.id)}</Text> {workspace.kind}/
              {workspace.executionPolicy}/{workspace.readOnly ? "ro" : "rw"} <Text dimColor>{workspace.runtime ?? "runtime -"}</Text>{" "}
              <Text dimColor>{workspace.rootPath}</Text>
            </Text>
          );
        })
      )}
      <Text dimColor>enter switch · n new · r refresh · esc close</Text>
    </DialogBox>
  );
}

function WorkspaceCreateFieldRow(props: { label: string; value: string; placeholder: string; selected: boolean }) {
  return (
    <Box marginTop={props.label === "Name" ? 1 : 0}>
      <Text {...(props.selected ? { color: "cyan" } : {})} bold={props.selected} wrap="truncate-end">
        {props.selected ? "❯" : " "} {props.label.padEnd(9)}{" "}
        {props.value ? props.value : props.placeholder}
        {props.selected ? <Text inverse> </Text> : null}
      </Text>
    </Box>
  );
}

function RuntimeChoiceLine(props: { runtimes: WorkspaceRuntime[]; selectedRuntime: string; active: boolean }) {
  if (props.runtimes.length === 0) {
    return <Text dimColor>{"  "}No runtimes. Press r to refresh.</Text>;
  }
  const selectedIndex = Math.max(0, props.runtimes.findIndex((runtime) => runtime.name === props.selectedRuntime));
  const window = visibleWindow(props.runtimes, selectedIndex, 3);
  return (
    <Box paddingLeft={12}>
      <Text dimColor>
        {props.active ? "← " : ""}
        {window.items.map((runtime) => (runtime.name === props.selectedRuntime ? `[${runtime.name}]` : runtime.name)).join("  ")}
        {props.active ? " →" : ""}
      </Text>
    </Box>
  );
}

export function SessionDialog(props: {
  dialog: Extract<Dialog, { kind: "session-list" | "session-create" }>;
  sessions: Session[];
  currentSession: Session | null;
  workspace: Workspace | null;
  rows: number;
}) {
  if (props.dialog.kind === "session-create") {
    return (
      <DialogBox title="New Session" rows={props.rows}>
        <Text>Session title optional</Text>
        <Box borderStyle="single" borderColor="cyan" paddingX={1} marginTop={1}>
          <Text color="cyan">{"> "}</Text>
          <Text>{props.dialog.draft}</Text>
          <Text inverse> </Text>
        </Box>
        <Text dimColor>Enter creates for {props.workspace?.name ?? "current workspace"}. Esc returns. ctrl+u clears.</Text>
      </DialogBox>
    );
  }
  const selectedIndex = props.dialog.selectedIndex;
  const limit = Math.max(6, props.rows - 5);
  const window = visibleWindow(props.sessions, selectedIndex, limit);

  return (
    <DialogBox title={`Sessions ${props.sessions.length > 0 ? `${selectedIndex + 1}/${props.sessions.length}` : ""}`} rows={props.rows}>
      {props.sessions.length === 0 ? (
        <Text dimColor>No sessions in this workspace. Press n to create one.</Text>
      ) : (
        window.items.map((session, index) => {
          const absoluteIndex = window.offset + index;
          const selected = absoluteIndex === selectedIndex;
          const current = props.currentSession?.id === session.id;
          const color = selected ? "cyan" : current ? "green" : STATUS_COLORS[session.status];
          return (
            <Text key={session.id} {...(color ? { color } : {})} bold={selected || current} wrap="truncate-end">
              {selected ? "❯" : current ? "•" : " "} {session.title ?? shortId(session.id)} <Text dimColor>{shortId(session.id)}</Text>{" "}
              {session.activeAgentName} {session.status} <Text dimColor>{formatTime(session.lastRunAt ?? session.updatedAt)}</Text>
            </Text>
          );
        })
      )}
      <Text dimColor>enter switch · n new · r refresh · esc close</Text>
    </DialogBox>
  );
}

export function HelpDialog(props: { rows: number }) {
  return (
    <DialogBox title="Shortcuts" rows={props.rows}>
      <Text>Enter sends the current prompt.</Text>
      <Text>ctrl+w opens workspace switcher.</Text>
      <Text>ctrl+o opens session switcher.</Text>
      <Text>? opens this help pane.</Text>
      <Text>Esc closes panes. j/k or arrows move selection.</Text>
      <Box marginTop={1} flexDirection="column">
        {SLASH_COMMANDS.map((item) => (
          <Text key={item.command}>
            <Text color="cyan">{item.command}</Text> <Text dimColor>{item.description}</Text>
          </Text>
        ))}
      </Box>
    </DialogBox>
  );
}

function DialogBox(props: { title: string; rows: number; children: React.ReactNode }) {
  const { columns } = useWindowSize();
  return (
    <Box flexDirection="column" width="100%" height={props.rows} flexShrink={0} overflow="hidden">
      <Text dimColor>{"─".repeat(Math.max(0, columns))}</Text>
      <Box justifyContent="space-between">
        <Text color="cyan" bold>
          {"  "}
          {props.title}
        </Text>
        <Text dimColor>Esc close  </Text>
      </Box>
      <Box flexDirection="column" paddingX={2}>
        {props.children}
      </Box>
    </Box>
  );
}
