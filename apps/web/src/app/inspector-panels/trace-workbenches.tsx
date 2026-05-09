import { useState } from "react";
import { Download } from "lucide-react";

import type { Message, RunStep, SessionEventContract } from "@oah/api-contracts";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";

import {
  contentText,
  countMessagesByRole,
  formatTimestamp,
  statusTone,
  type ModelCallTrace,
  type ModelCallTraceEngineTool,
  type ModelCallTraceMessage,
  type ModelCallTraceToolServer
} from "../support";
import { compactPreviewText, EmptyState, InsightRow, InspectorTabButton, JsonBlock } from "../primitives";

import {
  DetailSection,
  InspectorDisclosure,
  InspectorPanelHeader,
  MessageContentDetail,
  MessageToolRefChips,
  TimelineListButton,
  ToolNameChips,
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
  engineTools: ModelCallTraceEngineTool[];
  engineToolNames: string[];
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
          engineTools={props.engineTools}
          engineToolNames={props.engineToolNames}
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
  engineTools: ModelCallTraceEngineTool[];
  engineToolNames: string[];
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
            badge={props.engineTools.length}
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

export { ContextWorkbench, CallsWorkbench, TimelineWorkbench };
