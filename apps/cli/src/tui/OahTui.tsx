import React from "react";
import { Box, useApp, useWindowSize } from "ink";

import type { OahConnection } from "../api/oah-api.js";
import { HelpDialog, SessionDialog, WorkspaceDialog } from "./components/dialogs.js";
import { Messages, SpinnerLine } from "./components/messages.js";
import { PromptInput, SlashSuggestions } from "./components/prompt.js";
import { getSlashCommandMatches } from "./domain/utils.js";
import { useTuiInput } from "./input/use-tui-input.js";
import { useOahReplState } from "./state/use-oah-repl-state.js";

function OahApp(props: { children: React.ReactNode }) {
  return <Box flexDirection="column">{props.children}</Box>;
}

function OahRepl({ connection }: { connection: OahConnection }) {
  const app = useApp();
  const { columns, rows: height } = useWindowSize();
  const state = useOahReplState(connection);

  useTuiInput({ state, exit: app.exit });

  const latestRun = state.runs[0] ?? null;
  const runActive = latestRun?.status === "queued" || latestRun?.status === "running" || latestRun?.status === "waiting_tool";
  const slashMatches = !state.dialog ? getSlashCommandMatches(state.composer) : [];
  const suggestionRows = slashMatches.length > 0 ? slashMatches.length + 1 : 0;
  const spinnerRows = runActive ? 2 : 0;
  const chromeRows = 5 + suggestionRows + spinnerRows;
  const dialogRows = state.dialog ? Math.max(8, Math.min(Math.floor(height * 0.66), height - chromeRows - 3)) : 0;
  const transcriptHeight = Math.max(3, height - dialogRows - chromeRows);
  const agentMode =
    state.catalog?.agents.find((agent) => agent.name === state.currentSession?.activeAgentName)?.mode ??
    (state.currentSession ? "unknown" : "");
  const activeDialog =
    state.dialog?.kind === "workspace-list" || state.dialog?.kind === "workspace-create" ? (
      <WorkspaceDialog
        dialog={state.dialog}
        workspaces={state.workspaces}
        currentWorkspace={state.currentWorkspace}
        runtimes={state.runtimes}
        rows={dialogRows}
      />
    ) : state.dialog?.kind === "session-list" || state.dialog?.kind === "session-create" ? (
      <SessionDialog
        dialog={state.dialog}
        sessions={state.sessions}
        currentSession={state.currentSession}
        workspace={state.currentWorkspace}
        rows={dialogRows}
      />
    ) : state.dialog?.kind === "help" ? (
      <HelpDialog rows={dialogRows} />
    ) : null;

  return (
    <Box flexDirection="column" height={height}>
      <Box flexDirection="column" flexGrow={1}>
        <Messages
          lines={state.messages}
          workspace={state.currentWorkspace}
          session={state.currentSession}
          serviceUrl={connection.baseUrl}
          height={transcriptHeight}
          columns={columns}
        />
        <SpinnerLine run={latestRun} />
      </Box>
      {activeDialog}
      {!state.dialog ? <SlashSuggestions value={state.composer} selectedIndex={state.slashSelection} /> : null}
      <PromptInput
        value={state.composer}
        cursor={state.composerCursor}
        disabled={state.dialog !== null}
        running={runActive}
        workspace={state.currentWorkspace}
        session={state.currentSession}
        run={latestRun}
        notice={state.notice}
        streamState={state.streamState}
        agentMode={agentMode}
      />
    </Box>
  );
}

export function OahTui({ connection }: { connection: OahConnection }) {
  return (
    <OahApp>
      <OahRepl connection={connection} />
    </OahApp>
  );
}
