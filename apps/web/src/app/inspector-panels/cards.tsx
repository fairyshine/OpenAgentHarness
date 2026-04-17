import { type ReactNode } from "react";
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
  InspectorDisclosure,
  InspectorPanelHeader,
  MessageContentDetail,
  MessageToolRefChips,
  ModelMessageList,
  ToolNameChips
} from "./shared";

function RuntimeActivityCard(props: {
  latestEvent: SessionEventContract | undefined;
  events: SessionEventContract[];
  runSteps: RunStep[];
  messages: Message[];
  latestTrace: ModelCallTrace | null;
}) {
  const recentEvents = props.events.slice(0, 5);

  return (
    <section className="ob-section space-y-3 rounded-[16px] p-4">
      <InspectorPanelHeader
        title="Activity"
        description="Latest message, step, event, and trace."
      />

      <div className="grid gap-2 sm:grid-cols-2">
        <InsightRow label="Latest Event" value={props.latestEvent?.event ?? "n/a"} />
        <InsightRow label="Latest Model" value={props.latestTrace?.input.model ?? "n/a"} />
        <InsightRow label="Last Step" value={props.runSteps.at(-1)?.name ?? props.runSteps.at(-1)?.stepType ?? "n/a"} />
        <InsightRow label="Last Message" value={props.messages.at(-1)?.role ?? "n/a"} />
      </div>

      <InspectorDisclosure
        title="Recent Event Feed"
        description="这里只展示最近几条事件做快速浏览；完整事件流请切到 Runtime 分栏。"
        badge={recentEvents.length}
      >
        {recentEvents.length === 0 ? (
          <EmptyState title="No recent events" description="SSE events will appear here after the session starts producing updates." />
        ) : (
          <div className="space-y-2">
            {recentEvents.map((event) => (
              <div key={event.id} className="ob-subsection rounded-[14px] p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge>{event.event}</Badge>
                  {event.runId ? <Badge>{event.runId}</Badge> : null}
                  <span className="text-xs text-muted-foreground">{formatTimestamp(event.createdAt)}</span>
                </div>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-foreground/80">{prettyJson(event.data)}</pre>
              </div>
            ))}
          </div>
        )}
      </InspectorDisclosure>
    </section>
  );
}

