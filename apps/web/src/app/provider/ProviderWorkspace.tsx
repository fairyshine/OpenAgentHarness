import type { ReactNode } from "react";

import { Database, Network, Orbit, RefreshCw, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { StatusTile, EmptyState, EntityPreview } from "../primitives";
import { probeTone } from "../support";
import type { useAppController } from "../use-app-controller";
import { InspectorPanelHeader } from "../inspector-panels";

type ProviderProps = ReturnType<typeof useAppController>["providerSurfaceProps"];

function Section(props: { title: string; description: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="ob-section space-y-4 rounded-[20px] p-5">
      <InspectorPanelHeader title={props.title} description={props.description} action={props.action} />
      {props.children}
    </section>
  );
}

export function ProviderWorkspace(props: ProviderProps) {
  const providerCount = props.modelProviders.length;
  const baseUrlLabel = props.connection.baseUrl.trim() || "not configured";
  const storageLabel = props.healthReport ? `${props.healthReport.storage.primary} / ${props.healthReport.storage.runQueue}` : "unknown";
  const readinessLabel = props.readinessReport?.status ?? "unknown";

  return (
    <section className="workspace-pane flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
        <div className="space-y-4">
          <section className="ob-section rounded-[20px] p-5">
            <InspectorPanelHeader
              title="Provider"
              description="管理全局连接、服务健康、模型 provider 列表，以及单次模型验证。这里替代原来的侧边栏 Server 面板和 Inspector Model。"
            />

            <div className="mt-5 grid gap-4 lg:grid-cols-6">
              <div className="border-l border-border/70 pl-4">
                <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Base URL</p>
                <p className="mt-2 text-sm font-medium text-foreground">{baseUrlLabel}</p>
              </div>
              <div className="border-l border-border/70 pl-4">
                <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Health</p>
                <p className="mt-2 text-sm font-medium text-foreground">{props.healthStatus}</p>
              </div>
              <div className="border-l border-border/70 pl-4">
                <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Readiness</p>
                <p className="mt-2 text-sm font-medium text-foreground">{readinessLabel}</p>
              </div>
              <div className="border-l border-border/70 pl-4">
                <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Stream</p>
                <p className="mt-2 text-sm font-medium text-foreground">{props.streamState}</p>
              </div>
              <div className="border-l border-border/70 pl-4">
                <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Storage</p>
                <p className="mt-2 text-sm font-medium text-foreground">{storageLabel}</p>
              </div>
              <div className="border-l border-border/70 pl-4">
                <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Providers</p>
                <p className="mt-2 text-sm font-medium text-foreground">{providerCount}</p>
              </div>
            </div>
          </section>

          <div className="grid gap-4 2xl:grid-cols-[minmax(360px,0.82fr)_minmax(0,1.18fr)]">
            <div className="space-y-4">
              <Section
                title="Connection"
                description="配置 API 地址、token，并触发健康检查或 SSE 重连。"
                action={
                  <div className="flex gap-2">
                    <Button variant="secondary" size="sm" onClick={props.pingHealth}>
                      <Network className="h-4 w-4" />
                      Health
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => props.setStreamRevision((current) => current + 1)}>
                      <RefreshCw className="h-4 w-4" />
                      SSE
                    </Button>
                  </div>
                }
              >
                <Input
                  value={props.connection.baseUrl}
                  onChange={(event) => props.setConnection((current) => ({ ...current, baseUrl: event.target.value }))}
                  placeholder="Base URL"
                />
                <Input
                  value={props.connection.token}
                  onChange={(event) => props.setConnection((current) => ({ ...current, token: event.target.value }))}
                  placeholder="Bearer token (optional)"
                />

                <div className="grid gap-3 sm:grid-cols-2">
                  <StatusTile icon={Network} label="Health" value={props.healthStatus} tone={probeTone(props.healthStatus)} />
                  <StatusTile
                    icon={Orbit}
                    label="Stream"
                    value={props.streamState}
                    tone={props.streamState === "open" || props.streamState === "listening" ? "emerald" : props.streamState === "error" ? "rose" : "sky"}
                  />
                  <StatusTile icon={Database} label="Readiness" value={readinessLabel} tone={probeTone(readinessLabel)} />
                  <StatusTile
                    icon={Database}
                    label="Mirror"
                    value={props.healthReport?.checks.historyMirror ?? "unknown"}
                    tone={probeTone(props.healthReport?.checks.historyMirror ?? "idle")}
                  />
                </div>
              </Section>

              <Section title="Diagnostics" description="保留原始 health / readiness 结果，便于快速核对服务与依赖状态。">
                {props.healthReport || props.readinessReport ? (
                  <div className="space-y-3">
                    {props.healthReport ? <EntityPreview title="healthz" data={props.healthReport} /> : null}
                    {props.readinessReport ? <EntityPreview title="readyz" data={props.readinessReport} /> : null}
                  </div>
                ) : (
                  <EmptyState title="No diagnostics yet" description="Run Health once to load service and dependency diagnostics." />
                )}
              </Section>
            </div>

            <div className="space-y-4">
              <Section
                title="Model Providers"
                description="查看当前服务暴露出的 provider 能力、包来源与推荐用法。"
                action={
                  <Button variant="secondary" size="sm" onClick={props.refreshModelProviders}>
                    <RefreshCw className="h-4 w-4" />
                    Refresh
                  </Button>
                }
              >
                {props.modelProviders.length === 0 ? (
                  <EmptyState title="No providers" description="Refresh the provider index after the connection is available." />
                ) : (
                  <div className="space-y-2">
                    {props.modelProviders.map((provider) => (
                      <div key={provider.id} className="rounded-[18px] border border-border/70 bg-background/75 p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge>{provider.id}</Badge>
                          <span className="text-xs text-muted-foreground">{provider.packageName}</span>
                          {provider.requiresUrl ? <Badge variant="outline">requires URL</Badge> : null}
                        </div>
                        <p className="mt-2 text-sm text-foreground">{provider.description}</p>
                        <p className="mt-2 text-xs leading-6 text-muted-foreground">{provider.useCases.join(" · ")}</p>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section title="Model Playground" description="做单次模型验证，不依赖当前 Inspector 状态，也不打断正在看的 session 诊断。">
                <Input
                  value={props.modelDraft.model}
                  onChange={(event) => props.setModelDraft((current) => ({ ...current, model: event.target.value }))}
                  placeholder="Model"
                />
                <Textarea
                  value={props.modelDraft.prompt}
                  onChange={(event) => props.setModelDraft((current) => ({ ...current, prompt: event.target.value }))}
                  className="min-h-32"
                  placeholder="Prompt"
                />
                <Button onClick={props.generateOnce} disabled={props.generateBusy}>
                  <Sparkles className="h-4 w-4" />
                  Generate
                </Button>
                {props.generateOutput ? (
                  <EntityPreview title={props.generateOutput.model} data={props.generateOutput} />
                ) : (
                  <EmptyState title="No output" description="Generate output appears here after a single-shot request." />
                )}
              </Section>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
