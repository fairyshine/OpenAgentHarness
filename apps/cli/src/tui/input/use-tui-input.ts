import { appendFileSync } from "node:fs";
import { useInput } from "ink";

import type { Dialog, WorkspaceCreateDialog } from "../domain/types.js";
import {
  cleanControlInput,
  clampIndex,
  createAskUserQuestionSelection,
  createWorkspaceDialog,
  cycleRuntime,
  formatAskUserQuestionAnswer,
  formatAskUserQuestionSelectionAnswer,
  getSlashCommandMatches,
  getRuntimeMatches,
  hasRawControl,
  insertTextAt,
  isAskUserQuestionSelectionCurrent,
  isReturnInput,
  latestAskUserQuestionPrompt,
  moveAskUserQuestionQuestion,
  moveAskUserQuestionSelection,
  selectFocusedAskUserQuestionOption,
  toggleAskUserQuestionSelection,
  moveWorkspaceCreateField
} from "../domain/utils.js";
import type { useOahReplState } from "../state/use-oah-repl-state.js";

type OahReplState = ReturnType<typeof useOahReplState>;

type TuiInputKey = {
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  tab?: boolean;
  escape?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  home?: boolean;
  end?: boolean;
  backspace?: boolean;
  delete?: boolean;
  return?: boolean;
};

function isTabInput(value: string, key: TuiInputKey) {
  return key.tab === true || hasRawControl(value, "\t");
}

