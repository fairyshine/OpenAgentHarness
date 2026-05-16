import React from "react";
import { Box, Static, useApp, useWindowSize } from "ink";

import type { OahConnection } from "../api/oah-api.js";
import { HelpDialog, MemoryDialog, SessionDialog, WorkspaceDialog } from "./components/dialogs.js";
import {
  getChatLinesRowCount,
  getTranscriptBannerRows,
  getTranscriptItems,
  getTranscriptLineItems,
  Messages,
  SpinnerLine,
  TranscriptItemView,
  type TranscriptItem
} from "./components/messages.js";
import { getAskUserQuestionPickerRowCount, getPromptInputRowCount, getSlashSuggestionRowCount, PromptInput } from "./components/prompt.js";
import { useTuiInput } from "./input/use-tui-input.js";
import { useOahReplState } from "./state/use-oah-repl-state.js";
import type { SessionStartupMode } from "./domain/types.js";
import { latestAskUserQuestionPrompt } from "./domain/utils.js";

function OahApp(props: { children: React.ReactNode }) {
  return <Box flexDirection="column">{props.children}</Box>;
}

function OahRepl({
  connection,
  initialWorkspaceId,
  sessionStartupMode
}: {
  connection: OahConnection;
  initialWorkspaceId?: string | undefined;
  sessionStartupMode?: SessionStartupMode | undefined;
}) {
  const app = useApp();
  const { columns, rows: height } = useWindowSize();
  const state = useOahReplState(connection, { initialWorkspaceId, sessionStartupMode });

  useTuiInput({ state, exit: app.exit });

  const latestRun = state.runs[0] ?? null;
  const runActive = latestRun?.status === "queued" || latestRun?.status === "running" || latestRun?.status === "waiting_tool";
  const askUserQuestionPrompt = latestAskUserQuestionPrompt(state.messages);
  const askUserQuestionRows =
    !state.dialog && askUserQuestionPrompt && state.composer.trim().length === 0
      ? getAskUserQuestionPickerRowCount(askUserQuestionPrompt)
      : 0;
  const suggestionRows = !state.dialog && askUserQuestionRows === 0 ? getSlashSuggestionRowCount(state.composer) : 0;
  const spinnerRows = runActive ? 2 : 0;
  const promptRows = getPromptInputRowCount(state.composer, columns) + suggestionRows + askUserQuestionRows + 4;
  const chromeRows = promptRows + spinnerRows;
  const dialogRows = state.dialog ? Math.max(8, Math.min(Math.floor(height * 0.66), height - chromeRows - 3)) : 0;
  const transcriptHeight = Math.max(3, height - dialogRows - chromeRows);
  const splitTranscript = splitStaticTranscript({
    lines: state.messages,
    workspace: state.currentWorkspace,
    session: state.currentSession,
    serviceUrl: connection.baseUrl,
    systemProfile: state.systemProfile,
    height: transcriptHeight,
    columns
  });
  const liveMessageRows = getChatLinesRowCount(splitTranscript.liveLines, columns);
  const liveHasMessages = state.currentSession !== null && splitTranscript.liveLines.length > 0;
  const liveBannerHeight = splitTranscript.liveIncludesBanner
    ? getTranscriptBannerRows({
        columns,
        hasMessages: liveHasMessages,
        height: transcriptHeight,
        lineRows: liveMessageRows
      })
    : 0;
  const liveBannerRows = liveBannerHeight > 0 ? liveBannerHeight + (liveHasMessages ? 1 : 0) : 0;
  const liveViewportRows = Math.min(liveBannerRows + liveMessageRows, transcriptHeight);
  const promptCursorY = liveViewportRows + spinnerRows + dialogRows + 1;
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
        sessionLatestRuns={state.sessionLatestRuns}
        currentSession={state.currentSession}
        workspace={state.currentWorkspace}
        rows={dialogRows}
      />
    ) : state.dialog?.kind === "memory" ? (
      <MemoryDialog dialog={state.dialog} workspace={state.currentWorkspace} rows={dialogRows} />
    ) : state.dialog?.kind === "help" ? (
      <HelpDialog rows={dialogRows} />
    ) : null;

  return (
    <Box flexDirection="column">
      <Static items={splitTranscript.staticItems}>
        {(item) => <TranscriptItemView key={item.id} item={item} columns={columns} />}
      </Static>
      <Box flexDirection="column" height={liveViewportRows} overflow="hidden" justifyContent="flex-end">
        {splitTranscript.liveIncludesBanner || splitTranscript.liveLines.length > 0 ? (
          <Messages
            lines={splitTranscript.liveLines}
            workspace={state.currentWorkspace}
            session={state.currentSession}
            serviceUrl={connection.baseUrl}
            systemProfile={state.systemProfile}
            height={transcriptHeight}
            columns={columns}
            showBanner={splitTranscript.liveIncludesBanner}
          />
        ) : null}
      </Box>
      <SpinnerLine run={latestRun} />
      {activeDialog}
      <PromptInput
        value={state.composer}
        cursor={state.composerCursor}
        slashSelection={state.slashSelection}
        cursorY={promptCursorY}
        disabled={state.dialog !== null}
        running={runActive}
        workspace={state.currentWorkspace}
        session={state.currentSession}
        systemProfile={state.systemProfile}
        run={latestRun}
        notice={state.notice}
        streamState={state.streamState}
        agentMode={agentMode}
        askUserQuestionPrompt={askUserQuestionPrompt}
        askUserQuestionSelection={state.askUserQuestionSelection}
      />
    </Box>
  );
}