function LlmSummaryCard(props: {
  modelCallCount: number;
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
    <section className="ob-section space-y-3 rounded-[16px] p-4">
      <InspectorPanelHeader
        title="LLM Summary"
        description="这一栏只放模型侧真值：模型解析结果、消息统计、工具注入快照和导出入口。"
        action={
          <Button variant="secondary" size="sm" disabled={props.modelCallCount === 0} onClick={props.onDownload}>
            <Download className="h-4 w-4" />
            Download Session JSON
          </Button>
        }
      />

      <div className="grid gap-2 sm:grid-cols-2">
        <InsightRow label="Latest Model" value={props.latestTrace?.input.model ?? "n/a"} />
        <InsightRow label="Canonical Ref" value={props.latestTrace?.input.canonicalModelRef ?? "n/a"} />
        <InsightRow label="Provider" value={props.latestTrace?.input.provider ?? "n/a"} />
        <InsightRow label="Latest Finish" value={props.latestTrace?.output.finishReason ?? "n/a"} />
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <CatalogLine label="model calls" value={props.modelCallCount} />
        <CatalogLine label="runtime tools" value={props.runtimeToolNames.length} />
        <CatalogLine label="active tools" value={props.activeToolNames.length} />
        <CatalogLine label="tool servers" value={props.toolServers.length} />
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <InsightRow
          label="Latest Call Messages"
          value={`S ${props.latestModelMessageCounts.system} · U ${props.latestModelMessageCounts.user} · A ${props.latestModelMessageCounts.assistant} · T ${props.latestModelMessageCounts.tool}`}
        />
        <InsightRow label="Latest Step" value={props.latestTrace ? `step ${props.latestTrace.seq}` : "n/a"} />
      </div>

      <InspectorDisclosure
        title="Resolved Models"
        description="汇总这次 run 里所有 model call 最终解析到的模型名与 canonical ref。"
        badge={props.resolvedModelNames.length + props.resolvedModelRefs.length}
      >
        <div className="space-y-3">
          <ToolNameChips names={props.resolvedModelNames} emptyLabel="No resolved model names recorded." />
          {props.resolvedModelRefs.length > 0 ? (
            <div className="space-y-2">
              {props.resolvedModelRefs.map((ref) => (
                <div key={ref} className="ob-subsection rounded-[14px] px-3 py-2 text-xs leading-6 text-foreground/80">
                  {ref}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No canonical model refs recorded.</p>
          )}
        </div>
      </InspectorDisclosure>

      <InspectorDisclosure
        title="Tool Snapshot"
        description="详细工具快照已移到 Workspace 页；这里保留摘要，避免 timeline 视图过长。"
        badge={props.runtimeTools.length}
      >
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-3">
            <CatalogLine label="runtimeDefs" value={props.runtimeTools.length} />
            <CatalogLine label="activeTools" value={props.activeToolNames.length} />
            <CatalogLine label="toolServers" value={props.toolServers.length} />
          </div>
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Runtime Tool Names</p>
            <ToolNameChips names={props.runtimeToolNames} emptyLabel="No runtime tool names recorded." />
          </div>
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Active Tool Names</p>
            <ToolNameChips names={props.activeToolNames} emptyLabel="No active tool names recorded." />
          </div>
          <p className="text-xs leading-6 text-muted-foreground">Open Workspace to inspect each tool or tool server in detail.</p>
        </div>
      </InspectorDisclosure>
    </section>
  );
}

function SessionContextCard(props: {
  systemMessages: ModelCallTraceMessage[];
  firstTrace: ModelCallTrace | null;
  messages: Message[];
}) {
  return (
    <section className="ob-section space-y-3 rounded-[16px] p-4">
      <InspectorPanelHeader
        title="Session Context"
        description="把模型真正看到的 system prompt，以及 runtime 持久化下来的 session message timeline 放在一起看。"
      />

      <div className="grid gap-2 sm:grid-cols-2">
        <InsightRow label="System Prompt Source" value={props.firstTrace ? `step ${props.firstTrace.seq}` : "n/a"} />
        <InsightRow label="Stored Messages" value={String(props.messages.length)} />
      </div>

      <InspectorDisclosure
        title="Composed System Prompt"
        description="首个 model call 中真正发给模型的 system message 内容。"
        badge={props.systemMessages.length}
      >
        {props.systemMessages.length === 0 ? (
          <EmptyState title="No system prompt" description="Load a run with model calls to inspect system messages." />
        ) : (
          <div className="space-y-2">
            {props.systemMessages.map((message, index) => (
              <div key={`system-prompt:${index}`} className="ob-subsection rounded-[14px] p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge>{index + 1}</Badge>
                  <Badge>system</Badge>
                </div>
                <MessageContentDetail content={message.content} maxHeightClassName="max-h-[28rem]" />
              </div>
            ))}
          </div>
        )}
      </InspectorDisclosure>

      <InspectorDisclosure
        title="Stored Session Messages"
        description="runtime 持久化后的 AI SDK 风格消息时间线，直接展示 role + content。"
        badge={props.messages.length}
      >
        {props.messages.length === 0 ? (
          <EmptyState title="No session messages" description="Open a session to inspect stored message records." />
        ) : (
          <div className="space-y-2">
            {props.messages.map((message) => (
              <article key={message.id} className="ob-subsection rounded-[14px] p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge>{message.role}</Badge>
                  {message.runId ? <Badge>{message.runId}</Badge> : null}
                  <MessageToolRefChips content={message.content} />
                  <span className="text-xs text-muted-foreground">{formatTimestamp(message.createdAt)}</span>
                </div>
                <MessageContentDetail content={message.content} maxHeightClassName="max-h-48" />
                {message.metadata ? (
                  <div className="mt-3">
                    <JsonBlock title="Metadata" value={message.metadata} />
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </InspectorDisclosure>
    </section>
  );
}

function ModelCallTimelineCard(props: { traces: ModelCallTrace[] }) {
  return (
    <section className="ob-section space-y-3 rounded-[16px] p-4">
      <InspectorPanelHeader
        title="Model Call Timeline"
        description="按 step 顺序查看真正送给模型的 message list，以及模型返回的 tool call / tool result / 原始 payload。"
      />
      {props.traces.length === 0 ? (
        <EmptyState title="No LLM trace" description="Load run steps to inspect the exact model-facing message list." />
      ) : (
        <div className="space-y-3">
          {props.traces.map((trace) => (
            <ModelCallTraceCard key={trace.id} trace={trace} />
          ))}
        </div>
      )}
    </section>
  );
}

function ModelCallTraceCard(props: { trace: ModelCallTrace }) {
  const { trace } = props;

  return (
    <article className="ob-subsection rounded-[16px] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{`step ${trace.seq}`}</Badge>
        <Badge>{trace.name ?? trace.input.model ?? "model_call"}</Badge>
        <Badge className={statusTone(trace.status)}>{trace.status}</Badge>
        {trace.agentName ? <Badge>{trace.agentName}</Badge> : null}
        {trace.input.provider ? <Badge>{trace.input.provider}</Badge> : null}
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <InsightRow label="Model" value={trace.input.model ?? "n/a"} />
        <InsightRow label="Canonical Ref" value={trace.input.canonicalModelRef ?? "n/a"} />
        <InsightRow label="Messages" value={String(trace.input.messageCount ?? trace.input.messages.length)} />
        <InsightRow label="Finish" value={trace.output.finishReason ?? "n/a"} />
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <CatalogLine label="runtime tools" value={trace.input.runtimeToolNames.length} />
        <CatalogLine label="active tools" value={trace.input.activeToolNames.length} />
        <CatalogLine label="tool calls" value={trace.output.toolCalls.length} />
        <CatalogLine label="tool results" value={trace.output.toolResults.length} />
      </div>

      {(trace.output.stepType || trace.output.usage) ? (
        <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <InsightRow label="AI SDK Step" value={trace.output.stepType ?? "n/a"} />
          <InsightRow
            label="Input Tokens"
            value={typeof trace.output.usage?.inputTokens === "number" ? String(trace.output.usage.inputTokens) : "n/a"}
          />
          <InsightRow
            label="Output Tokens"
            value={typeof trace.output.usage?.outputTokens === "number" ? String(trace.output.usage.outputTokens) : "n/a"}
          />
          <InsightRow
            label="Total Tokens"
            value={typeof trace.output.usage?.totalTokens === "number" ? String(trace.output.usage.totalTokens) : "n/a"}
          />
        </div>
      ) : null}

      {trace.output.text ? (
        <div className="mt-3 rounded-[18px] border border-border bg-muted/20 p-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Assistant Reply</p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-foreground/80">{trace.output.text}</pre>
        </div>
      ) : null}

      {trace.input.activeToolNames.length > 0 ? (
        <div className="mt-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Active Tools In This Call</p>
          <ToolNameChips names={trace.input.activeToolNames} emptyLabel="No active tool names recorded." />
        </div>
      ) : null}

      <div className="mt-3 space-y-2">
        <InspectorDisclosure
          title="LLM Messages"
          description="这一段就是当前 step 真正送给模型的 message list。"
          badge={trace.input.messages.length}
        >
          <ModelMessageList traceId={trace.id} messages={trace.input.messages} />
        </InspectorDisclosure>

        {(trace.output.toolCalls.length > 0 || trace.output.toolResults.length > 0) ? (
          <InspectorDisclosure
            title="Tool Calls And Results"
            description="查看这次 model call 产生的 tool 调用参数，以及回填给模型的结果。"
            badge={trace.output.toolCalls.length + trace.output.toolResults.length}
          >
            <div className="space-y-4">
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Tool Calls</p>
                {trace.output.toolCalls.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No tool calls recorded.</p>
                ) : (
                  <div className="space-y-2">
                    {trace.output.toolCalls.map((toolCall, index) => (
                      <div key={`${trace.id}:tool-call:${index}`} className="ob-subsection rounded-[14px] p-3">
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <Badge>{toolCall.toolName ?? "unknown"}</Badge>
                          {toolCall.toolCallId ? <Badge>{toolCall.toolCallId}</Badge> : null}
                        </div>
                        <PayloadValueView value={toolCall.input ?? {}} maxHeightClassName="max-h-56" mode="input" />
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Tool Results</p>
                {trace.output.toolResults.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No tool results recorded.</p>
                ) : (
                  <div className="space-y-2">
                    {trace.output.toolResults.map((toolResult, index) => (
                      <div key={`${trace.id}:tool-result:${index}`} className="ob-subsection rounded-[14px] p-3">
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <Badge>{toolResult.toolName ?? "unknown"}</Badge>
                          {toolResult.toolCallId ? <Badge>{toolResult.toolCallId}</Badge> : null}
                        </div>
                        <PayloadValueView value={toolResult.output} maxHeightClassName="max-h-56" mode="result" />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </InspectorDisclosure>
        ) : null}

        <InspectorDisclosure
          title="Raw Step Payload"
          description="保留原始 step.input / step.output，便于核对 audit 记录。"
          badge="raw"
        >
          <div className="space-y-2">
            {trace.output.content && trace.output.content.length > 0 ? <JsonBlock title="AI SDK Content" value={trace.output.content} /> : null}
            {trace.output.reasoning && trace.output.reasoning.length > 0 ? <JsonBlock title="AI SDK Reasoning" value={trace.output.reasoning} /> : null}
            {trace.output.request ? <JsonBlock title="AI SDK Request" value={trace.output.request} /> : null}
            {trace.output.response ? <JsonBlock title="AI SDK Response" value={trace.output.response} /> : null}
            {trace.output.providerMetadata ? <JsonBlock title="Provider Metadata" value={trace.output.providerMetadata} /> : null}
            {trace.output.warnings && trace.output.warnings.length > 0 ? <JsonBlock title="Warnings" value={trace.output.warnings} /> : null}
            <JsonBlock title="Raw Input" value={trace.rawInput ?? {}} />
            <JsonBlock title="Raw Output" value={trace.rawOutput ?? {}} />
          </div>
        </InspectorDisclosure>
      </div>
    </article>
  );
}

function RunStepsCard(props: { steps: RunStep[] }) {
  return (
    <section className="ob-section space-y-3 rounded-[16px] p-4">
      <InspectorPanelHeader
        title="Run Steps"
        description="这里看 runtime 级别的 step timeline，包括 step 类型、状态以及原始 input / output。"
      />
      {props.steps.length === 0 ? (
        <EmptyState title="No steps" description="Run steps appear here after the selected run starts executing." />
      ) : (
        <div className="space-y-3">
          {props.steps.map((step) => (
            <article key={step.id} className="ob-subsection rounded-[14px] p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Badge>{`step ${step.seq}`}</Badge>
                <Badge>{step.stepType}</Badge>
                <Badge className={statusTone(step.status)}>{step.status}</Badge>
                {step.name ? <Badge>{step.name}</Badge> : null}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <JsonBlock title="Input" value={step.input ?? {}} />
                <JsonBlock title="Output" value={step.output ?? {}} />
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function SessionEventsCard(props: { events: SessionEventContract[] }) {
  return (
    <section className="ob-section space-y-3 rounded-[16px] p-4">
      <InspectorPanelHeader
        title="Session Events"
        description="这里看 SSE event feed，适合核对前端实时流、cursor 以及 event payload。"
      />
      {props.events.length === 0 ? (
        <EmptyState title="No events" description="SSE events appear here when the current session emits runtime updates." />
      ) : (
        <div className="space-y-3">
          {props.events.map((event) => (
            <article key={event.id} className="ob-subsection rounded-[14px] p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Badge>{event.event}</Badge>
                {event.runId ? <Badge>{event.runId}</Badge> : null}
                <span className="text-xs text-muted-foreground">cursor {event.cursor}</span>
              </div>
              <JsonBlock title={formatTimestamp(event.createdAt)} value={event.data} />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export {
  RuntimeActivityCard,
  LlmSummaryCard,
  SessionContextCard,
  ModelCallTimelineCard,
  ModelCallTraceCard,
  RunStepsCard,
  SessionEventsCard
};
