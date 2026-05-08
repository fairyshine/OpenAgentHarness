import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock3,
  Cpu,
  ListTodo,
  Loader2,
  MessageSquare,
  Radio,
  RefreshCw,
  Send,
  Sparkles,
  SquareTerminal,
  UserRound,
  X
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { SessionTerminalSnapshot } from "@oah/api-contracts";

import { useSessionAgentStore } from "../stores/session-agent-store";
import { useStreamStore } from "../stores/stream-store";
import { statusTone, toneBadgeClass } from "../support";
import type { ConversationTerminalState, ConversationTodoProgress, RuntimeProps, TodoStatus } from "./conversation-model";
import { AUTO_SESSION_MODEL_VALUE, sessionAgentLabel } from "./conversation-model";

type ConversationStatusBarProps = {
  hasActiveSession: boolean;
  isRunning: boolean;
  messagesCount: number;
  todoProgress: ConversationTodoProgress | null;
  terminalStates: ConversationTerminalState[];
  onOpenTerminal: (terminalId?: string | undefined) => void;
  session: RuntimeProps["session"];
  workspace: RuntimeProps["workspace"];
  workspaceId: RuntimeProps["workspaceId"];
  catalog: RuntimeProps["catalog"];
  sessionRuns: RuntimeProps["sessionRuns"];
  isSwitchingSessionAgent: RuntimeProps["isSwitchingSessionAgent"];
  switchSessionAgent: RuntimeProps["switchSessionAgent"];
  isSwitchingSessionModel: RuntimeProps["isSwitchingSessionModel"];
  updateSessionModel: RuntimeProps["updateSessionModel"];
};

function TodoProgressIcon({ status }: { status: TodoStatus }) {
  if (status === "completed") {
    return (
      <span className="mt-px inline-flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-full bg-foreground/34 text-background">
        <CheckCircle2 className="h-3.5 w-3.5" />
      </span>
    );
  }

  if (status === "in_progress") {
    return (
      <span
        className="mt-px inline-flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-full border bg-background/72 text-foreground/72 shadow-[inset_0_1px_0_rgba(255,255,255,0.42)]"
        style={{
          borderColor: "color-mix(in srgb, var(--foreground) 14%, transparent)"
        }}
      >
        <Loader2 className="h-3 w-3 animate-spin" />
      </span>
    );
  }

  return (
    <span className="mt-px inline-flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-full text-foreground/36">
      <Circle className="h-[18px] w-[18px]" />
    </span>
  );
}

