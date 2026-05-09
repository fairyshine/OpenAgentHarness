import { Network, Orbit, RefreshCw, Workflow } from "lucide-react";
import { useShallow } from "zustand/shallow";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { useHealthStore } from "../stores/health-store";
import { useModelsStore } from "../stores/models-store";
import { useSettingsStore } from "../stores/settings-store";
import { useStreamStore } from "../stores/stream-store";
import { useUiStore } from "../stores/ui-store";
import { probeTone, streamTone, toneBadgeClass } from "../support";
import { SidebarActionItem, SidebarMetric, SidebarSection } from "./sidebar-primitives";
import type { SidebarProps } from "./sidebar-types";

function ProviderSidebar(props: SidebarProps) {
  const { connection, modelDraft, setModelDraft } = useSettingsStore(
    useShallow((state) => ({
      connection: state.connection,
      modelDraft: state.modelDraft,
      setModelDraft: state.setModelDraft
    }))
  );
  const { healthStatus, readinessReport } = useHealthStore(
    useShallow((state) => ({
      healthStatus: state.healthStatus,
      readinessReport: state.readinessReport
    }))
  );
  const { modelProviders, platformModels } = useModelsStore(
    useShallow((state) => ({
      modelProviders: state.modelProviders,
      platformModels: state.platformModels
    }))
  );
  const { streamState } = useStreamStore(
    useShallow((state) => ({
      streamState: state.streamState
    }))
  );
  const { setStreamRevision } = useUiStore(
    useShallow((state) => ({
      setStreamRevision: state.setStreamRevision
    }))
  );
  const defaultModel = platformModels.find((model) => model.isDefault);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-4">
        <div className="space-y-5">
          <div className="space-y-3 border-b border-black/8 pb-4">
            <div className="grid grid-cols-2 gap-2">
              <SidebarMetric label="Health" value={healthStatus} tone={probeTone(healthStatus)} />
              <SidebarMetric label="Stream" value={streamState} tone={streamTone(streamState)} />
              <SidebarMetric label="Models" value={String(platformModels.length)} tone="emerald" />
              <SidebarMetric label="Providers" value={String(modelProviders.length)} tone="sky" />
            </div>
            <div className="space-y-2 border-l border-black/8 pl-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Base URL</p>
              <p className="truncate text-xs text-foreground">{connection.baseUrl || "not configured"}</p>
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="outline" className={toneBadgeClass(probeTone(readinessReport?.status ?? "unknown"))}>
                  {`ready ${readinessReport?.status ?? "unknown"}`}
                </Badge>
                {defaultModel ? <Badge variant="outline">default {defaultModel.id}</Badge> : null}
              </div>
            </div>
          </div>

          <SidebarSection title="Quick Actions">
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" className="h-10 justify-start rounded-2xl" onClick={props.pingHealth}>
                <Network className="h-4 w-4" />
                Health
              </Button>
              <Button variant="outline" className="h-10 justify-start rounded-2xl" onClick={() => setStreamRevision((current) => current + 1)}>
                <Orbit className="h-4 w-4" />
                SSE
              </Button>
              <Button variant="outline" className="h-10 justify-start rounded-2xl" onClick={props.refreshModelProviders}>
                <RefreshCw className="h-4 w-4" />
                Providers
              </Button>
              <Button variant="outline" className="h-10 justify-start rounded-2xl" onClick={props.refreshPlatformModels}>
                <Workflow className="h-4 w-4" />
                Models
              </Button>
            </div>
          </SidebarSection>

          <SidebarSection title="Models" description="点击切换当前 Playground 模型。">
            <div className="space-y-1.5">
              {platformModels.length === 0 ? (
                <p className="text-sm text-muted-foreground">当前还没有加载到平台模型。</p>
              ) : (
                platformModels.map((model) => (
                  <SidebarActionItem
                    key={model.id}
                    icon={<Workflow className="h-4 w-4" />}
                    title={model.id}
                    subtitle={[
                      model.modelName,
                      model.provider,
                      model.hasKey ? "key ready" : "no key"
                    ].join(" · ")}
                    badge={model.isDefault ? "default" : model.provider}
                    active={modelDraft.model === model.id}
                    onClick={() => setModelDraft((current) => ({ ...current, model: model.id }))}
                  />
                ))
              )}
            </div>
          </SidebarSection>
        </div>
      </div>
    </div>
  );
}

export { ProviderSidebar };