const KITTY_SHIFT_ENTER = "\u001b[13;2u";
const KITTY_SHIFT_ENTER_STRIPPED = "[13;2u";
const KITTY_QUERY_RESPONSE_RE = /(?:\u001b)?\[\?\d+u/gu;
const XTERM_SHIFT_ENTER = "\u001b[27;2;13~";
const XTERM_SHIFT_ENTER_STRIPPED = "[27;2;13~";
const XTERM_MODIFY_OTHER_KEYS_RE = /(?:\u001b)?\[27;(\d+);(\d+)~/gu;
const KITTY_MODIFIED_KEY_RE = /(?:\u001b)?\[(\d+);(\d+(?::[\d:]+)?)u/gu;
const CSI_SHIFT_ENTER = "\u001b[13;2~";
const CSI_SHIFT_ENTER_STRIPPED = "[13;2~";

function isShiftReturnInput(value: string, key: TuiInputKey) {
  return (
    (key.shift === true && isReturnInput(value, key)) ||
    (key.meta === true && isReturnInput(value, key)) ||
    isLineFeedTextInput(value, key) ||
    isLikelyShiftReturnFallback(value, key) ||
    hasRawControl(value, KITTY_SHIFT_ENTER) ||
    hasRawControl(value, KITTY_SHIFT_ENTER_STRIPPED) ||
    hasRawControl(value, XTERM_SHIFT_ENTER) ||
    hasRawControl(value, XTERM_SHIFT_ENTER_STRIPPED) ||
    hasRawControl(value, CSI_SHIFT_ENTER) ||
    hasRawControl(value, CSI_SHIFT_ENTER_STRIPPED)
  );
}

function isLineFeedTextInput(value: string, key: TuiInputKey) {
  return value.includes("\n") && key.return !== true;
}

function isLikelyShiftReturnFallback(value: string, key: TuiInputKey) {
  // Ink 7 parses CSI 13;2~ as an unnamed shifted function key, losing the raw sequence.
  return (
    value.length === 0 &&
    key.shift === true &&
    !key.ctrl &&
    !key.meta &&
    !key.tab &&
    !key.escape &&
    !key.upArrow &&
    !key.downArrow &&
    !key.leftArrow &&
    !key.rightArrow &&
    !key.home &&
    !key.end &&
    !key.backspace &&
    !key.delete
  );
}

function cleanComposerTextInput(value: string) {
  return value
    .replace(KITTY_QUERY_RESPONSE_RE, "")
    .replace(/\u001b\[13;2u/gu, "\n")
    .replace(/\[13;2u/gu, "\n")
    .replace(KITTY_MODIFIED_KEY_RE, "")
    .replace(XTERM_MODIFY_OTHER_KEYS_RE, (_match, modifier: string, keycode: string) => (modifier === "2" && keycode === "13" ? "\n" : ""))
    .replace(/\u001b\[13;2~/gu, "\n")
    .replace(/\[13;2~/gu, "\n")
    .replace(/\r/gu, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/gu, "");
}

function isOnlyTerminalProtocolResponse(value: string) {
  return value.length > 0 && cleanComposerTextInput(value).length === 0 && /^(?:\u001b)?\[\?\d+u$/u.test(value);
}

function isCtrlInput(value: string, key: TuiInputKey, char: string, controlCode: string) {
  const codePoint = char.codePointAt(0);
  return (
    (value.toLowerCase() === char && key.ctrl === true) ||
    hasRawControl(value, controlCode) ||
    (codePoint !== undefined && hasModifiedControlKey(value, codePoint))
  );
}

function hasModifiedControlKey(value: string, codePoint: number) {
  for (const match of value.matchAll(KITTY_MODIFIED_KEY_RE)) {
    const keyCode = Number(match[1]);
    const modifier = Number(match[2]?.split(":")[0]);
    if (keyCode === codePoint && hasCtrlModifier(modifier)) {
      return true;
    }
  }
  for (const match of value.matchAll(XTERM_MODIFY_OTHER_KEYS_RE)) {
    const modifier = Number(match[1]);
    const keyCode = Number(match[2]);
    if (keyCode === codePoint && hasCtrlModifier(modifier)) {
      return true;
    }
  }
  return false;
}

function hasCtrlModifier(modifier: number) {
  return Number.isFinite(modifier) && ((modifier - 1) & 4) !== 0;
}

export function useTuiInput(input: { state: OahReplState; exit: () => void }) {
  const state = input.state;

  useInput((value, key) => {
    logKeypressForDebug(value, key);

    if (isOnlyTerminalProtocolResponse(value)) {
      return;
    }

    if (isCtrlInput(value, key, "c", "\u0003")) {
      input.exit();
      return;
    }

    if (state.dialog) {
      handleDialogInput({ value, key, state });
      return;
    }

    handleComposerInput({ value, key, state, exit: input.exit });
  });
}

function logKeypressForDebug(value: string, key: TuiInputKey) {
  const path = process.env.OAH_TUI_KEYLOG;
  if (!path) {
    return;
  }
  try {
    appendFileSync(
      path,
      `${JSON.stringify({
        value,
        codepoints: Array.from(value).map((char) => char.codePointAt(0)?.toString(16).padStart(4, "0")),
        key
      })}\n`
    );
  } catch {
    // Debug logging must never affect interactive input.
  }
}

function handleDialogInput(input: { value: string; key: TuiInputKey; state: OahReplState }) {
  const { value, key, state } = input;
  const dialog = state.dialog;
  if (!dialog) {
    return;
  }

  if (key.escape) {
    if (dialog.kind === "workspace-create") {
      state.setDialog({ kind: "workspace-list", selectedIndex: 0 });
    } else if (dialog.kind === "session-create") {
      state.setDialog({ kind: "session-list", selectedIndex: 0 });
    } else {
      state.setDialog(null);
    }
    return;
  }
  if (dialog.kind === "help") {
    return;
  }
  if (dialog.kind === "memory") {
    handleMemoryDialogInput({ value, key, dialog, state });
    return;
  }
  if (dialog.kind === "workspace-create") {
    handleWorkspaceCreateInput({ value, key, dialog, state });
    return;
  }
  if (dialog.kind === "session-create") {
    handleSessionCreateInput({ value, key, dialog, state });
    return;
  }
  if (value === "n") {
    state.setDialog(
      dialog.kind === "workspace-list"
        ? createWorkspaceDialog(state.currentWorkspace?.runtime ?? state.runtimes[0]?.name, state.runtimes)
        : { kind: "session-create", draft: "" }
    );
    return;
  }
  if (value === "r") {
    if (dialog.kind === "workspace-list") {
      void state.refreshWorkspaces();
    } else {
      void state.refreshCurrentWorkspaceSessions();
    }
    return;
  }
  const cleanInput = cleanControlInput(value);
  const moveDelta = key.downArrow || cleanInput === "j" ? 1 : key.upArrow || cleanInput === "k" ? -1 : 0;
  if (moveDelta !== 0) {
    const length = dialog.kind === "workspace-list" ? state.workspaces.length : state.sessions.length;
    const selectedIndex = clampIndex(dialog.selectedIndex + moveDelta, length);
    if (isReturnInput(value, key)) {
      if (dialog.kind === "workspace-list") {
        const workspace = state.workspaces[selectedIndex];
        if (workspace) {
          void state.loadWorkspace(workspace);
        }
      } else {
        const session = state.sessions[selectedIndex];
        if (session) {
          state.selectSession(session);
        }
      }
    } else {
      state.setDialog({ ...dialog, selectedIndex });
    }
    return;
  }
  if (isReturnInput(value, key)) {
    if (dialog.kind === "workspace-list") {
      const workspace = state.workspaces[dialog.selectedIndex];
      if (workspace) {
        void state.loadWorkspace(workspace);
      }
    } else {
      const session = state.sessions[dialog.selectedIndex];
      if (session) {
        state.selectSession(session);
      }
    }
  }
}

function handleMemoryDialogInput(input: {
  value: string;
  key: TuiInputKey;
  dialog: Extract<Dialog, { kind: "memory" }>;
  state: OahReplState;
}) {
  const { dialog, key, state, value } = input;
  if (value === "r") {
    void state.refreshMemoryDialog();
    return;
  }
  if (value === "p") {
    state.setDialog({ ...dialog, mode: "proposals", selectedIndex: 0, detail: null });
    return;
  }
  if (value === "f") {
    state.setDialog({ ...dialog, mode: "files", selectedIndex: 0, detail: null });
    return;
  }
  if (value === "b" && dialog.mode === "detail") {
    state.setDialog({ ...dialog, mode: dialog.proposals.length > 0 ? "proposals" : "files", detail: null });
    return;
  }
  if (dialog.mode === "proposals" && value === "a") {
    void state.applyMemoryProposalSelection();
    return;
  }
  if (dialog.mode === "proposals" && value === "x") {
    void state.rejectMemoryProposalSelection();
    return;
  }
  const activeLength = dialog.mode === "proposals" ? dialog.proposals.length : dialog.mode === "files" ? dialog.files.length : 0;
  const cleanInput = cleanControlInput(value);
  const moveDelta = key.downArrow || cleanInput === "j" ? 1 : key.upArrow || cleanInput === "k" ? -1 : 0;
  if (moveDelta !== 0 && activeLength > 0) {
    state.setDialog({ ...dialog, selectedIndex: clampIndex(dialog.selectedIndex + moveDelta, activeLength) });
    return;
  }
  if (isReturnInput(value, key) && dialog.mode !== "detail") {
    void state.readMemorySelection();
  }
}

function handleWorkspaceCreateInput(input: {
  value: string;
  key: TuiInputKey;
  dialog: WorkspaceCreateDialog;
  state: OahReplState;
}) {
  const { dialog, key, state, value } = input;
  if (isCtrlInput(value, key, "u", "\u0015")) {
    state.setDialog(dialog.field === "runtime" ? { ...dialog, runtime: "", runtimeQuery: "", runtimeSelectedIndex: 0 } : { ...dialog, [dialog.field]: "" });
    return;
  }
  if (isCtrlInput(value, key, "r", "\u0012")) {
    void state.refreshRuntimes();
    return;
  }
  if (isTabInput(value, key)) {
    const nextDialog = dialog.field === "runtime" ? selectRuntimeCandidate(dialog, state.runtimes) : dialog;
    state.setDialog({ ...nextDialog, field: moveWorkspaceCreateField(dialog.field, 1) });
    return;
  }
  if (key.downArrow) {
    if (dialog.field === "runtime") {
      const matches = getRuntimeMatches(state.runtimes, dialog.runtimeQuery);
      state.setDialog({ ...dialog, runtimeSelectedIndex: clampIndex(dialog.runtimeSelectedIndex + 1, matches.length) });
      return;
    }
    state.setDialog({ ...dialog, field: moveWorkspaceCreateField(dialog.field, 1) });
    return;
  }
  if (key.upArrow) {
    if (dialog.field === "runtime") {
      const matches = getRuntimeMatches(state.runtimes, dialog.runtimeQuery);
      state.setDialog({ ...dialog, runtimeSelectedIndex: clampIndex(dialog.runtimeSelectedIndex - 1, matches.length) });
      return;
    }
    state.setDialog({ ...dialog, field: moveWorkspaceCreateField(dialog.field, -1) });
    return;
  }
  if (key.leftArrow && dialog.field === "runtime") {
    const runtime = cycleRuntime(dialog.runtime, state.runtimes, -1);
    const matches = getRuntimeMatches(state.runtimes, "");
    state.setDialog({ ...dialog, runtime, runtimeQuery: "", runtimeSelectedIndex: Math.max(0, matches.findIndex((item) => item.name === runtime)) });
    return;
  }
  if (key.rightArrow && dialog.field === "runtime") {
    const runtime = cycleRuntime(dialog.runtime, state.runtimes, 1);
    const matches = getRuntimeMatches(state.runtimes, "");
    state.setDialog({ ...dialog, runtime, runtimeQuery: "", runtimeSelectedIndex: Math.max(0, matches.findIndex((item) => item.name === runtime)) });
    return;
  }
  if (isReturnInput(value, key)) {
    const cleanInput = cleanControlInput(value);
    const nextDialog = dialog.field === "runtime" ? selectRuntimeCandidate(dialog, state.runtimes) : { ...dialog, [dialog.field]: `${dialog[dialog.field]}${cleanInput}` };
    if (dialog.field === "runtime" && (nextDialog.runtime !== dialog.runtime || nextDialog.runtimeQuery)) {
      state.setDialog(nextDialog);
      return;
    }
    void state.createWorkspace(nextDialog);
    return;
  }
  if (key.backspace || key.delete) {
    if (dialog.field === "runtime") {
      const runtimeQuery = dialog.runtimeQuery.slice(0, -1);
      state.setDialog({ ...dialog, runtimeQuery, runtimeSelectedIndex: getRuntimeSelectionIndex(dialog.runtime, state.runtimes, runtimeQuery) });
    } else {
      state.setDialog({ ...dialog, [dialog.field]: dialog[dialog.field].slice(0, -1) });
    }
    return;
  }
  if (value && !key.ctrl && !key.meta) {
    const cleanInput = cleanControlInput(value);
    if (cleanInput && dialog.field === "runtime") {
      const runtimeQuery = `${dialog.runtimeQuery}${cleanInput}`;
      state.setDialog({ ...dialog, runtimeQuery, runtimeSelectedIndex: getRuntimeSelectionIndex(dialog.runtime, state.runtimes, runtimeQuery) });
    } else if (cleanInput) {
      state.setDialog({ ...dialog, [dialog.field]: `${dialog[dialog.field]}${cleanInput}` });
    }
  }
}

function getRuntimeSelectionIndex(currentRuntime: string, runtimes: OahReplState["runtimes"], query: string) {
  const matches = getRuntimeMatches(runtimes, query);
  const currentIndex = matches.findIndex((runtime) => runtime.name === currentRuntime);
  return currentIndex >= 0 ? currentIndex : 0;
}

function selectRuntimeCandidate(dialog: WorkspaceCreateDialog, runtimes: OahReplState["runtimes"]): WorkspaceCreateDialog {
  const matches = getRuntimeMatches(runtimes, dialog.runtimeQuery);
  const candidate = matches[clampIndex(dialog.runtimeSelectedIndex, matches.length)];
  if (!candidate) {
    return dialog;
  }
  const runtimeSelectedIndex = Math.max(0, getRuntimeMatches(runtimes, "").findIndex((runtime) => runtime.name === candidate.name));
  return {
    ...dialog,
    runtime: candidate.name,
    runtimeQuery: "",
    runtimeSelectedIndex
  };
}

function handleSessionCreateInput(input: {
  value: string;
  key: TuiInputKey;
  dialog: Extract<Dialog, { kind: "session-create" }>;
  state: OahReplState;
}) {
  const { value, key, dialog, state } = input;
  if (isCtrlInput(value, key, "u", "\u0015")) {
    state.setDialog({ ...dialog, draft: "" });
    return;
  }
  if (isReturnInput(value, key)) {
    void state.createSession(`${dialog.draft}${cleanControlInput(value)}`);
    return;
  }
  if (key.backspace || key.delete) {
    state.setDialog({ ...dialog, draft: dialog.draft.slice(0, -1) });
    return;
  }
  if (value && !key.ctrl && !key.meta) {
    const cleanInput = cleanControlInput(value);
    if (cleanInput) {
      state.setDialog({ ...dialog, draft: `${dialog.draft}${cleanInput}` });
    }
  }
}

function handleComposerInput(input: { value: string; key: TuiInputKey; state: OahReplState; exit: () => void }) {
  const { value, key, state } = input;
  const askPrompt = latestAskUserQuestionPrompt(state.messages);
  if (askPrompt && !isAskUserQuestionSelectionCurrent(askPrompt, state.askUserQuestionSelection)) {
    state.setAskUserQuestionSelection(createAskUserQuestionSelection(askPrompt));
  } else if (!askPrompt && state.askUserQuestionSelection) {
    state.setAskUserQuestionSelection(null);
  }
  const slashMatches = getSlashCommandMatches(state.composer);
  const slashSuggestionsActive = slashMatches.length > 0;
  if (isCtrlInput(value, key, "w", "\u0017")) {
    state.setDialog({ kind: "workspace-list", selectedIndex: Math.max(0, state.workspaces.findIndex((item) => item.id === state.currentWorkspace?.id)) });
    return;
  }
  if (isCtrlInput(value, key, "o", "\u000f")) {
    state.setDialog({ kind: "session-list", selectedIndex: Math.max(0, state.sessions.findIndex((item) => item.id === state.currentSession?.id)) });
    return;
  }
  if (value === "?") {
    state.setDialog({ kind: "help" });
    return;
  }
  if (slashSuggestionsActive && (key.downArrow || value === "j")) {
    state.setSlashSelection((current) => clampIndex(current + 1, slashMatches.length));
    return;
  }
  if (slashSuggestionsActive && (key.upArrow || value === "k")) {
    state.setSlashSelection((current) => clampIndex(current - 1, slashMatches.length));
    return;
  }
  if (askPrompt && state.composer.trim().length === 0 && !slashSuggestionsActive) {
    const selection = isAskUserQuestionSelectionCurrent(askPrompt, state.askUserQuestionSelection)
      ? state.askUserQuestionSelection!
      : createAskUserQuestionSelection(askPrompt);
    if (key.downArrow || value === "j") {
      state.setAskUserQuestionSelection(moveAskUserQuestionSelection(askPrompt, selection, 1));
      return;
    }
    if (key.upArrow || value === "k") {
      state.setAskUserQuestionSelection(moveAskUserQuestionSelection(askPrompt, selection, -1));
      return;
    }
    if (value === " ") {
      state.setAskUserQuestionSelection(toggleAskUserQuestionSelection(askPrompt, selection));
      return;
    }
    if (key.leftArrow) {
      state.setAskUserQuestionSelection(moveAskUserQuestionQuestion(askPrompt, selection, -1));
      return;
    }
    if (key.rightArrow) {
      state.setAskUserQuestionSelection(moveAskUserQuestionQuestion(askPrompt, selection, 1));
      return;
    }
  }
  if (isShiftReturnInput(value, key)) {
    state.insertComposerInput(cleanComposerTextInput(value) || "\n");
    return;
  }
  if (isReturnInput(value, key)) {
    const cleanInput = cleanControlInput(value);
    if (cleanInput) {
      const nextComposer = insertTextAt(state.composer, state.composerCursor, cleanInput);
      if (nextComposer.trim() === "/quit") {
        input.exit();
        return;
      }
      state.setComposerValue(nextComposer);
      const askPrompt = latestAskUserQuestionPrompt(state.messages);
      const answer = askPrompt ? formatAskUserQuestionAnswer(askPrompt, nextComposer) : "";
      if (answer) {
        state.setAskUserQuestionSelection(null);
      }
      void state.sendComposer(answer || nextComposer);
    } else if (slashSuggestionsActive) {
      const selectedCommand = slashMatches[clampIndex(state.slashSelection, slashMatches.length)]?.command;
      if (selectedCommand === "/quit") {
        input.exit();
        return;
      }
      void state.sendComposer(selectedCommand ?? state.composer);
    } else {
      if (state.composer.trim() === "/quit") {
        input.exit();
        return;
      }
      const askPrompt = latestAskUserQuestionPrompt(state.messages);
      let selection =
        askPrompt && isAskUserQuestionSelectionCurrent(askPrompt, state.askUserQuestionSelection)
          ? state.askUserQuestionSelection
          : askPrompt
            ? createAskUserQuestionSelection(askPrompt)
            : null;
      if (askPrompt && selection) {
        selection = selectFocusedAskUserQuestionOption(askPrompt, selection);
      }
      const answer =
        askPrompt && state.composer.trim().length === 0 && selection
          ? formatAskUserQuestionSelectionAnswer(askPrompt, selection)
          : askPrompt
            ? formatAskUserQuestionAnswer(askPrompt, state.composer)
            : "";
      if (answer) {
        state.setAskUserQuestionSelection(null);
      }
      void state.sendComposer(answer || undefined);
    }
    return;
  }
  if (isTabInput(value, key) && state.composer.startsWith("/")) {
    const match = slashMatches[clampIndex(state.slashSelection, slashMatches.length)];
    if (match) {
      state.setComposerValue(match.command);
    }
    return;
  }
  if (key.leftArrow) {
    state.setComposerCursor((current) => Math.max(0, current - 1));
    return;
  }
  if (key.rightArrow) {
    state.setComposerCursor((current) => Math.min(state.composer.length, current + 1));
    return;
  }
  if (key.home) {
    state.setComposerCursor(0);
    return;
  }
  if (key.end) {
    state.setComposerCursor(state.composer.length);
    return;
  }
  if (isCtrlInput(value, key, "a", "\u0001")) {
    state.setComposerCursor(0);
    return;
  }
  if (isCtrlInput(value, key, "e", "\u0005")) {
    state.setComposerCursor(state.composer.length);
    return;
  }
  if (isCtrlInput(value, key, "u", "\u0015")) {
    state.setComposerValue("");
    return;
  }
  if (key.backspace || key.delete) {
    state.deleteComposerInput();
    return;
  }
  if (value && !key.ctrl && !key.meta) {
    const cleanInput = cleanComposerTextInput(value);
    if (cleanInput) {
      state.insertComposerInput(cleanInput);
    }
  }
}
