import { useState, type ReactNode } from "react";

import type { Message } from "@oah/api-contracts";

import { Badge } from "../../components/ui/badge";
import { cn } from "../../lib/utils";

import {
  contentToolRefs,
  type ModelCallTrace,
  type ModelCallTraceMessage,
  type ModelCallTraceRuntimeTool,
  type ModelCallTraceToolServer
} from "../support";
import {
  CatalogLine,
  EmptyState,
  InsightRow,
  JsonBlock,
  PayloadValueView,
  modelMessageTone
} from "../primitives";

export const ACTION_INPUT_UNSET_VALUE = "__unset__";

function InspectorPanelHeader(props: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-foreground">{props.title}</p>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">{props.description}</p>
      </div>
      {props.action ? <div className="shrink-0">{props.action}</div> : null}
    </div>
  );
}

function MessageToolRefChips(props: { content: Message["content"] }) {
  const refs = contentToolRefs(props.content);
  if (refs.length === 0) {
    return null;
  }

  return (
    <>
      {refs.map((ref, index) => (
        <Badge key={`${ref.type}:${ref.toolCallId}:${index}`}>{`${ref.type}:${ref.toolName}`}</Badge>
      ))}
    </>
  );
}

function MessageContentDetail(props: { content: Message["content"]; maxHeightClassName?: string }) {
  if (typeof props.content === "string") {
    return (
      <pre className={cn("min-w-0 overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-foreground/80", props.maxHeightClassName)}>
        {props.content}
      </pre>
    );
  }

  if (props.content.length === 0) {
    return <p className="text-sm text-muted-foreground">Empty message parts.</p>;
  }

  return (
    <div className="min-w-0 space-y-2">
      {props.content.map((part, index) => (
        <div key={`${part.type}:${index}`} className="ob-subsection min-w-0 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge>{index + 1}</Badge>
            <Badge>{part.type}</Badge>
            {"toolName" in part ? <Badge>{part.toolName}</Badge> : null}
            {"toolCallId" in part ? <Badge>{part.toolCallId}</Badge> : null}
          </div>
          {part.type === "text" ? (
            <pre className={cn("min-w-0 overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-foreground/80", props.maxHeightClassName)}>
              {part.text}
            </pre>
          ) : part.type === "reasoning" ? (
            <pre className={cn("min-w-0 overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-foreground/80", props.maxHeightClassName)}>
              {part.text}
            </pre>
          ) : part.type === "tool-call" ? (
            <PayloadValueView value={part.input ?? {}} maxHeightClassName={props.maxHeightClassName} mode="input" />
          ) : part.type === "tool-result" ? (
            <PayloadValueView value={part.output} maxHeightClassName={props.maxHeightClassName} mode="result" />
          ) : (
            <PayloadValueView value={part} maxHeightClassName={props.maxHeightClassName} />
          )}
        </div>
      ))}
    </div>
  );
}

function InspectorDisclosure(props: {
  title: string;
  description?: string;
  badge?: string | number;
  children: ReactNode;
}) {
  return (
    <details className="overflow-hidden rounded-xl border border-border bg-background">
      <summary className="list-none cursor-pointer px-4 py-3 transition hover:bg-muted/30">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{props.title}</p>
            {props.description ? <p className="mt-1 text-xs leading-6 text-muted-foreground">{props.description}</p> : null}
          </div>
          {props.badge !== undefined ? <Badge>{String(props.badge)}</Badge> : null}
        </div>
      </summary>
      <div className="border-t border-border p-3">{props.children}</div>
    </details>
  );
}

function ToolNameChips(props: { names: string[]; emptyLabel: string }) {
  if (props.names.length === 0) {
    return <p className="text-sm text-muted-foreground">{props.emptyLabel}</p>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {props.names.map((name) => (
        <Badge key={name}>{name}</Badge>
      ))}
    </div>
  );
}

