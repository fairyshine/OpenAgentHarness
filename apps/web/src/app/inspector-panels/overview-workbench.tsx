import { CircleSlash2 } from "lucide-react";

import type { Message, Run, RunStep, Session, SessionEventContract, Workspace } from "@oah/api-contracts";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

import { formatTimestamp, statusTone, type ModelCallTrace } from "../support";
import { CatalogLine, compactPreviewText, EmptyState, EntityPreview, InsightRow } from "../primitives";

import { DetailSection, InspectorDisclosure, InspectorPanelHeader, TimelineListButton, TraceSummaryStat } from "./shared";

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
              subtitle={latestEvent?.runId ? `run ${latestEvent.runId}` : "engine event"}
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

export { OverviewWorkbench, InspectorOverviewCard, OverviewRecordsCard };
