import React from "react";
import { Box, Text, useWindowSize } from "ink";
import type { Run, Session, Workspace, WorkspaceMemoryFile, WorkspaceMemoryProposal, WorkspaceRuntime } from "@oah/api-contracts";

import type { Dialog } from "../domain/types.js";
import {
  clampIndex,
  formatSessionActivity,
  getRuntimeMatches,
  shortId,
  SLASH_COMMANDS,
  STATUS_COLORS,
  visibleWindow
} from "../domain/utils.js";

export function WorkspaceDialog(props: {
  dialog: Extract<Dialog, { kind: "workspace-list" | "workspace-create" }>;
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  runtimes: WorkspaceRuntime[];
  rows: number;
}) {
  if (props.dialog.kind === "workspace-create") {
    return (
      <DialogBox title="Create workspace" rows={props.rows}>
        <WorkspaceCreateFieldRow label="Name" value={props.dialog.name} placeholder="Workspace name" selected={props.dialog.field === "name"} />
        <WorkspaceCreateFieldRow
          label="Runtime"
          value={props.dialog.field === "runtime" ? props.dialog.runtimeQuery : props.dialog.runtime}
          placeholder={props.dialog.runtime || (props.runtimes.length > 0 ? "Type to search" : "No runtimes available")}
          selected={props.dialog.field === "runtime"}
        />
        <RuntimeChoiceLine dialog={props.dialog} runtimes={props.runtimes} />
        <WorkspaceCreateFieldRow label="Root path" value={props.dialog.rootPath} placeholder="Managed workspace" selected={props.dialog.field === "rootPath"} />
        <WorkspaceCreateFieldRow label="Owner ID" value={props.dialog.ownerId} placeholder="optional" selected={props.dialog.field === "ownerId"} />
        <WorkspaceCreateFieldRow label="Service" value={props.dialog.serviceName} placeholder="optional" selected={props.dialog.field === "serviceName"} />
        <Text dimColor>tab fields · type to filter runtime · enter select/create · esc back</Text>
      </DialogBox>
    );
  }
  const selectedIndex = props.dialog.selectedIndex;
  const limit = Math.max(6, props.rows - 5);
  const window = visibleWindow(props.workspaces, selectedIndex, limit);

  return (
    <DialogBox title={`Switch workspace ${props.workspaces.length > 0 ? `${selectedIndex + 1}/${props.workspaces.length}` : ""}`} rows={props.rows}>
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
      <Text dimColor>enter switch · n create · r refresh · esc close</Text>
    </DialogBox>
  );
}

function WorkspaceCreateFieldRow(props: { label: string; value: string; placeholder: string; selected: boolean }) {
  const hasValue = props.value.length > 0;
  return (
    <Box marginTop={props.label === "Name" ? 1 : 0}>
      <Text {...(props.selected ? { color: "cyan" } : {})} bold={props.selected} wrap="truncate-end">
        {props.selected ? "❯" : " "} {props.label.padEnd(9)}{" "}
        {hasValue ? props.value : <Text dimColor>{props.placeholder}</Text>}
        {props.selected ? <Text inverse> </Text> : null}
      </Text>
    </Box>
  );
}

function RuntimeChoiceLine(props: { dialog: Extract<Dialog, { kind: "workspace-create" }>; runtimes: WorkspaceRuntime[] }) {
  if (props.dialog.field !== "runtime") {
    return null;
  }
  if (props.runtimes.length === 0) {
    return <Text dimColor>{"  "}No runtimes. Press ctrl+r to refresh.</Text>;
  }
  const matches = getRuntimeMatches(props.runtimes, props.dialog.runtimeQuery);
  if (matches.length === 0) {
    return (
      <Box paddingLeft={12}>
        <Text dimColor>No matches. Press ctrl+u to clear.</Text>
      </Box>
    );
  }
  const selectedIndex = clampIndex(props.dialog.runtimeSelectedIndex, matches.length);
  const window = visibleWindow(matches, selectedIndex, 5);
  return (
    <Box flexDirection="column" paddingLeft={12}>
      {window.items.map((runtime, index) => {
        const absoluteIndex = window.offset + index;
        const selected = absoluteIndex === selectedIndex;
        const current = runtime.name === props.dialog.runtime;
        const color = selected ? "cyan" : current ? "green" : undefined;
        return (
          <Text key={runtime.name} {...(color ? { color } : {})} dimColor={!selected && !current} wrap="truncate-end">
            {selected ? "❯" : current ? "•" : " "} {runtime.name}
          </Text>
        );
      })}
    </Box>
  );
}

