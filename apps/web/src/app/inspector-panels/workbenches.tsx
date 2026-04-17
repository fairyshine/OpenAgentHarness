import { useEffect, useState, type ReactNode } from "react";
import { CircleSlash2, Download } from "lucide-react";

import type {
  Message,
  Run,
  RunStep,
  Session,
  SessionEventContract,
  Workspace,
  WorkspaceCatalog
} from "@oah/api-contracts";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";

import {
  contentText,
  countMessagesByRole,
  formatTimestamp,
  prettyJson,
  statusTone,
  type ModelCallTrace,
  type ModelCallTraceMessage,
  type ModelCallTraceRuntimeTool,
  type ModelCallTraceToolServer
} from "../support";
import {
  buildStructuredActionInput,
  deriveStructuredActionInputSpec,
  initializeStructuredActionInputValues
} from "../action-input-form";
import {
  CatalogLine,
  compactPreviewText,
  EmptyState,
  EntityPreview,
  InsightRow,
  InspectorTabButton,
  JsonBlock,
  PayloadValueView,
  modelMessageTone
} from "../primitives";

import {
  ACTION_INPUT_UNSET_VALUE,
  DetailSection,
  InspectorDisclosure,
  InspectorPanelHeader,
  MessageContentDetail,
  MessageToolRefChips,
  TimelineListButton,
  ToolNameChips,
  ToolSnapshotBrowser,
  TraceSummaryStat
} from "./shared";
import { LlmSummaryCard, ModelCallTraceCard } from "./cards";

function ContextWorkbench(props: {
  systemMessages: ModelCallTraceMessage[];
  firstTrace: ModelCallTrace | null;
  messages: Message[];
  selectedMessage: Message | null;
  onSelectMessage: (messageId: string) => void;
}) {
  const combinedSystemPrompt = props.systemMessages.map((message) => contentText(message.content)).join("\n\n");

  return (
    <section className="space-y-3">
      <section className="ob-section space-y-3 rounded-[16px] p-4">
        <InspectorPanelHeader
          title="System Prompt"
          description="这里显示真正发给模型的合成后 system prompt。当前 runtime 会把多个 system message 用空行连接后发送。"
        />
        <div className="grid gap-2 sm:grid-cols-3">
          <InsightRow label="Source Step" value={props.firstTrace ? `step ${props.firstTrace.seq}` : "n/a"} />
          <InsightRow label="Message Count" value={String(props.systemMessages.length)} />
          <InsightRow label="Characters" value={String(combinedSystemPrompt.length)} />
        </div>
        {combinedSystemPrompt.length === 0 ? (
          <EmptyState title="No system prompt" description="Load a run with model calls to inspect the composed system prompt." />
        ) : (
          <div className="ob-subsection rounded-[14px] p-4">
            <pre className="max-h-[24rem] overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-foreground/80">{combinedSystemPrompt}</pre>
          </div>
        )}
      </section>

      <div className="grid gap-3 2xl:grid-cols-[minmax(360px,0.78fr)_minmax(0,1.22fr)]">
        <section className="ob-section space-y-3 rounded-[16px] p-4">
          <InspectorPanelHeader
            title="Session Message Timeline"
            description="左侧先定位一条消息，再在右侧看完整内容、metadata 和关联 run/tool 信息。"
          />
          <div className="space-y-2">
            {props.messages.length === 0 ? (
              <EmptyState title="No messages" description="Open a session to inspect stored message records." />
            ) : (
              props.messages.map((message) => (
                <button
                  key={message.id}
                  className={cn(
                    "w-full rounded-[16px] p-3 text-left transition",
                    props.selectedMessage?.id === message.id
                      ? "border border-border bg-muted/60"
                      : "info-panel info-panel-hoverable"
                  )}
                  onClick={() => props.onSelectMessage(message.id)}
                >
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Badge>{message.role}</Badge>
                    {message.runId ? <Badge>{message.runId}</Badge> : null}
                    <MessageToolRefChips content={message.content} />
                    <span className="text-xs text-muted-foreground">{formatTimestamp(message.createdAt)}</span>
                  </div>
                  <p className="text-sm leading-6 text-foreground">{compactPreviewText(message.content)}</p>
                </button>
              ))
            )}
          </div>
        </section>

        <section className="ob-section space-y-3 rounded-[16px] p-4">
          <InspectorPanelHeader
            title="Message Detail"
            description="查看当前选中消息的完整正文、metadata，以及与 run / tool 的关联字段。"
          />
          {props.selectedMessage ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Badge>{props.selectedMessage.role}</Badge>
                {props.selectedMessage.runId ? <Badge>{props.selectedMessage.runId}</Badge> : null}
                <MessageToolRefChips content={props.selectedMessage.content} />
                <Badge>{formatTimestamp(props.selectedMessage.createdAt)}</Badge>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <InsightRow label="Message ID" value={props.selectedMessage.id} />
                <InsightRow label="Session ID" value={props.selectedMessage.sessionId} />
              </div>
              <div className="ob-subsection rounded-[14px] p-4">
                <MessageContentDetail content={props.selectedMessage.content} maxHeightClassName="max-h-[28rem]" />
              </div>
              {props.selectedMessage.metadata ? <JsonBlock title="Metadata" value={props.selectedMessage.metadata} /> : null}
            </>
          ) : (
            <EmptyState title="No message selected" description="Choose a message from the left timeline to inspect its full detail." />
          )}
        </section>
      </div>
    </section>
  );
}