function splitStaticTranscript(input: {
  lines: ReturnType<typeof useOahReplState>["messages"];
  workspace: ReturnType<typeof useOahReplState>["currentWorkspace"];
  session: ReturnType<typeof useOahReplState>["currentSession"];
  serviceUrl: string;
  systemProfile: ReturnType<typeof useOahReplState>["systemProfile"];
  height: number;
  columns: number;
}): { staticItems: TranscriptItem[]; liveLines: ReturnType<typeof useOahReplState>["messages"]; liveIncludesBanner: boolean } {
  if (!input.session || input.lines.length === 0) {
    return {
      staticItems: [],
      liveLines: [],
      liveIncludesBanner: true
    };
  }

  const allLineRows = getChatLinesRowCount(input.lines, input.columns);
  const allBannerRows = getTranscriptBannerRows({
    columns: input.columns,
    hasMessages: true,
    height: input.height,
    lineRows: allLineRows
  });
  const allBannerMargin = allBannerRows > 0 ? 1 : 0;
  const canKeepBannerLive = allBannerRows + allBannerMargin + allLineRows <= input.height;
  if (canKeepBannerLive) {
    return {
      staticItems: [],
      liveLines: input.lines,
      liveIncludesBanner: true
    };
  }

  const staticLines = input.lines.slice(0, -1);
  const liveLines = input.lines.slice(-1);
  const staticLineRows = getChatLinesRowCount(staticLines, input.columns);
  const staticBannerRows = getTranscriptBannerRows({
    columns: input.columns,
    hasMessages: true,
    height: input.height,
    lineRows: staticLineRows + getChatLinesRowCount(liveLines, input.columns)
  });
  return {
    staticItems: [
      ...getTranscriptItems({
        lines: [],
        workspace: input.workspace,
        session: input.session,
        serviceUrl: input.serviceUrl,
        systemProfile: input.systemProfile,
        height: input.height,
        columns: input.columns,
        includeBanner: true,
        bannerHeight: staticBannerRows,
        hasMessages: true
      }),
      ...getTranscriptLineItems(staticLines)
    ],
    liveLines,
    liveIncludesBanner: false
  };
}

export function OahTui({
  connection,
  initialWorkspaceId,
  sessionStartupMode
}: {
  connection: OahConnection;
  initialWorkspaceId?: string | undefined;
  sessionStartupMode?: SessionStartupMode | undefined;
}) {
  return (
    <OahApp>
      <OahRepl connection={connection} initialWorkspaceId={initialWorkspaceId} sessionStartupMode={sessionStartupMode} />
    </OahApp>
  );
}