export function SessionDialog(props: {
  dialog: Extract<Dialog, { kind: "session-list" | "session-create" }>;
  sessions: Session[];
  sessionLatestRuns: Record<string, Run | undefined>;
  currentSession: Session | null;
  workspace: Workspace | null;
  rows: number;
}) {
  if (props.dialog.kind === "session-create") {
    return (
      <DialogBox title="Create session" rows={props.rows}>
        <Text dimColor>Optional title</Text>
        <Box borderStyle="single" borderColor="cyan" paddingX={1} marginTop={1}>
          <Text color="cyan">{"> "}</Text>
          <Text>{props.dialog.draft}</Text>
          <Text inverse> </Text>
        </Box>
        <Text dimColor>enter create · esc back · ctrl+u clear</Text>
      </DialogBox>
    );
  }
  const selectedIndex = props.dialog.selectedIndex;
  const limit = Math.max(6, props.rows - 5);
  const window = visibleWindow(props.sessions, selectedIndex, limit);

  return (
    <DialogBox title={`Switch session ${props.sessions.length > 0 ? `${selectedIndex + 1}/${props.sessions.length}` : ""}`} rows={props.rows}>
      {props.sessions.length === 0 ? (
        <Text dimColor>No sessions in this workspace. Press n to create one.</Text>
      ) : (
        window.items.map((session, index) => {
          const absoluteIndex = window.offset + index;
          const selected = absoluteIndex === selectedIndex;
          const current = props.currentSession?.id === session.id;
          const activity = formatSessionActivity(session, props.sessionLatestRuns[session.id]);
          const color = selected ? "cyan" : current ? "green" : activity.tone;
          return (
            <Text key={session.id} {...(color ? { color } : {})} bold={selected || current} wrap="truncate-end">
              {selected ? "❯" : current ? "•" : " "} {session.title ?? shortId(session.id)} <Text dimColor>{shortId(session.id)}</Text>{" "}
              {session.activeAgentName} <Text {...(activity.tone ? { color: activity.tone } : {})}>{activity.label}</Text>{" "}
              <Text dimColor>{activity.detail}</Text>
            </Text>
          );
        })
      )}
      <Text dimColor>enter resume · n new session · r refresh · esc close</Text>
    </DialogBox>
  );
}

export function MemoryDialog(props: {
  dialog: Extract<Dialog, { kind: "memory" }>;
  workspace: Workspace | null;
  rows: number;
}) {
  const status = props.dialog.status;
  const titleParts = ["Memory"];
  if (props.dialog.query) {
    titleParts.push(`search "${props.dialog.query}"`);
  }
  if (props.dialog.mode === "proposals") {
    titleParts.push("proposals");
  }
  if (props.dialog.mode === "detail") {
    titleParts.push("detail");
  }

  return (
    <DialogBox title={titleParts.join(" · ")} rows={props.rows}>
      <Text wrap="truncate-end">
        <Text color={status?.enabled ? "green" : "yellow"}>{status?.enabled ? "enabled" : "disabled"}</Text>{" "}
        <Text dimColor>{status?.writePolicy ?? "explicit-only"}</Text>{" "}
        <Text dimColor>
          files {status?.fileCount ?? 0} · topics {status?.topics ?? 0} · sessions {status?.sessions ?? 0} · daily {status?.daily ?? 0} · dreams{" "}
          {status?.dreams ?? 0} · proposals {status?.pendingProposals ?? props.dialog.proposals.length}
        </Text>
      </Text>
      {props.workspace ? (
        <Text dimColor wrap="truncate-end">
          {props.workspace.name} · {props.workspace.id}
        </Text>
      ) : null}
      {props.dialog.loading ? <Text color="cyan">loading...</Text> : null}
      {props.dialog.error ? <Text color="red">{props.dialog.error}</Text> : null}
      {props.dialog.mode === "detail" ? (
        <MemoryDetailView dialog={props.dialog} rows={props.rows} />
      ) : props.dialog.mode === "proposals" ? (
        <MemoryProposalList dialog={props.dialog} rows={props.rows} />
      ) : (
        <MemoryFileList dialog={props.dialog} rows={props.rows} />
      )}
      <Text dimColor>enter open · j/k move · f files · p proposals · r refresh · a apply · x reject · esc close</Text>
    </DialogBox>
  );
}