function CallsWorkbench(props: {
  traces: ModelCallTrace[];
  selectedTrace: ModelCallTrace | null;
  onSelectTrace: (traceId: string) => void;
  latestTrace: ModelCallTrace | null;
  latestModelMessageCounts: ReturnType<typeof countMessagesByRole>;
  resolvedModelNames: string[];
  resolvedModelRefs: string[];
  runtimeTools: ModelCallTraceRuntimeTool[];
  runtimeToolNames: string[];
  activeToolNames: string[];
  toolServers: ModelCallTraceToolServer[];
  onDownload: () => void;
}) {
  return (
    <div className="grid gap-3 2xl:grid-cols-[minmax(360px,0.78fr)_minmax(0,1.22fr)]">
      <div className="space-y-3">
        <LlmSummaryCard
          modelCallCount={props.traces.length}
          latestTrace={props.latestTrace}
          latestModelMessageCounts={props.latestModelMessageCounts}
          resolvedModelNames={props.resolvedModelNames}
          resolvedModelRefs={props.resolvedModelRefs}
          runtimeTools={props.runtimeTools}
          runtimeToolNames={props.runtimeToolNames}
          activeToolNames={props.activeToolNames}
          toolServers={props.toolServers}
          onDownload={props.onDownload}
        />
        <section className="ob-section space-y-3 rounded-[16px] p-4">
          <InspectorPanelHeader
            title="Model Call List"
            description="左侧先定位一次调用，右侧再看这次调用的完整 message list、tool 调用和原始 payload。"
          />
          {props.traces.length === 0 ? (
            <EmptyState title="No model calls" description="Load run steps to inspect model-facing calls." />
          ) : (
            <div className="space-y-2">
              {props.traces.map((trace) => (
                <button
                  key={trace.id}
                  className={cn(
                    "w-full rounded-[16px] p-3 text-left transition",
                    props.selectedTrace?.id === trace.id
                      ? "border border-border bg-muted/60"
                      : "info-panel info-panel-hoverable"
                  )}
                  onClick={() => props.onSelectTrace(trace.id)}
                >
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Badge>{`step ${trace.seq}`}</Badge>
                    <Badge>{trace.input.model ?? "n/a"}</Badge>
                    <Badge className={statusTone(trace.status)}>{trace.status}</Badge>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <p className="text-xs text-muted-foreground">
                      {trace.output.toolCalls.length} tool calls · {trace.output.toolResults.length} tool results
                    </p>
                    <p className="text-xs text-muted-foreground">{trace.output.finishReason ?? "finish n/a"}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="space-y-3">
        {props.selectedTrace ? (
          <ModelCallTraceCard trace={props.selectedTrace} />
        ) : (
          <EmptyState title="No model call selected" description="Choose a model call from the left list to inspect its full detail." />
        )}
      </div>
    </div>
  );
}

function TimelineWorkbench(props: {
  mode: "all" | "execution" | "messages" | "calls" | "steps" | "events";
  onModeChange: (mode: "all" | "execution" | "messages" | "calls" | "steps" | "events") => void;
  systemMessages: ModelCallTraceMessage[];
  selectedMessageSystemMessages: ModelCallTraceMessage[];
  firstTrace: ModelCallTrace | null;
  messages: Message[];
  selectedMessage: Message | null;
  onSelectMessage: (messageId: string) => void;
  traces: ModelCallTrace[];
  selectedTrace: ModelCallTrace | null;
  onSelectTrace: (traceId: string) => void;
  latestTrace: ModelCallTrace | null;
  latestModelMessageCounts: ReturnType<typeof countMessagesByRole>;
  resolvedModelNames: string[];
  resolvedModelRefs: string[];
  runtimeTools: ModelCallTraceRuntimeTool[];
  runtimeToolNames: string[];
  activeToolNames: string[];
  toolServers: ModelCallTraceToolServer[];
  onDownload: () => void;
  steps: RunStep[];
  selectedStep: RunStep | null;
  onSelectStep: (stepId: string) => void;
  events: SessionEventContract[];
  selectedEvent: SessionEventContract | null;
  onSelectEvent: (eventId: string) => void;
}) {
  const [activeItemKey, setActiveItemKey] = useState("");
  const normalizeTimelineSortValue = (value: number) => (Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER);
  const timelineSecondBucket = (value: number) =>
    Number.isFinite(value) ? Math.floor(value / 1000) : Number.MAX_SAFE_INTEGER;
  const compareTimelineItems = <
    T extends
      | { key: string; kind: "message"; sortValue: number }
      | { key: string; kind: "call"; sortValue: number; trace: ModelCallTrace }
      | { key: string; kind: "step"; sortValue: number; step: RunStep }
      | { key: string; kind: "event"; sortValue: number }
  >(
    left: T,
    right: T
  ) => {
    const leftTime = normalizeTimelineSortValue(left.sortValue);
    const rightTime = normalizeTimelineSortValue(right.sortValue);
    const leftSeq = left.kind === "call" ? left.trace.seq : left.kind === "step" ? left.step.seq : undefined;
    const rightSeq = right.kind === "call" ? right.trace.seq : right.kind === "step" ? right.step.seq : undefined;
    const leftSecond = timelineSecondBucket(leftTime);
    const rightSecond = timelineSecondBucket(rightTime);

    if (leftSecond !== rightSecond) {
      return leftSecond - rightSecond;
    }

    if (leftSeq !== undefined && rightSeq !== undefined && leftSeq !== rightSeq) {
      return leftSeq - rightSeq;
    }

    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    const kindOrder = { message: 0, call: 1, step: 2, event: 3 } as const;
    const kindDelta = kindOrder[left.kind] - kindOrder[right.kind];
    if (kindDelta !== 0) {
      return kindDelta;
    }

    return left.key.localeCompare(right.key);
  };
  const timelineItems = [
    ...props.messages.map((message) => ({
      key: `message:${message.id}`,
      kind: "message" as const,
      sortValue: Date.parse(message.createdAt),
      eyebrow: message.role,
      title: compactPreviewText(message.content, 84),
      subtitle: message.runId ? `run ${message.runId}` : "stored message",
      meta: formatTimestamp(message.createdAt),
      message
    })),
    ...props.traces.map((trace) => ({
      key: `call:${trace.id}`,
      kind: "call" as const,
      sortValue: Date.parse(trace.endedAt ?? trace.startedAt ?? ""),
      eyebrow: `call ${trace.seq}`,
      title: trace.input.model ?? trace.name ?? "model call",
      subtitle: `${trace.output.toolCalls.length} tool calls · ${trace.output.toolResults.length} tool results`,
      meta: trace.output.finishReason ?? formatTimestamp(trace.endedAt ?? trace.startedAt),
      trace
    })),
    ...props.steps
      .filter((step) => step.stepType !== "model_call")
      .map((step) => ({
        key: `step:${step.id}`,
        kind: "step" as const,
        sortValue: Date.parse(step.endedAt ?? step.startedAt ?? ""),
        eyebrow: `step ${step.seq}`,
        title: step.name ?? step.stepType,
        subtitle: `${step.stepType} · ${step.status}`,
        meta: formatTimestamp(step.endedAt ?? step.startedAt),
        step
      })),
    ...props.events.map((event) => ({
      key: `event:${event.id}`,
      kind: "event" as const,
      sortValue: Date.parse(event.createdAt),
      eyebrow: event.event,
      title: event.runId ? `run ${event.runId}` : "session event",
      subtitle: `cursor ${event.cursor}`,
      meta: formatTimestamp(event.createdAt),
      event
    }))
  ].sort(compareTimelineItems);
  const filteredItems =
    props.mode === "messages"
      ? timelineItems.filter((item) => item.kind === "message")
      : props.mode === "execution"
        ? [...timelineItems.filter((item) => item.kind === "call" || item.kind === "step")].sort(compareTimelineItems)
      : props.mode === "calls"
        ? [...timelineItems.filter((item) => item.kind === "call")].sort(compareTimelineItems)
        : props.mode === "steps"
          ? [...timelineItems.filter((item) => item.kind === "step")].sort(compareTimelineItems)
          : props.mode === "events"
            ? timelineItems.filter((item) => item.kind === "event")
            : timelineItems;
  const selectedKey =
    props.mode === "messages"
      ? props.selectedMessage ? `message:${props.selectedMessage.id}` : ""
      : props.mode === "execution"
        ? props.selectedTrace
          ? `call:${props.selectedTrace.id}`
          : props.selectedStep
            ? `step:${props.selectedStep.id}`
            : ""
      : props.mode === "calls"
        ? props.selectedTrace ? `call:${props.selectedTrace.id}` : ""
        : props.mode === "steps"
          ? props.selectedStep ? `step:${props.selectedStep.id}` : ""
          : props.mode === "events"
            ? props.selectedEvent ? `event:${props.selectedEvent.id}` : ""
            : "";
  const activeItem =
    filteredItems.find((item) => item.key === activeItemKey) ??
    filteredItems.find((item) => item.key === selectedKey) ??
    filteredItems[0] ??
    null;
  const selectedMessagePrompt =
    activeItem?.kind === "message" && props.selectedMessage?.id === activeItem.message.id
      ? props.selectedMessageSystemMessages
      : [];
  const activeSystemMessages =
    activeItem?.kind === "message"
      ? selectedMessagePrompt
      : activeItem?.kind === "call"
        ? activeItem.trace.input.messages.filter((message) => message.role === "system")
        : props.systemMessages;
  const combinedSystemPrompt = activeSystemMessages.map((message) => contentText(message.content)).join("\n\n");
  const systemPromptSource =
    activeItem?.kind === "message"
      ? selectedMessagePrompt.length > 0
        ? `message ${activeItem.message.id}`
        : "n/a"
      : activeItem?.kind === "call"
        ? `step ${activeItem.trace.seq}`
        : props.firstTrace
          ? `step ${props.firstTrace.seq}`
          : "n/a";
  const systemPromptDescription =
    activeItem?.kind === "message"
      ? "当前选中 message 落库时记录下来的 system prompt 快照。"
      : activeItem?.kind === "call"
        ? "当前选中 model call 真正发给模型的 system message。"
        : "首个 model call 中真正发给模型的 system message。";

  return (
    <section className="space-y-4">
      <section className="ob-section rounded-[20px] p-5">
        <InspectorPanelHeader
          title="Timeline"
          description="把消息、模型调用、运行步骤和事件流收进同一条时间线里，按一次运行真实发生的顺序来读。"
          action={
            <Button variant="secondary" size="sm" disabled={props.traces.length === 0} onClick={props.onDownload}>
              <Download className="h-4 w-4" />
              Download Trace
            </Button>
          }
        />
        <div className="mt-5 grid gap-4 lg:grid-cols-6">
          <TraceSummaryStat label="System Source" value={systemPromptSource} />
          <TraceSummaryStat label="Messages" value={String(props.messages.length)} />
          <TraceSummaryStat label="Calls" value={String(props.traces.length)} />
          <TraceSummaryStat label="Steps" value={String(props.steps.filter((step) => step.stepType !== "model_call").length)} />
          <TraceSummaryStat label="Events" value={String(props.events.length)} />
          <TraceSummaryStat label="Finish" value={props.latestTrace?.output.finishReason ?? "n/a"} />
        </div>

        <div className="mt-5 grid gap-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
          <InspectorDisclosure
            title="System Prompt"
            description={systemPromptDescription}
            badge={activeSystemMessages.length}
          >
            {combinedSystemPrompt.length === 0 ? (
              <EmptyState title="No system prompt" description="Load a run with model calls to inspect the composed prompt." />
            ) : (
              <pre className="max-h-[20rem] overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-foreground/80">{combinedSystemPrompt}</pre>
            )}
          </InspectorDisclosure>

          <InspectorDisclosure
            title="Model Context"
            description="这块只保留 run 级别的模型环境信息，避免在每次调用详情里重复展示。"
            badge={props.runtimeTools.length}
          >
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <TraceSummaryStat label="Latest Model" value={props.latestTrace?.input.model ?? "n/a"} />
                <TraceSummaryStat label="Provider" value={props.latestTrace?.input.provider ?? "n/a"} />
                <TraceSummaryStat label="Canonical Ref" value={props.latestTrace?.input.canonicalModelRef ?? "n/a"} />
                <TraceSummaryStat
                  label="Latest Messages"
                  value={`S${props.latestModelMessageCounts.system} U${props.latestModelMessageCounts.user} A${props.latestModelMessageCounts.assistant} T${props.latestModelMessageCounts.tool}`}
                />
              </div>
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Resolved Models</p>
                <ToolNameChips names={props.resolvedModelNames} emptyLabel="No resolved model names recorded." />
              </div>
              {props.resolvedModelRefs.length > 0 ? (
                <div className="space-y-2">
                  {props.resolvedModelRefs.map((ref) => (
                    <div key={ref} className="border-l border-border/70 pl-4 text-xs leading-6 text-foreground/80">
                      {ref}
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="rounded-[16px] border border-dashed border-border/70 px-4 py-3 text-xs leading-6 text-muted-foreground">
                Tool Snapshot 已移到 Workspace 页，避免 Timeline 顶部因为工具定义过长而拉伸页面。
              </div>
            </div>
          </InspectorDisclosure>
        </div>
      </section>

      <div className="grid gap-4 2xl:grid-cols-[minmax(340px,0.72fr)_minmax(0,1.28fr)]">
        <DetailSection title="Timeline Feed" description="左侧统一浏览所有关键记录；右侧按类型展开当前项的完整详情。">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
            <div className="grid gap-2 sm:grid-cols-5">
              <TraceSummaryStat label="Visible" value={String(filteredItems.length)} />
              <TraceSummaryStat label="Messages" value={String(props.messages.length)} />
              <TraceSummaryStat label="Calls" value={String(props.traces.length)} />
              <TraceSummaryStat label="Steps" value={String(props.steps.filter((step) => step.stepType !== "model_call").length)} />
              <TraceSummaryStat label="Events" value={String(props.events.length)} />
            </div>
            <div className="segmented-shell">
              <InspectorTabButton label="All" active={props.mode === "all"} onClick={() => props.onModeChange("all")} />
              <InspectorTabButton label="Execution" active={props.mode === "execution"} onClick={() => props.onModeChange("execution")} />
              <InspectorTabButton label="Messages" active={props.mode === "messages"} onClick={() => props.onModeChange("messages")} />
              <InspectorTabButton label="Calls" active={props.mode === "calls"} onClick={() => props.onModeChange("calls")} />
              <InspectorTabButton label="Steps" active={props.mode === "steps"} onClick={() => props.onModeChange("steps")} />
              <InspectorTabButton label="Events" active={props.mode === "events"} onClick={() => props.onModeChange("events")} />
            </div>
          </div>

          {filteredItems.length === 0 ? (
            <EmptyState title="No timeline activity" description="Messages, model calls, steps, and events will appear here after execution starts." />
          ) : (
            <div className="max-h-[36rem] overflow-y-auto pr-1 space-y-1">
              {filteredItems.map((item) => (
                <TimelineListButton
                  key={item.key}
                  active={activeItem?.key === item.key}
                  eyebrow={item.eyebrow}
                  title={item.title}
                  subtitle={item.subtitle}
                  meta={item.meta}
                  onClick={() => {
                    setActiveItemKey(item.key);
                    if (item.kind === "message") {
                      props.onSelectMessage(item.message.id);
                    } else if (item.kind === "call") {
                      props.onSelectTrace(item.trace.id);
                    } else if (item.kind === "step") {
                      props.onSelectStep(item.step.id);
                    } else {
                      props.onSelectEvent(item.event.id);
                    }
                  }}
                />
              ))}
            </div>
          )}
        </DetailSection>

        <DetailSection
          title={
            activeItem?.kind === "message"
              ? "Message Detail"
              : activeItem?.kind === "call"
                ? "Model Call Detail"
                : activeItem?.kind === "event"
                  ? "Event Detail"
                  : "Step Detail"
          }
          description={
            activeItem?.kind === "message"
              ? "消息详情保留对话视角：正文、metadata、tool refs 和落库信息。"
              : activeItem?.kind === "call"
                ? "模型调用详情保留模型视角：message list、tool 往返、usage 和原始 payload。"
                : activeItem?.kind === "event"
                  ? "事件详情保留实时流视角：event 名称、cursor、run 关联和完整 data。"
                  : "步骤详情保留执行视角：step 元信息以及落库的 input / output 原始数据。"
          }
        >
          {activeItem?.kind === "message" ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Badge>{activeItem.message.role}</Badge>
                {activeItem.message.runId ? <Badge>{activeItem.message.runId}</Badge> : null}
                <Badge>{formatTimestamp(activeItem.message.createdAt)}</Badge>
                <MessageToolRefChips content={activeItem.message.content} />
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <InsightRow label="Message ID" value={activeItem.message.id} />
                <InsightRow label="Session ID" value={activeItem.message.sessionId} />
              </div>
              <div className="border-l border-border/70 pl-4">
                <MessageContentDetail content={activeItem.message.content} maxHeightClassName="max-h-[28rem]" />
              </div>
              {activeItem.message.metadata ? <JsonBlock title="Metadata" value={activeItem.message.metadata} /> : null}
            </>
          ) : activeItem?.kind === "call" ? (
            <ModelCallTraceCard trace={activeItem.trace} />
          ) : activeItem?.kind === "step" ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Badge>{`step ${activeItem.step.seq}`}</Badge>
                <Badge>{activeItem.step.stepType}</Badge>
                <Badge className={statusTone(activeItem.step.status)}>{activeItem.step.status}</Badge>
                {activeItem.step.name ? <Badge>{activeItem.step.name}</Badge> : null}
                {activeItem.step.agentName ? <Badge>{activeItem.step.agentName}</Badge> : null}
              </div>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                <InsightRow label="Started" value={formatTimestamp(activeItem.step.startedAt)} />
                <InsightRow label="Ended" value={formatTimestamp(activeItem.step.endedAt)} />
                <InsightRow label="Run" value={activeItem.step.runId} />
                <InsightRow label="Type" value={activeItem.step.stepType} />
              </div>
              <div className="grid gap-3 xl:grid-cols-2">
                <JsonBlock title="Input" value={activeItem.step.input ?? {}} />
                <JsonBlock title="Output" value={activeItem.step.output ?? {}} />
              </div>
            </>
          ) : activeItem?.kind === "event" ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Badge>{activeItem.event.event}</Badge>
                {activeItem.event.runId ? <Badge>{activeItem.event.runId}</Badge> : null}
                <Badge>{`cursor ${activeItem.event.cursor}`}</Badge>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                <InsightRow label="Created" value={formatTimestamp(activeItem.event.createdAt)} />
                <InsightRow label="Run" value={activeItem.event.runId ?? "session-wide"} />
                <InsightRow label="Cursor" value={activeItem.event.cursor} />
                <InsightRow label="Event" value={activeItem.event.event} />
              </div>
              <JsonBlock title="Event Data" value={activeItem.event.data} />
            </>
          ) : (
            <EmptyState title="Nothing selected" description="Pick an item from the left timeline to inspect its raw detail." />
          )}
        </DetailSection>
      </div>
    </section>
  );
}

function OverviewWorkbench(props: {
  session: Session | null;
  run: Run | null;
  workspace: Workspace | null;
  sessionName: string;
  workspaceName: string;
  selectedRunId: string;
  sessionRuns: Run[];
  onSelectedRunIdChange: (value: string) => void;
  onRefreshSessionRuns: () => void;
  onRefreshRun: () => void;
  onRefreshRunSteps: () => void;
  onLoadRunById: (runId: string) => void;
  onLoadRunStepsById: (runId: string) => void;
  onCancelRun: () => void;
  modelCallCount: number;
  stepCount: number;
  eventCount: number;
  messageCount: number;
  latestEvent: SessionEventContract | undefined;
  events: SessionEventContract[];
  runSteps: RunStep[];
  messages: Message[];
  latestTrace: ModelCallTrace | null;
  onOpenTimeline: () => void;
}) {
  const latestMessage = props.messages.at(-1);
  const latestStep = props.runSteps.at(-1);
  const latestEvent = props.latestEvent ?? props.events[0];
  const lastUpdated = formatTimestamp(props.run?.heartbeatAt ?? props.run?.endedAt ?? props.session?.updatedAt);

  return (
    <section className="space-y-4">
      <section className="ob-section rounded-[20px] p-5">
        <InspectorPanelHeader
          title="Overview"
          description="先在这里确认当前 workspace、session 和 run 的状态，再决定下一步进入 Timeline、Workspace 还是 Provider。"
        />

        <div className="mt-5 grid gap-4 lg:grid-cols-6">
          <TraceSummaryStat label="Workspace" value={props.workspace?.id ?? props.workspaceName} />
          <TraceSummaryStat label="Session" value={props.session?.id ?? props.sessionName} />
          <TraceSummaryStat label="Run" value={props.run?.id ?? "n/a"} />
          <TraceSummaryStat label="Agent" value={props.run?.effectiveAgentName ?? props.session?.activeAgentName ?? "n/a"} />
          <TraceSummaryStat label="Status" value={props.run?.status ?? "no-run"} />
          <TraceSummaryStat label="Last Updated" value={lastUpdated} />
        </div>

        <div className="mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <CatalogLine label="session runs" value={props.sessionRuns.length} />
          <CatalogLine label="messages" value={props.messageCount} />
          <CatalogLine label="model calls" value={props.modelCallCount} />
          <CatalogLine label="run steps" value={props.stepCount} />
          <CatalogLine label="events" value={props.eventCount} />
        </div>
      </section>

      <div className="grid gap-4 2xl:grid-cols-[minmax(340px,0.78fr)_minmax(0,1.22fr)]">
        <DetailSection
          title="Session Runs"
          description="直接展开当前 session 下的全部 runs，不需要再点击切换才能知道这里发生过几次执行。"
        >
          <div className="flex flex-wrap gap-2">
            <Badge>{props.workspaceName}</Badge>
            <Badge>{props.sessionName}</Badge>
            {props.run?.id ? <Badge>{props.run.id}</Badge> : null}
            <Badge className={statusTone(props.run?.status ?? "idle")}>{props.run?.status ?? "no-run"}</Badge>
            {latestEvent ? <Badge>{latestEvent.event}</Badge> : null}
          </div>

          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <InsightRow label="Workspace Mode" value={props.workspace?.kind ?? "n/a"} />
            <InsightRow label="Mirror" value={props.workspace?.kind === "project" ? "local sqlite" : "unsupported"} />
            <InsightRow label="Latest Event" value={latestEvent?.event ?? "n/a"} />
            <InsightRow label="Current Detail Run" value={props.selectedRunId || props.run?.id || "n/a"} />
          </div>

          <div className="rounded-[18px] border border-border bg-muted/20 p-4">
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={props.onRefreshSessionRuns}>
                Refresh Runs
              </Button>
              <Button variant="secondary" onClick={props.onRefreshRun}>
                Refresh Current Run
              </Button>
              <Button variant="secondary" onClick={props.onRefreshRunSteps}>
                Refresh Current Steps
              </Button>
              <Button variant="destructive" onClick={props.onCancelRun}>
                <CircleSlash2 className="h-4 w-4" />
                Cancel
              </Button>
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              这里直接显示 session 下所有 run。Timeline 和 step 详情仍然默认跟随当前 detail run。
            </p>
            <div className="mt-3 grid gap-3">
              {props.sessionRuns.length === 0 ? (
                <span className="text-xs text-muted-foreground">No runs loaded for this session yet.</span>
              ) : (
                props.sessionRuns.map((sessionRun) => (
                  <article
                    key={sessionRun.id}
                    className={`rounded-[16px] border p-4 ${
                      sessionRun.id === (props.selectedRunId || props.run?.id)
                        ? "border-primary/40 bg-primary/5"
                        : "border-border/70 bg-background/60"
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge>{sessionRun.id}</Badge>
                      <Badge className={statusTone(sessionRun.status)}>{sessionRun.status}</Badge>
                      <Badge variant="outline">{sessionRun.effectiveAgentName}</Badge>
                      {sessionRun.parentRunId ? <Badge variant="outline">parent {sessionRun.parentRunId}</Badge> : null}
                      {sessionRun.id === (props.selectedRunId || props.run?.id) ? <Badge variant="secondary">detail</Badge> : null}
                    </div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                      <InsightRow label="Trigger" value={sessionRun.triggerType} />
                      <InsightRow label="Started" value={formatTimestamp(sessionRun.startedAt ?? sessionRun.createdAt)} />
                      <InsightRow label="Ended" value={formatTimestamp(sessionRun.endedAt)} />
                      <InsightRow label="Switch Count" value={String(sessionRun.switchCount ?? 0)} />
                    </div>
                  </article>
                ))
              )}
            </div>
          </div>
        </DetailSection>

        <DetailSection
          title="Recent Signals"
          description="这里只看最近发生了什么，帮助你判断接下来该去 Timeline 里看消息、模型调用、步骤还是事件。"
        >
          <div className="space-y-1">
            <TimelineListButton
              active={false}
              eyebrow="message"
              title={latestMessage ? compactPreviewText(latestMessage.content, 88) : "No message yet"}
              subtitle={latestMessage?.runId ? `run ${latestMessage.runId}` : "stored conversation"}
              {...(latestMessage ? { meta: formatTimestamp(latestMessage.createdAt) } : {})}
              onClick={props.onOpenTimeline}
            />
            <TimelineListButton
              active={false}
              eyebrow="call"
              title={props.latestTrace?.input.model ?? props.latestTrace?.name ?? "No model call yet"}
              subtitle={
                props.latestTrace
                  ? `${props.latestTrace.output.toolCalls.length} tool calls · ${props.latestTrace.output.finishReason ?? "finish n/a"}`
                  : "model-facing trace"
              }
              {...(props.latestTrace ? { meta: formatTimestamp(props.latestTrace.endedAt ?? props.latestTrace.startedAt) } : {})}
              onClick={props.onOpenTimeline}
            />
            <TimelineListButton
              active={false}
              eyebrow="step"
              title={latestStep?.name ?? latestStep?.stepType ?? "No step yet"}
              subtitle={latestStep ? `${latestStep.stepType} · ${latestStep.status}` : "runtime step"}
              {...(latestStep ? { meta: formatTimestamp(latestStep.endedAt ?? latestStep.startedAt) } : {})}
              onClick={props.onOpenTimeline}
            />
            <TimelineListButton
              active={false}
              eyebrow="event"
              title={latestEvent?.event ?? "No event yet"}
              subtitle={latestEvent?.runId ? `run ${latestEvent.runId}` : "runtime event"}
              {...(latestEvent ? { meta: formatTimestamp(latestEvent.createdAt) } : {})}
              onClick={props.onOpenTimeline}
            />
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <div className="rounded-[18px] border border-border/70 bg-muted/15 p-4">
              <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Next Best View</p>
              <p className="mt-2 text-sm font-medium text-foreground">Timeline</p>
              <p className="mt-1 text-xs leading-6 text-muted-foreground">看消息、模型调用、step、event 的完整因果链。</p>
            </div>
            <div className="rounded-[18px] border border-border/70 bg-muted/15 p-4">
              <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Environment</p>
              <p className="mt-2 text-sm font-medium text-foreground">Workspace</p>
              <p className="mt-1 text-xs leading-6 text-muted-foreground">核对 mirror、catalog 和原始记录边界。</p>
            </div>
            <div className="rounded-[18px] border border-border/70 bg-muted/15 p-4">
              <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Sandbox</p>
              <p className="mt-2 text-sm font-medium text-foreground">Provider</p>
              <p className="mt-1 text-xs leading-6 text-muted-foreground">管理连接、provider 列表和单次模型验证。</p>
            </div>
          </div>
        </DetailSection>
      </div>
    </section>
  );
}

function InspectorOverviewCard(props: {
  session: Session | null;
  run: Run | null;
  workspace: Workspace | null;
  sessionName: string;
  workspaceName: string;
  selectedRunId: string;
  onSelectedRunIdChange: (value: string) => void;
  onRefreshRun: () => void;
  onRefreshRunSteps: () => void;
  onCancelRun: () => void;
  modelCallCount: number;
  stepCount: number;
  eventCount: number;
  messageCount: number;
  latestEvent: SessionEventContract | undefined;
}) {
  return (
    <section className="ob-section space-y-3 rounded-[16px] p-4">
      <InspectorPanelHeader
        title="Overview"
        description="Current session, run, and quick actions."
      />

      <div className="flex flex-wrap gap-2">
        <Badge>{props.workspaceName}</Badge>
        <Badge>{props.sessionName}</Badge>
        {props.run?.id ? <Badge>{props.run.id}</Badge> : null}
        <Badge className={statusTone(props.run?.status ?? "idle")}>{props.run?.status ?? "no-run"}</Badge>
        {props.latestEvent ? <Badge>{props.latestEvent.event}</Badge> : null}
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <InsightRow label="Workspace" value={props.workspace?.id ?? props.workspaceName} />
        <InsightRow label="Session" value={props.session?.id ?? props.sessionName} />
        <InsightRow label="Run" value={props.run?.id ?? "n/a"} />
        <InsightRow label="Agent" value={props.run?.effectiveAgentName ?? props.session?.activeAgentName ?? "n/a"} />
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <InsightRow label="Run Status" value={props.run?.status ?? "n/a"} />
        <InsightRow label="Workspace Mode" value={props.workspace?.kind ?? "n/a"} />
        <InsightRow label="Latest Event" value={props.latestEvent?.event ?? "n/a"} />
        <InsightRow label="Last Updated" value={formatTimestamp(props.run?.heartbeatAt ?? props.run?.endedAt ?? props.session?.updatedAt)} />
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <CatalogLine label="messages" value={props.messageCount} />
        <CatalogLine label="model calls" value={props.modelCallCount} />
        <CatalogLine label="run steps" value={props.stepCount} />
        <CatalogLine label="events" value={props.eventCount} />
      </div>

      <div className="rounded-[18px] border border-border bg-muted/20 p-3">
        <p className="text-sm font-medium text-foreground">Run</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
          <Input
            value={props.selectedRunId}
            onChange={(event) => props.onSelectedRunIdChange(event.target.value)}
            placeholder="Selected run"
          />
          <Button variant="secondary" onClick={props.onRefreshRun}>
            Load Run
          </Button>
          <Button variant="secondary" onClick={props.onRefreshRunSteps}>
            Load Steps
          </Button>
          <Button variant="destructive" onClick={props.onCancelRun}>
            <CircleSlash2 className="h-4 w-4" />
            Cancel
          </Button>
        </div>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">Load, refresh, or cancel the active run.</p>
      </div>
    </section>
  );
}

function OverviewRecordsCard(props: {
  run: Run | null;
  session: Session | null;
  workspace: Workspace | null;
}) {
  return (
    <section className="ob-section space-y-3 rounded-[16px] p-4">
      <InspectorPanelHeader
        title="Records"
        description="Raw workspace, session, and run objects."
      />

      <InspectorDisclosure title="Run Record" description="当前 run 的完整记录。" badge={props.run ? "ready" : "n/a"}>
        {props.run ? <EntityPreview title={props.run.id} data={props.run} /> : <EmptyState title="No run" description="Pick a run from the conversation or load one manually." />}
      </InspectorDisclosure>

      <InspectorDisclosure title="Session Record" description="当前 session 的基础字段与状态。" badge={props.session ? "ready" : "n/a"}>
        {props.session ? <EntityPreview title={props.session.id} data={props.session} /> : <EmptyState title="No session" description="Open a session to inspect its record." />}
      </InspectorDisclosure>

      <InspectorDisclosure title="Workspace Record" description="当前 workspace 的配置与运行状态。" badge={props.workspace ? "ready" : "n/a"}>
        {props.workspace ? <EntityPreview title={props.workspace.id} data={props.workspace} /> : <EmptyState title="No workspace" description="Select a workspace to inspect its record." />}
      </InspectorDisclosure>
    </section>
  );
}

function WorkspaceCatalogCollection(props: {
  title: string;
  description: string;
  items: unknown[];
}) {
  return (
    <InspectorDisclosure title={props.title} description={props.description} badge={props.items.length}>
      {props.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No records available.</p>
      ) : (
        <EntityPreview title={props.title} data={props.items} />
      )}
    </InspectorDisclosure>
  );
}

function WorkspaceWorkbench(props: {
  workspace: Workspace | null;
  session: Session | null;
  run: Run | null;
  catalog: WorkspaceCatalog | null;
  runtimeTools: ModelCallTraceRuntimeTool[];
  runtimeToolNames: string[];
  activeToolNames: string[];
  toolServers: ModelCallTraceToolServer[];
  triggerWorkspaceAction: (input: { workspaceId: string; actionName: string; input?: unknown }) => Promise<boolean>;
  refreshWorkspace: (targetId: string) => void;
}) {
  const [panel, setPanel] = useState<"snapshot" | "catalog" | "records">("snapshot");
  const [selectedUserActionName, setSelectedUserActionName] = useState("");
  const [actionInputMode, setActionInputMode] = useState<"structured" | "json">("json");
  const [actionInputText, setActionInputText] = useState("");
  const [structuredActionInputValues, setStructuredActionInputValues] = useState<Record<string, string>>({});
  const [actionInputError, setActionInputError] = useState("");
  const [actionRunBusy, setActionRunBusy] = useState(false);
  const workspaceKind = props.workspace?.kind ?? "n/a";
  const workspaceId = props.workspace?.id ?? "n/a";
  const selectedRunId = props.run?.id ?? "n/a";
  const userCallableActions = (props.catalog?.actions ?? []).filter((action) => action.callableByUser !== false);
  const selectedUserAction = userCallableActions.find((action) => action.name === selectedUserActionName) ?? userCallableActions[0];
  const selectedUserActionFormSpec = deriveStructuredActionInputSpec(selectedUserAction?.inputSchema);
  const inventoryRows = props.catalog
    ? [
        { label: "agents", value: props.catalog.agents.length },
        { label: "models", value: props.catalog.models.length },
        { label: "actions", value: props.catalog.actions.length },
        { label: "skills", value: props.catalog.skills.length },
        { label: "tools", value: props.catalog.tools?.length ?? 0 },
        { label: "hooks", value: props.catalog.hooks.length },
        { label: "runtimeTools", value: props.catalog.runtimeTools?.length ?? 0 },
        { label: "nativeTools", value: props.catalog.nativeTools.length }
      ]
    : [];
  const userCallableActionNamesKey = userCallableActions.map((action) => action.name).join("|");
  const selectedUserActionKey = `${selectedUserAction?.name ?? ""}:${JSON.stringify(selectedUserAction?.inputSchema ?? null)}`;

  useEffect(() => {
    if (userCallableActions.length === 0) {
      if (selectedUserActionName) {
        setSelectedUserActionName("");
      }
      return;
    }

    if (!userCallableActions.some((action) => action.name === selectedUserActionName)) {
      setSelectedUserActionName(userCallableActions[0]!.name);
    }
  }, [selectedUserActionName, userCallableActionNamesKey, userCallableActions]);

  useEffect(() => {
    setActionInputError("");
    setActionInputText("");
    if (selectedUserActionFormSpec) {
      setActionInputMode("structured");
      setStructuredActionInputValues(initializeStructuredActionInputValues(selectedUserActionFormSpec));
      return;
    }

    setActionInputMode("json");
    setStructuredActionInputValues({});
  }, [selectedUserActionKey, selectedUserActionFormSpec]);

  async function handleRunWorkspaceAction() {
    if (!props.workspace?.id || !selectedUserAction) {
      return;
    }

    const trimmedInput = actionInputText.trim();
    let parsedInput: unknown;
    if (selectedUserActionFormSpec && actionInputMode === "structured") {
      const builtInput = buildStructuredActionInput(selectedUserActionFormSpec, structuredActionInputValues);
      if (!builtInput.ok) {
        setActionInputError(builtInput.error);
        return;
      }
      parsedInput = builtInput.value;
    } else if (trimmedInput.length > 0) {
      try {
        parsedInput = JSON.parse(trimmedInput);
      } catch {
        setActionInputError("Action input must be valid JSON.");
        return;
      }
    }

    setActionInputError("");
    setActionRunBusy(true);
    try {
      const triggered = await props.triggerWorkspaceAction({
        workspaceId: props.workspace.id,
        actionName: selectedUserAction.name,
        ...(trimmedInput.length > 0 ? { input: parsedInput } : {})
      });
      if (triggered) {
        setActionInputText("");
      }
    } finally {
      setActionRunBusy(false);
    }
  }

  return (
    <section className="space-y-4">
      <section className="ob-section rounded-[20px] p-5">
        <InspectorPanelHeader
          title="Workspace"
          description="Workspace 页现在收成一套更紧凑的环境工作台: 顶部先看状态和控制，下方再切换 Snapshot、Catalog、Records。"
        />
        <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1.18fr)_minmax(320px,0.82fr)]">
          <div className="rounded-[18px] border border-border/70 bg-muted/15 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{workspaceKind}</Badge>
              <Badge variant="outline">{props.catalog ? "catalog loaded" : "catalog missing"}</Badge>
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <TraceSummaryStat label="Workspace" value={workspaceId} />
              <TraceSummaryStat label="Status" value={props.workspace?.status ?? "n/a"} />
              <TraceSummaryStat label="Selected Run" value={selectedRunId} />
              <TraceSummaryStat label="Catalog" value={props.catalog ? "loaded" : "n/a"} />
            </div>
          </div>

          <div className="rounded-[18px] border border-border/70 bg-background/80 p-4">
            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Controls</p>
            {props.workspace ? (
              <>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="ghost" size="sm" onClick={() => props.refreshWorkspace(props.workspace!.id)}>
                    Refresh
                  </Button>
                </div>
                <div className="mt-4 rounded-[16px] border border-border/70 bg-muted/10 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Run Action</p>
                    {selectedUserAction?.retryPolicy ? <Badge variant="outline">{selectedUserAction.retryPolicy}</Badge> : null}
                  </div>
                  {userCallableActions.length > 0 ? (
                    <>
                      <div className="mt-3">
                        <Select value={selectedUserAction?.name ?? ""} onValueChange={setSelectedUserActionName}>
                          <SelectTrigger className="h-9 w-full text-sm" aria-label="User action">
                            <SelectValue placeholder="Select action" />
                          </SelectTrigger>
                          <SelectContent align="start">
                            {userCallableActions.map((action) => (
                              <SelectItem key={action.name} value={action.name}>
                                {action.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {selectedUserAction?.description ? (
                        <p className="mt-2 text-xs leading-5 text-muted-foreground">{selectedUserAction.description}</p>
                      ) : null}
                      {selectedUserAction?.inputSchema ? (
                        <div className="mt-3">
                          <JsonBlock title="Input Schema" value={selectedUserAction.inputSchema} />
                        </div>
                      ) : null}
                      {selectedUserActionFormSpec ? (
                        <div className="mt-3 space-y-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant={actionInputMode === "structured" ? "secondary" : "outline"}
                              onClick={() => setActionInputMode("structured")}
                            >
                              Structured
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant={actionInputMode === "json" ? "secondary" : "outline"}
                              onClick={() => setActionInputMode("json")}
                            >
                              Raw JSON
                            </Button>
                          </div>
                          {actionInputMode === "structured" ? (
                            selectedUserActionFormSpec.fields.length > 0 ? (
                              <div className="grid gap-3 sm:grid-cols-2">
                                {selectedUserActionFormSpec.fields.map((field) => (
                                  <div key={field.name} className={cn("space-y-2", field.kind === "boolean" ? "sm:col-span-2" : "")}>
                                    <Label>
                                      {field.label}
                                      {field.required ? " *" : ""}
                                    </Label>
                                    {field.kind === "string" ? (
                                      <Input
                                        value={structuredActionInputValues[field.name] ?? ""}
                                        onChange={(event) => {
                                          setStructuredActionInputValues((current) => ({
                                            ...current,
                                            [field.name]: event.target.value
                                          }));
                                          if (actionInputError) {
                                            setActionInputError("");
                                          }
                                        }}
                                        placeholder={field.description ?? field.label}
                                      />
                                    ) : field.kind === "number" || field.kind === "integer" ? (
                                      <Input
                                        type="number"
                                        step={field.kind === "integer" ? "1" : "any"}
                                        value={structuredActionInputValues[field.name] ?? ""}
                                        onChange={(event) => {
                                          setStructuredActionInputValues((current) => ({
                                            ...current,
                                            [field.name]: event.target.value
                                          }));
                                          if (actionInputError) {
                                            setActionInputError("");
                                          }
                                        }}
                                        placeholder={field.kind === "integer" ? "0" : "0.0"}
                                      />
                                    ) : field.kind === "boolean" ? (
                                      <Select
                                        value={structuredActionInputValues[field.name] || ACTION_INPUT_UNSET_VALUE}
                                        onValueChange={(value) => {
                                          setStructuredActionInputValues((current) => ({
                                            ...current,
                                            [field.name]: value === ACTION_INPUT_UNSET_VALUE ? "" : value
                                          }));
                                          if (actionInputError) {
                                            setActionInputError("");
                                          }
                                        }}
                                      >
                                        <SelectTrigger className="h-9 w-full text-sm" aria-label={field.label}>
                                          <SelectValue placeholder={field.required ? "Select true or false" : "Not set"} />
                                        </SelectTrigger>
                                        <SelectContent align="start">
                                          {!field.required ? <SelectItem value={ACTION_INPUT_UNSET_VALUE}>Not set</SelectItem> : null}
                                          <SelectItem value="true">true</SelectItem>
                                          <SelectItem value="false">false</SelectItem>
                                        </SelectContent>
                                      </Select>
                                    ) : field.kind === "string_enum" ? (
                                      <Select
                                        value={structuredActionInputValues[field.name] || ACTION_INPUT_UNSET_VALUE}
                                        onValueChange={(value) => {
                                          setStructuredActionInputValues((current) => ({
                                            ...current,
                                            [field.name]: value === ACTION_INPUT_UNSET_VALUE ? "" : value
                                          }));
                                          if (actionInputError) {
                                            setActionInputError("");
                                          }
                                        }}
                                      >
                                        <SelectTrigger className="h-9 w-full text-sm" aria-label={field.label}>
                                          <SelectValue placeholder={field.required ? "Select a value" : "Not set"} />
                                        </SelectTrigger>
                                        <SelectContent align="start">
                                          {!field.required ? <SelectItem value={ACTION_INPUT_UNSET_VALUE}>Not set</SelectItem> : null}
                                          {field.options.map((option: string) => (
                                            <SelectItem key={option} value={option}>
                                              {option}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    ) : null}
                                    {field.description ? <p className="text-xs leading-5 text-muted-foreground">{field.description}</p> : null}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="text-xs leading-5 text-muted-foreground">
                                This action accepts an object input with no predefined fields. Structured mode will submit an empty object.
                              </p>
                            )
                          ) : (
                            <Textarea
                              value={actionInputText}
                              onChange={(event) => {
                                setActionInputText(event.target.value);
                                if (actionInputError) {
                                  setActionInputError("");
                                }
                              }}
                              placeholder='Optional JSON input, for example {"mode":"quick"}'
                              className="min-h-[108px] text-xs leading-6"
                            />
                          )}
                        </div>
                      ) : (
                        <Textarea
                          value={actionInputText}
                          onChange={(event) => {
                            setActionInputText(event.target.value);
                            if (actionInputError) {
                              setActionInputError("");
                            }
                          }}
                          placeholder='Optional JSON input, for example {"mode":"quick"}'
                          className="mt-3 min-h-[108px] text-xs leading-6"
                        />
                      )}
                      <p className={cn("mt-2 text-xs leading-5", actionInputError ? "text-rose-600" : "text-muted-foreground")}>
                        {actionInputError ||
                          (props.session?.workspaceId === props.workspace.id
                            ? `This run will attach to the current session ${props.session.id}.`
                            : "No active session is attached to this workspace. Running the action will create a temporary session automatically.")}
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Button size="sm" disabled={actionRunBusy || !selectedUserAction} onClick={() => void handleRunWorkspaceAction()}>
                          {actionRunBusy ? "Running..." : "Run Action"}
                        </Button>
                        <Badge variant="secondary">{selectedUserAction?.name ?? "no action selected"}</Badge>
                      </div>
                    </>
                  ) : (
                    <p className="mt-3 text-xs leading-5 text-muted-foreground">
                      No user-callable actions are exposed in this workspace catalog.
                    </p>
                  )}
                </div>
                <p className="mt-3 text-xs leading-6 text-muted-foreground">
                  Use Snapshot for quick environment checks. Switch to Catalog or Records only when you need the full detail.
                </p>
              </>
            ) : (
              <EmptyState title="No workspace selected" description="Open a workspace to manage mirror sync and inspect environment state." />
            )}
          </div>
        </div>
      </section>

      <section className="ob-section rounded-[20px] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-foreground">Workspace Views</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Keep the default page short, then open deeper detail only when needed.</p>
          </div>
          <div className="segmented-shell">
            <InspectorTabButton label="Snapshot" active={panel === "snapshot"} onClick={() => setPanel("snapshot")} />
            <InspectorTabButton label="Catalog" active={panel === "catalog"} onClick={() => setPanel("catalog")} />
            <InspectorTabButton label="Records" active={panel === "records"} onClick={() => setPanel("records")} />
          </div>
        </div>

        <div className="mt-5">
          {panel === "snapshot" ? (
            <div className="grid gap-4 2xl:grid-cols-[minmax(320px,0.72fr)_minmax(0,1.28fr)]">
              <div className="space-y-4">
                <DetailSection
                  title="Workspace Snapshot"
                  description="先看 workspace 的基础状态，再决定是否深入 catalog 或 records。"
                >
                  {props.workspace ? (
                    <>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <InsightRow label="Workspace Kind" value={props.workspace.kind} />
                        <InsightRow label="Workspace Status" value={props.workspace.status} />
                        <InsightRow label="Catalog" value={props.catalog ? "loaded" : "n/a"} />
                        <InsightRow label="Selected Run" value={props.run?.id ?? "n/a"} />
                      </div>
                    </>
                  ) : (
                    <EmptyState title="No workspace selected" description="Open a workspace to inspect environment state." />
                  )}
                </DetailSection>

                <DetailSection
                  title="Inventory Snapshot"
                  description="先看数量和边界，确认 catalog 是否符合预期。"
                >
                  {props.catalog ? (
                    <div className="grid gap-2">
                      {inventoryRows.map((item) => (
                        <CatalogLine key={item.label} label={item.label} value={item.value} />
                      ))}
                    </div>
                  ) : (
                    <EmptyState title="No catalog" description="Load a workspace first to inspect the current inventory." />
                  )}
                </DetailSection>
              </div>

              <DetailSection
                title="Tool Snapshot"
                description="默认首屏把工具环境放在右侧主区域，目录和详情集中阅读，减少来回跳转。"
              >
                <ToolSnapshotBrowser
                  runtimeTools={props.runtimeTools}
                  runtimeToolNames={props.runtimeToolNames}
                  activeToolNames={props.activeToolNames}
                  toolServers={props.toolServers}
                />
              </DetailSection>
            </div>
          ) : null}

          {panel !== "snapshot" ? (
            <DetailSection
              title={panel === "catalog" ? "Catalog Detail" : "Record Detail"}
              description={
                panel === "catalog"
                  ? "Catalog 模式只在你需要核对能力边界时展开，默认不再占据首屏。"
                  : "Records 模式保留 workspace、session、run 的原始对象，适合审计和排查。"
              }
            >
              {panel === "catalog" ? (
                props.catalog ? (
                  <div className="space-y-3">
                    <WorkspaceCatalogCollection
                      title="Agents"
                      description="Workspace agent definitions, or platform fallback agents when the workspace does not declare any."
                      items={props.catalog.agents}
                    />
                    <WorkspaceCatalogCollection title="Models" description="Available models and provider bindings." items={props.catalog.models} />
                    <WorkspaceCatalogCollection title="Actions" description="Runnable actions exposed in this workspace." items={props.catalog.actions} />
                    <WorkspaceCatalogCollection title="Skills" description="Loaded workspace skills." items={props.catalog.skills} />
                    <WorkspaceCatalogCollection title="Tools" description="Declared tools and tool exposure." items={props.catalog.tools ?? []} />
                    <WorkspaceCatalogCollection title="Hooks" description="Registered hook definitions." items={props.catalog.hooks} />
                    <WorkspaceCatalogCollection
                      title="Runtime Tools"
                      description="Tools the runtime can actually expose across this workspace, including AgentSwitch, Skill, run_action, SubAgent, and native tools."
                      items={props.catalog.runtimeTools ?? props.catalog.nativeTools}
                    />
                    <WorkspaceCatalogCollection title="Native Tools" description="Base native tool inventory recorded by the runtime." items={props.catalog.nativeTools} />
                    <InspectorDisclosure title="Raw Catalog JSON" description="完整 catalog 记录，保留给审计或排查边界问题。" badge="raw">
                      <EntityPreview title={props.catalog.workspaceId} data={props.catalog} />
                    </InspectorDisclosure>
                  </div>
                ) : (
                  <EmptyState title="No catalog" description="Load a workspace first to inspect its catalog." />
                )
              ) : (
                <OverviewRecordsCard run={props.run} session={props.session} workspace={props.workspace} />
              )}
            </DetailSection>
          ) : null}
        </div>
      </section>
    </section>
  );
}


export {
  ContextWorkbench,
  CallsWorkbench,
  TimelineWorkbench,
  OverviewWorkbench,
  InspectorOverviewCard,
  OverviewRecordsCard,
  WorkspaceWorkbench
};