function CollapsibleStatusSection({
  title,
  icon,
  summary,
  children,
  defaultExpanded = true
}: {
  title: string;
  icon: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <section className="space-y-2">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-center justify-between gap-3 rounded-xl px-1 py-0.5 text-left transition hover:bg-foreground/[0.035]"
        aria-expanded={expanded}
      >
        <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-muted-foreground/76">
          <span className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center">{icon}</span>
          <span className="min-w-0 truncate">{title}</span>
        </span>
        <span className="flex flex-shrink-0 items-center gap-2">
          {summary ? (
            <span className="rounded-full border border-foreground/8 bg-background/45 px-2 py-0.5 text-[11px] font-medium text-muted-foreground/72">
              {summary}
            </span>
          ) : null}
          <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground/52 transition-transform ${expanded ? "rotate-90" : ""}`} />
        </span>
      </button>
      {expanded ? <div className="space-y-1.5">{children}</div> : null}
    </section>
  );
}

function TodoProgressPanel({ progress }: { progress: ConversationTodoProgress }) {
  const visibleItems = progress.items.slice(0, 6);
  const hiddenCount = Math.max(0, progress.items.length - visibleItems.length);
  const progressLabel = `${progress.completedCount}/${progress.items.length}`;

  return (
    <CollapsibleStatusSection title="进度" icon={<ListTodo className="h-3.5 w-3.5" />} summary={progressLabel}>
      <div className="space-y-1">
        {visibleItems.map((item, index) => {
          const isActive = item.status === "in_progress";
          return (
            <div
              key={`${item.status}:${item.content}:${index}`}
              className={`grid grid-cols-[1.125rem_minmax(0,1fr)] items-start gap-2 rounded-xl border px-2 py-1.5 transition ${
                isActive ? "shadow-[inset_0_1px_0_rgba(255,255,255,0.44)]" : "border-transparent"
              }`}
              style={
                isActive
                  ? {
                      background: "color-mix(in srgb, var(--foreground) 4%, transparent)",
                      borderColor: "color-mix(in srgb, var(--foreground) 8%, transparent)"
                    }
                  : undefined
              }
            >
              <TodoProgressIcon status={item.status} />
              <span
                className={`min-w-0 flex-1 text-[12.5px] ${
                  item.status === "completed"
                    ? "leading-5 text-muted-foreground/70"
                    : isActive
                      ? "font-medium leading-5 text-foreground/86"
                      : "leading-5 text-muted-foreground/78"
                }`}
              >
                {isActive && item.activeForm ? item.activeForm : item.content}
              </span>
            </div>
          );
        })}
        {hiddenCount > 0 ? (
          <div className="pl-8 text-[11px] font-medium text-muted-foreground/62">
            另有 {hiddenCount} 项
          </div>
        ) : null}
      </div>
    </CollapsibleStatusSection>
  );
}

function ConversationDetailRow({
  icon,
  label,
  value,
  valueClassName = "text-muted-foreground/78"
}: {
  icon: ReactNode;
  label: ReactNode;
  value?: ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2.5 text-[13px] font-medium text-foreground/74">
        <span className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center text-foreground/58">{icon}</span>
        <span className="min-w-0 truncate">{label}</span>
      </div>
      {value ? (
        <div className={`flex-shrink-0 text-right text-[13px] font-medium ${valueClassName}`}>
          {value}
        </div>
      ) : null}
    </div>
  );
}

function ConversationCompactControlRow({
  icon,
  label,
  children
}: {
  icon: ReactNode;
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2.5 text-[13px] font-medium text-foreground/74">
        <span className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center text-foreground/58">{icon}</span>
        <span className="min-w-0 truncate">{label}</span>
      </div>
      <div className="min-w-0 flex-1 max-w-[190px]">{children}</div>
    </div>
  );
}

export function TerminalInteractionDialog({
  open,
  onOpenChange,
  sessionId,
  terminalStates,
  initialTerminalId,
  refreshSessionTerminal,
  sendSessionTerminalInput
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  terminalStates: ConversationTerminalState[];
  initialTerminalId?: string | undefined;
  refreshSessionTerminal: RuntimeProps["refreshSessionTerminal"];
  sendSessionTerminalInput: RuntimeProps["sendSessionTerminalInput"];
}) {
  const [selectedTerminalId, setSelectedTerminalId] = useState(initialTerminalId ?? terminalStates[0]?.terminalId ?? "");
  const [snapshot, setSnapshot] = useState<SessionTerminalSnapshot | null>(null);
  const [inputText, setInputText] = useState("");
  const [appendNewline, setAppendNewline] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState("");
  const outputRef = useRef<HTMLPreElement | null>(null);
  const selectedFallbackState = terminalStates.find((terminal) => terminal.terminalId === selectedTerminalId) ?? terminalStates[0];
  const outputText = snapshot?.output ?? selectedFallbackState?.output ?? "";
  const status = snapshot?.status ?? selectedFallbackState?.status ?? "unknown";
  const inputWritable = snapshot?.inputWritable ?? selectedFallbackState?.inputWritable ?? status === "running";

  useEffect(() => {
    if (!open) {
      return;
    }

    setSelectedTerminalId(initialTerminalId ?? terminalStates[0]?.terminalId ?? "");
  }, [initialTerminalId, open, terminalStates]);

  const refreshTerminal = useCallback(async () => {
    if (!open || !sessionId || !selectedTerminalId) {
      return;
    }

    try {
      const nextSnapshot = await refreshSessionTerminal(sessionId, selectedTerminalId);
      setSnapshot(nextSnapshot);
      setErrorText("");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "Failed to refresh terminal output.");
    }
  }, [open, refreshSessionTerminal, selectedTerminalId, sessionId]);

  useEffect(() => {
    void refreshTerminal();
  }, [refreshTerminal]);

  useEffect(() => {
    if (!open || !selectedTerminalId || status !== "running") {
      return;
    }

    const timer = window.setInterval(() => {
      void refreshTerminal();
    }, 1500);
    return () => {
      window.clearInterval(timer);
    };
  }, [open, refreshTerminal, selectedTerminalId, status]);

  useEffect(() => {
    const element = outputRef.current;
    if (!element) {
      return;
    }

    element.scrollTop = element.scrollHeight;
  }, [outputText]);

  const submitInput = useCallback(async () => {
    if (!sessionId || !selectedTerminalId || inputText.length === 0) {
      return;
    }

    setBusy(true);
    try {
      await sendSessionTerminalInput({
        sessionId,
        terminalId: selectedTerminalId,
        input: inputText,
        appendNewline
      });
      setInputText("");
      await refreshTerminal();
      setErrorText("");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "Failed to send terminal input.");
    } finally {
      setBusy(false);
    }
  }, [appendNewline, inputText, refreshTerminal, selectedTerminalId, sendSessionTerminalInput, sessionId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[86vh] w-[min(100vw-2rem,900px)] max-w-none gap-4 overflow-hidden rounded-2xl p-0" showCloseButton={false}>
        <div className="flex items-start justify-between gap-3 border-b border-border/60 px-5 py-4">
          <DialogHeader className="min-w-0 space-y-1">
            <DialogTitle className="flex items-center gap-2 text-base">
              <SquareTerminal className="h-4 w-4 text-muted-foreground" />
              Terminal
            </DialogTitle>
            <DialogDescription className="truncate">
              {selectedTerminalId || "No terminal selected"}
              {snapshot?.outputPath ? ` · ${snapshot.outputPath}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-shrink-0 items-center gap-2">
            {terminalStates.length > 1 ? (
              <Select value={selectedTerminalId} onValueChange={setSelectedTerminalId}>
                <SelectTrigger className="h-8 w-48 rounded-xl text-xs" size="sm" aria-label="Terminal">
                  <SelectValue placeholder="Select terminal" />
                </SelectTrigger>
                <SelectContent>
                  {terminalStates.map((terminal) => (
                    <SelectItem key={terminal.terminalId} value={terminal.terminalId}>
                      {terminal.terminalId} · {terminal.status ?? "open"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Button variant="outline" size="sm" className="h-8 rounded-xl px-3 text-xs" onClick={refreshTerminal} disabled={!selectedTerminalId}>
              {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
              刷新
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" onClick={() => onOpenChange(false)} title="Close terminal">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 gap-3 px-5 pb-5">
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium text-muted-foreground">
            <span className={`rounded-full border px-2 py-0.5 ${status === "running" ? toneBadgeClass("emerald") : "border-border/60 bg-muted/60"}`}>
              {status}
            </span>
            {snapshot?.terminalKind ? <span>{snapshot.terminalKind}</span> : null}
            {snapshot?.pid ? <span>pid {snapshot.pid}</span> : null}
            {snapshot?.truncated ? <span>output truncated</span> : null}
          </div>

          <pre
            ref={outputRef}
            className="min-h-[360px] max-h-[56vh] overflow-auto rounded-2xl border border-border/70 bg-[rgb(14,15,17)] px-4 py-3 font-mono text-xs leading-5 text-zinc-100 shadow-inner"
          >
            {outputText || "(no output)"}
          </pre>

          {errorText ? (
            <div className="rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {errorText}
            </div>
          ) : null}

          <div className="flex items-end gap-2">
            <Textarea
              value={inputText}
              onChange={(event) => setInputText(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  void submitInput();
                }
              }}
              disabled={!inputWritable || busy}
              placeholder={inputWritable ? "输入要发送到 terminal 的内容，⌘/Ctrl+Enter 发送" : "Terminal stdin 当前不可用"}
              rows={2}
              className="min-h-14 resize-none rounded-2xl bg-background/80 text-sm"
            />
            <div className="flex flex-col gap-2">
              <label className="flex select-none items-center gap-2 rounded-xl border border-border/60 bg-background/70 px-2 py-1.5 text-[11px] font-medium text-muted-foreground">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5"
                  checked={appendNewline}
                  onChange={(event) => setAppendNewline(event.target.checked)}
                />
                newline
              </label>
              <Button className="h-9 rounded-xl px-4 text-xs" onClick={submitInput} disabled={!inputWritable || busy || inputText.length === 0}>
                {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}
                发送
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export const ConversationStatusBar = memo(function ConversationStatusBar(props: ConversationStatusBarProps) {
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const run = useStreamStore((state) => state.run);
  const pendingSessionAgentName = useSessionAgentStore((state) => state.pendingSessionAgentName);
  const pendingSessionModelRef = useSessionAgentStore((state) => state.pendingSessionModelRef);
  const sessionWorkspaceCatalog =
    props.session && (props.workspace?.id === props.session.workspaceId || props.workspaceId === props.session.workspaceId)
      ? props.catalog
      : null;
  const selectedAgentName = pendingSessionAgentName ?? props.session?.activeAgentName ?? run?.effectiveAgentName ?? "";
  const visibleSessionAgents = [...new Map(
    (sessionWorkspaceCatalog?.agents ?? [])
      .filter((agent) => agent.mode === "primary" || agent.mode === "all")
      .sort((left, right) => {
        if (left.source === right.source) {
          return left.name.localeCompare(right.name);
        }

        return left.source === "workspace" ? -1 : 1;
      })
      .map((agent) => [agent.name, agent] as const)
  ).values()];
  const selectedAgent = visibleSessionAgents.find((agent) => agent.name === selectedAgentName);
  const selectedAgentValue = selectedAgent?.name;
  const agentSelectorSession = visibleSessionAgents.length > 0 && props.session ? props.session : null;
  const selectedAgentSelectValue = selectedAgentValue ?? agentSelectorSession?.activeAgentName ?? visibleSessionAgents[0]?.name;
  const sessionModelOptions = [
    ...new Map(
      (sessionWorkspaceCatalog?.models ?? [])
        .map((model) => [model.ref, model] as const)
        .concat(
          props.session?.modelRef
            ? [
                [
                  props.session.modelRef,
                  {
                    ref: props.session.modelRef,
                    name: props.session.modelRef.replace(/^(platform|workspace)\//, ""),
                    source: props.session.modelRef.startsWith("workspace/") ? "workspace" : "platform",
                    provider: "custom"
                  }
                ] as const
              ]
            : []
        )
    ).values()
  ].sort((left, right) => {
    if (left.source === right.source) {
      return left.name.localeCompare(right.name);
    }

    return left.source === "workspace" ? -1 : 1;
  });
  const selectedSessionModelValue = pendingSessionModelRef ?? props.session?.modelRef ?? AUTO_SESSION_MODEL_VALUE;
  const selectedSessionModelLabel =
    selectedSessionModelValue === AUTO_SESSION_MODEL_VALUE
      ? "Auto"
      : (sessionModelOptions.find((model) => model.ref === selectedSessionModelValue)?.name ?? selectedSessionModelValue);
  const sessionModelLocked =
    props.messagesCount > 0 ||
    props.sessionRuns.length > 0 ||
    (run?.sessionId != null && run.sessionId === props.session?.id) ||
    props.isRunning;
  const runStatusLabel = props.isRunning ? "运行中" : run?.status ? run.status : "idle";
  const statusDetail = props.isSwitchingSessionAgent
    ? "正在更新 Agent"
    : props.isSwitchingSessionModel
      ? "正在更新模型"
      : props.isRunning
        ? "设置会在下一轮生效"
        : null;
  const collapsedSummary = props.todoProgress
    ? `${props.todoProgress.completedCount}/${props.todoProgress.items.length}`
    : runStatusLabel;
  const collapsedSummaryTone = props.todoProgress
    ? "border-foreground/8 bg-background/45 text-muted-foreground/72"
    : props.isRunning
      ? toneBadgeClass("amber")
      : run?.status
        ? statusTone(run.status)
        : "border-border/60 bg-muted/60 text-muted-foreground";
  const latestTerminal = props.terminalStates[0];

  if (!props.hasActiveSession) {
    return null;
  }

  if (panelCollapsed) {
    return (
      <div className="pointer-events-none absolute right-3 top-3 z-30 flex items-start justify-end md:right-5 md:top-5">
        <button
          type="button"
          onClick={() => setPanelCollapsed(false)}
          className="pointer-events-auto inline-flex max-w-[min(calc(100vw-1.5rem),180px)] items-center gap-2 rounded-full border px-2.5 py-2 text-left shadow-[0_14px_30px_-24px_rgba(17,17,17,0.45)] backdrop-blur-xl transition hover:bg-background/92"
          style={{
            background: "color-mix(in srgb, var(--background) 84%, transparent)",
            borderColor: "color-mix(in srgb, var(--foreground) 9%, transparent)",
            boxShadow:
              "inset 0 1px 0 rgba(255,255,255,0.54), 0 14px 30px -24px rgba(17,17,17,0.45)"
          }}
          title="展开会话状态"
          aria-label="展开会话状态"
        >
          {props.isRunning ? (
            <Radio className="h-3.5 w-3.5 flex-shrink-0 animate-pulse text-muted-foreground/72" />
          ) : (
            <Clock3 className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/72" />
          )}
          <span className={`flex-shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${collapsedSummaryTone}`}>
            {collapsedSummary}
          </span>
          <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 rotate-180 text-muted-foreground/52" />
        </button>
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute right-3 top-3 z-30 flex items-start justify-end md:right-5 md:top-5">
      <div
        className="pointer-events-auto max-h-[calc(100vh-9rem)] w-[min(calc(100vw-1.5rem),330px)] overflow-y-auto rounded-[20px] border px-3.5 py-3.5 shadow-[0_18px_40px_-30px_rgba(17,17,17,0.45)] backdrop-blur-xl md:w-[320px]"
        style={{
          background: "color-mix(in srgb, var(--background) 84%, transparent)",
          borderColor: "color-mix(in srgb, var(--foreground) 9%, transparent)",
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.54), 0 18px 40px -30px rgba(17,17,17,0.45)"
        }}
      >
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3 rounded-xl px-1 py-0.5">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground/76">
                <span className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center">
                  {props.isRunning ? <Radio className="h-3.5 w-3.5 animate-pulse" /> : <Clock3 className="h-3.5 w-3.5" />}
                </span>
                <span>会话状态</span>
              </div>
              {statusDetail ? <div className="mt-1 truncate pl-6 text-[12px] font-medium text-muted-foreground/68">{statusDetail}</div> : null}
            </div>
            <div className="flex flex-shrink-0 items-center gap-1.5">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                  props.isRunning ? toneBadgeClass("amber") : run?.status ? statusTone(run.status) : "border-border/60 bg-muted/60 text-muted-foreground"
                }`}
              >
                {props.isRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                {runStatusLabel}
              </span>
              <button
                type="button"
                onClick={() => setPanelCollapsed(true)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-foreground/8 bg-background/42 text-muted-foreground/62 transition hover:bg-background/78 hover:text-foreground/78"
                title="收起浮窗"
                aria-label="收起浮窗"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {props.todoProgress ? <TodoProgressPanel progress={props.todoProgress} /> : null}

          {props.todoProgress ? <div className="h-px bg-border/60" /> : null}

          {latestTerminal ? (
            <>
              <button
                type="button"
                onClick={() => props.onOpenTerminal(latestTerminal.terminalId)}
                className="flex w-full items-center justify-between gap-3 rounded-xl border border-foreground/8 bg-background/38 px-3 py-2 text-left transition hover:bg-background/70"
              >
                <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-foreground/76">
                  <SquareTerminal className="h-4 w-4 flex-shrink-0 text-foreground/58" />
                  <span className="min-w-0 truncate">Terminal</span>
                </span>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[11px] font-medium text-muted-foreground/72">
                    {latestTerminal.terminalId}
                  </span>
                  <span className="rounded-full border border-foreground/8 bg-background/52 px-2 py-0.5 text-[11px] font-medium text-muted-foreground/72">
                    {latestTerminal.status ?? "open"}
                  </span>
                </span>
              </button>
              <div className="h-px bg-border/60" />
            </>
          ) : null}

          <CollapsibleStatusSection
            title="会话详情"
            icon={<Sparkles className="h-3.5 w-3.5" />}
            summary={props.session ? "设置" : runStatusLabel}
          >
            <ConversationDetailRow
              icon={<MessageSquare className="h-4 w-4" />}
              label="消息"
              value={props.messagesCount.toLocaleString()}
              valueClassName="text-foreground/70"
            />

            <div className="space-y-2 pt-0.5">
              <ConversationCompactControlRow icon={<Cpu className="h-4 w-4" />} label="模型">
                <Select
                  value={selectedSessionModelValue}
                  disabled={!props.session || props.isSwitchingSessionModel || sessionModelLocked}
                  onValueChange={(value) => {
                    if (!props.session) {
                      return;
                    }

                    const nextModelRef = value === AUTO_SESSION_MODEL_VALUE ? null : value;
                    const currentModelRef = props.session.modelRef ?? null;
                    if (nextModelRef !== currentModelRef) {
                      props.updateSessionModel(props.session.id, nextModelRef);
                    }
                  }}
                >
                  <SelectTrigger className="h-8 w-full rounded-xl border-foreground/10 bg-background/52 text-xs shadow-none [&>span]:truncate" size="sm" aria-label="Session model">
                    <SelectValue placeholder="Select model">{selectedSessionModelLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AUTO_SESSION_MODEL_VALUE}>Auto · workspace / agent default</SelectItem>
                    {sessionModelOptions.map((model) => (
                      <SelectItem key={model.ref} value={model.ref}>
                        {model.name} · {model.source} · {model.provider}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </ConversationCompactControlRow>

              <ConversationCompactControlRow icon={<UserRound className="h-4 w-4" />} label="Agent">
                {agentSelectorSession ? (
                  <Select
                    value={selectedAgentSelectValue ?? ""}
                    disabled={props.isSwitchingSessionAgent}
                    onValueChange={(value) => {
                      if (value !== agentSelectorSession.activeAgentName) {
                        props.switchSessionAgent(agentSelectorSession.id, value);
                      }
                    }}
                  >
                    <SelectTrigger className="h-8 w-full rounded-xl border-foreground/10 bg-background/52 text-xs shadow-none [&>span]:truncate" size="sm" aria-label="Session agent">
                      <SelectValue placeholder="Select agent">
                        {selectedAgent?.name ?? (selectedAgentName || "no agent")}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {visibleSessionAgents.map((agent) => (
                        <SelectItem key={agent.name} value={agent.name}>
                          {sessionAgentLabel(agent)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="truncate rounded-xl border border-foreground/10 bg-background/38 px-3 py-2 text-xs font-medium text-muted-foreground/72">
                    {selectedAgentName || "no agent"}
                  </div>
                )}
              </ConversationCompactControlRow>
            </div>
            {statusDetail ? <p className="text-xs leading-5 text-muted-foreground/62">{statusDetail}</p> : null}
          </CollapsibleStatusSection>
        </div>
      </div>
    </div>
  );
});