function MemoryFileList(props: { dialog: Extract<Dialog, { kind: "memory" }>; rows: number }) {
  const limit = Math.max(4, props.rows - 8);
  const selectedIndex = clampIndex(props.dialog.selectedIndex, props.dialog.files.length);
  const window = visibleWindow(props.dialog.files, selectedIndex, limit);
  if (props.dialog.files.length === 0) {
    return <Text dimColor>No memory files found.</Text>;
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      {window.items.map((file, index) => {
        const absoluteIndex = window.offset + index;
        return <MemoryFileLine key={file.path} file={file} selected={absoluteIndex === selectedIndex} />;
      })}
    </Box>
  );
}

function MemoryFileLine(props: { file: WorkspaceMemoryFile; selected: boolean }) {
  return (
    <Text {...(props.selected ? { color: "cyan" } : {})} bold={props.selected} wrap="truncate-end">
      {props.selected ? "❯" : " "} {props.file.title} <Text dimColor>{props.file.corpus}</Text> <Text dimColor>{props.file.path}</Text>
    </Text>
  );
}

function MemoryProposalList(props: { dialog: Extract<Dialog, { kind: "memory" }>; rows: number }) {
  const limit = Math.max(4, props.rows - 8);
  const selectedIndex = clampIndex(props.dialog.selectedIndex, props.dialog.proposals.length);
  const window = visibleWindow(props.dialog.proposals, selectedIndex, limit);
  if (props.dialog.proposals.length === 0) {
    return <Text dimColor>No pending memory proposals.</Text>;
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      {window.items.map((proposal, index) => {
        const absoluteIndex = window.offset + index;
        return <MemoryProposalLine key={proposal.path} proposal={proposal} selected={absoluteIndex === selectedIndex} />;
      })}
    </Box>
  );
}

function MemoryProposalLine(props: { proposal: WorkspaceMemoryProposal; selected: boolean }) {
  return (
    <Box flexDirection="column">
      <Text {...(props.selected ? { color: "cyan" } : {})} bold={props.selected} wrap="truncate-end">
        {props.selected ? "❯" : " "} {props.proposal.targetPath ?? props.proposal.path} <Text dimColor>{props.proposal.tool}</Text>
      </Text>
      {props.proposal.summary ? (
        <Text dimColor wrap="truncate-end">
          {"  "}
          {props.proposal.summary}
        </Text>
      ) : null}
    </Box>
  );
}

function MemoryDetailView(props: { dialog: Extract<Dialog, { kind: "memory" }>; rows: number }) {
  const detail = props.dialog.detail;
  if (!detail) {
    return <Text dimColor>No memory file selected.</Text>;
  }
  const limit = Math.max(4, props.rows - 8);
  const lines = detail.content.split("\n").slice(0, limit);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="cyan" wrap="truncate-end">
        {detail.path}
      </Text>
      {lines.map((line, index) => (
        <Text key={`${detail.path}:${index}`} wrap="truncate-end">
          {line}
        </Text>
      ))}
      {detail.truncated ? <Text dimColor>truncated · use CLI memory get for full file</Text> : null}
    </Box>
  );
}

export function HelpDialog(props: { rows: number }) {
  return (
    <DialogBox title="Help" rows={props.rows}>
      <Text>enter send</Text>
      <Text>ctrl+w workspace</Text>
      <Text>ctrl+o session</Text>
      <Text>j/k or arrows move</Text>
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
          {props.title}
        </Text>
        <Text dimColor>Esc</Text>
      </Box>
      <Box flexDirection="column" paddingX={1}>
        {props.children}
      </Box>
    </Box>
  );
}