function RuntimeToolList(props: { tools: ModelCallTraceRuntimeTool[] }) {
  if (props.tools.length === 0) {
    return <p className="text-sm text-muted-foreground">No runtime tool definitions recorded.</p>;
  }

  return (
    <div className="space-y-2">
      {props.tools.map((tool) => (
        <div key={tool.name} className="ob-subsection p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{tool.name}</Badge>
            {tool.retryPolicy ? <Badge>{tool.retryPolicy}</Badge> : null}
          </div>
          {tool.description ? <p className="mt-2 text-xs leading-6 text-foreground/80">{tool.description}</p> : null}
          {"inputSchema" in tool ? (
            <div className="mt-3">
              <JsonBlock title="Input Schema" value={tool.inputSchema} />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ToolServerList(props: { servers: ModelCallTraceToolServer[] }) {
  if (props.servers.length === 0) {
    return <p className="text-sm text-muted-foreground">No external tool server metadata recorded.</p>;
  }

  return (
    <div className="space-y-2">
      {props.servers.map((server) => (
        <div key={server.name} className="ob-subsection px-3 py-2 text-xs leading-6 text-foreground/80">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{server.name}</Badge>
            {server.transportType ? <Badge>{server.transportType}</Badge> : null}
            {server.toolPrefix ? <Badge>{server.toolPrefix}</Badge> : null}
            {server.timeout !== undefined ? <Badge>{`${server.timeout}ms`}</Badge> : null}
          </div>
          {server.include && server.include.length > 0 ? <p className="mt-2">include: {server.include.join(", ")}</p> : null}
          {server.exclude && server.exclude.length > 0 ? <p className="mt-1">exclude: {server.exclude.join(", ")}</p> : null}
        </div>
      ))}
    </div>
  );
}

function ToolSnapshotBrowser(props: {
  runtimeTools: ModelCallTraceRuntimeTool[];
  runtimeToolNames: string[];
  activeToolNames: string[];
  toolServers: ModelCallTraceToolServer[];
}) {
  const [selectedKey, setSelectedKey] = useState("");
  const runtimeEntries = props.runtimeTools.map((tool) => ({
      key: `runtime:${tool.name}`,
      kind: "runtime" as const,
      name: tool.name,
      searchName: tool.name.toLowerCase(),
      active: props.activeToolNames.includes(tool.name),
      detail: tool
    }));
  const serverEntries = props.toolServers.map((server) => ({
      key: `server:${server.name}`,
      kind: "server" as const,
      name: server.name,
      searchName: server.name.toLowerCase(),
      active: false,
      detail: server
    }));
  const entries = [...runtimeEntries, ...serverEntries].sort((left, right) => left.searchName.localeCompare(right.searchName));
  const activeEntry = entries.find((entry) => entry.key === selectedKey) ?? entries[0] ?? null;

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-3">
        <CatalogLine label="runtimeDefs" value={props.runtimeTools.length} />
        <CatalogLine label="activeTools" value={props.activeToolNames.length} />
        <CatalogLine label="toolServers" value={props.toolServers.length} />
      </div>

      {entries.length === 0 ? (
        <EmptyState title="No tool snapshot" description="Run a session with tool exposure to inspect runtime tools and tool servers here." />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(260px,0.82fr)_minmax(0,1.18fr)]">
          <div className="space-y-3">
            <div className="rounded-[18px] border border-border/70 bg-background/70 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Directory</p>
                  <p className="mt-1 text-sm font-medium text-foreground">Tools and servers</p>
                </div>
                <Badge variant="outline">{entries.length}</Badge>
              </div>

              <div className="mt-4 space-y-4">
                <div>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Runtime Tools</p>
                    <Badge variant="secondary">{runtimeEntries.length}</Badge>
                  </div>
                  {runtimeEntries.length === 0 ? (
                    <p className="mt-2 text-sm text-muted-foreground">No runtime tool definitions recorded.</p>
                  ) : (
                    <div className="mt-2 space-y-1.5">
                      {runtimeEntries.map((entry) => (
                        <button
                          key={entry.key}
                          className={cn(
                            "w-full rounded-[14px] border-l-2 px-3 py-2.5 text-left transition",
                            activeEntry?.key === entry.key
                              ? "border-foreground bg-muted/45"
                              : "border-border bg-muted/10 hover:border-foreground/50 hover:bg-muted/25"
                          )}
                          onClick={() => setSelectedKey(entry.key)}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <p className="truncate text-sm font-medium text-foreground">{entry.name}</p>
                            {entry.active ? <Badge variant="secondary">active</Badge> : null}
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {entry.detail.retryPolicy ? `Retry ${entry.detail.retryPolicy}` : "Runtime definition"}
                          </p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="border-t border-border/70 pt-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Tool Servers</p>
                    <Badge variant="secondary">{serverEntries.length}</Badge>
                  </div>
                  {serverEntries.length === 0 ? (
                    <p className="mt-2 text-sm text-muted-foreground">No external tool server metadata recorded.</p>
                  ) : (
                    <div className="mt-2 space-y-1.5">
                      {serverEntries.map((entry) => (
                        <button
                          key={entry.key}
                          className={cn(
                            "w-full rounded-[14px] border-l-2 px-3 py-2.5 text-left transition",
                            activeEntry?.key === entry.key
                              ? "border-foreground bg-muted/45"
                              : "border-border bg-muted/10 hover:border-foreground/50 hover:bg-muted/25"
                          )}
                          onClick={() => setSelectedKey(entry.key)}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <p className="truncate text-sm font-medium text-foreground">{entry.name}</p>
                            {entry.detail.transportType ? <Badge variant="outline">{entry.detail.transportType}</Badge> : null}
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {entry.detail.toolPrefix ? `Prefix ${entry.detail.toolPrefix}` : "Server metadata"}
                          </p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="grid gap-3 lg:grid-cols-1">
              <div className="rounded-[18px] border border-border/70 bg-muted/10 p-4">
                <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Active Tool Names</p>
                <div className="mt-3">
                  <ToolNameChips names={props.activeToolNames} emptyLabel="No active tool names recorded." />
                </div>
              </div>
              <div className="rounded-[18px] border border-border/70 bg-muted/10 p-4">
                <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Runtime Tool Names</p>
                <div className="mt-3">
                  <ToolNameChips names={props.runtimeToolNames} emptyLabel="No runtime tool names recorded." />
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-[18px] border border-border/70 bg-background/70 p-4">
            {activeEntry?.kind === "runtime" ? (
              <div className="space-y-4">
                <div className="border-b border-border/70 pb-4">
                  <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Runtime Tool</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <p className="text-lg font-semibold text-foreground">{activeEntry.detail.name}</p>
                    {activeEntry.active ? <Badge variant="secondary">active</Badge> : null}
                    {activeEntry.detail.retryPolicy ? <Badge variant="outline">{activeEntry.detail.retryPolicy}</Badge> : null}
                  </div>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    {activeEntry.detail.description ?? "This runtime tool did not record a description."}
                  </p>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <InsightRow label="Exposure" value={activeEntry.active ? "active" : "listed only"} />
                  <InsightRow label="Retry Policy" value={activeEntry.detail.retryPolicy ?? "n/a"} />
                </div>

                {activeEntry.detail.inputSchema !== undefined ? (
                  <JsonBlock title="Input Schema" value={activeEntry.detail.inputSchema} />
                ) : null}
              </div>
            ) : activeEntry?.kind === "server" ? (
              <div className="space-y-4">
                <div className="border-b border-border/70 pb-4">
                  <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Tool Server</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <p className="text-lg font-semibold text-foreground">{activeEntry.detail.name}</p>
                    {activeEntry.detail.transportType ? <Badge variant="outline">{activeEntry.detail.transportType}</Badge> : null}
                    {activeEntry.detail.toolPrefix ? <Badge variant="secondary">{activeEntry.detail.toolPrefix}</Badge> : null}
                  </div>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">Server routing, prefix, timeout, and include/exclude rules.</p>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <InsightRow label="Transport" value={activeEntry.detail.transportType ?? "n/a"} />
                  <InsightRow label="Prefix" value={activeEntry.detail.toolPrefix ?? "n/a"} />
                  <InsightRow label="Timeout" value={activeEntry.detail.timeout !== undefined ? `${activeEntry.detail.timeout}ms` : "n/a"} />
                  <InsightRow label="Include Rules" value={activeEntry.detail.include?.length ? String(activeEntry.detail.include.length) : "0"} />
                </div>

                {activeEntry.detail.include && activeEntry.detail.include.length > 0 ? (
                  <JsonBlock title="Include" value={activeEntry.detail.include} />
                ) : null}
                {activeEntry.detail.exclude && activeEntry.detail.exclude.length > 0 ? (
                  <JsonBlock title="Exclude" value={activeEntry.detail.exclude} />
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function TraceSummaryStat(props: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-l border-border/70 pl-4">
      <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">{props.label}</p>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm font-medium leading-6 text-foreground [overflow-wrap:anywhere]">
        {props.value}
      </p>
    </div>
  );
}

function DetailSection(props: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="ob-section space-y-3 rounded-[18px] p-5">
      <InspectorPanelHeader title={props.title} description={props.description} />
      {props.children}
    </section>
  );
}

function TimelineListButton(props: {
  active: boolean;
  eyebrow: string;
  title: string;
  subtitle?: string;
  meta?: string;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "w-full border-l px-4 py-3 text-left transition",
        props.active
          ? "border-foreground/90 bg-muted/45"
          : "border-border/70 hover:border-foreground/40 hover:bg-muted/25"
      )}
      onClick={props.onClick}
    >
      <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">{props.eyebrow}</p>
      <p className="mt-1 text-sm font-medium text-foreground">{props.title}</p>
      {props.subtitle ? <p className="mt-1 text-xs leading-6 text-foreground/75">{props.subtitle}</p> : null}
      {props.meta ? <p className="mt-1 text-[11px] text-muted-foreground">{props.meta}</p> : null}
    </button>
  );
}

function ModelMessageList(props: { traceId: string; messages: ModelCallTraceMessage[] }) {
  if (props.messages.length === 0) {
    return <p className="text-sm text-muted-foreground">No recorded model-facing messages.</p>;
  }

  return (
    <div className="space-y-2">
      {props.messages.map((message, index) => (
        <div key={`${props.traceId}:message:${index}`} className="ob-subsection p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge>{index + 1}</Badge>
            <span className={cn("rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.14em]", modelMessageTone(message.role))}>
              {message.role}
            </span>
            <MessageToolRefChips content={message.content} />
          </div>
          <MessageContentDetail content={message.content} maxHeightClassName="max-h-72" />
        </div>
      ))}
    </div>
  );
}

export {
  InspectorPanelHeader,
  MessageToolRefChips,
  MessageContentDetail,
  InspectorDisclosure,
  ToolNameChips,
  RuntimeToolList,
  ToolServerList,
  ToolSnapshotBrowser,
  TraceSummaryStat,
  DetailSection,
  TimelineListButton,
  ModelMessageList
};
export type { ModelCallTrace, ModelCallTraceMessage, ModelCallTraceRuntimeTool, ModelCallTraceToolServer };
