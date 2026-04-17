import { memo } from "react";

import { Layers3, Network, Orbit, Palette, SquareTerminal } from "lucide-react";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { probeTone, streamTone, toneBadgeClass, type StatusSemanticTone } from "../support";
import { useHealthStore } from "../stores/health-store";
import { useSettingsStore } from "../stores/settings-store";
import { useStreamStore } from "../stores/stream-store";
import { useUiStore } from "../stores/ui-store";
import { appThemeOptions, isAppThemeName } from "../theme";
import type { AppThemeName } from "../theme";
import type { useAppController } from "../use-app-controller";

type HeaderProps = ReturnType<typeof useAppController>["headerProps"];
type AppHeaderProps = HeaderProps & {
  theme: AppThemeName;
  onThemeChange: (theme: AppThemeName) => void;
};

function StatusPill(props: { label: string; value: string; tone: StatusSemanticTone; icon: typeof Network }) {
  const Icon = props.icon;
  return (
    <div className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] ${toneBadgeClass(props.tone)}`}>
      <Icon className="h-3.5 w-3.5" />
      <span className="uppercase tracking-[0.14em] opacity-72">{props.label}</span>
      <span className="font-medium normal-case tracking-normal">{props.value}</span>
    </div>
  );
}

function AppHeaderImpl(props: AppHeaderProps) {
  const healthStatus = useHealthStore((state) => state.healthStatus);
  const streamState = useStreamStore((state) => state.streamState);
  const surfaceMode = useUiStore((state) => state.surfaceMode);
  const setSurfaceMode = useUiStore((state) => state.setSurfaceMode);
  const consoleOpen = useUiStore((state) => state.consoleOpen);
  const setConsoleOpen = useUiStore((state) => state.setConsoleOpen);
  const serviceScope = useSettingsStore((state) => state.serviceScope);
  const setServiceScope = useSettingsStore((state) => state.setServiceScope);

  return (
    <header className="app-topbar h-[60px] flex items-center justify-between gap-4 px-4 sm:px-6 overflow-hidden min-w-0">
      <div className="flex min-w-0 items-center gap-3">
        <div className="topbar-chip relative flex h-10 w-10 shrink-0 items-center justify-center rounded-[1rem] p-1.5">
          <img src="/oah-logo.png" alt="Open Agent Harness logo" className="h-full w-full object-contain dark:hidden" />
          <img src="/oah-logo-dark.png" alt="" aria-hidden="true" className="hidden h-full w-full object-contain dark:block" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-[15px] font-semibold tracking-tight text-foreground">Open Agent Harness</p>
            <span className="topbar-chip hidden rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-foreground/48 md:inline-flex">
              Beta
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <StatusPill icon={Network} label="Health" value={healthStatus} tone={probeTone(healthStatus)} />
            <StatusPill icon={Orbit} label="Stream" value={streamState} tone={streamTone(streamState)} />
          </div>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-2.5">
        <div className="topbar-chip flex shrink-0 items-center gap-1 rounded-2xl p-1">
          <div className="hidden items-center gap-1.5 pl-2 sm:flex">
            <Palette className="h-3.5 w-3.5 text-foreground/48" />
            <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-foreground/46">Theme</span>
          </div>
          <Select
            value={props.theme}
            onValueChange={(value) => {
              if (isAppThemeName(value)) {
                props.onThemeChange(value);
              }
            }}
          >
            <SelectTrigger
              size="sm"
              className="topbar-chip-hoverable h-7 min-w-[110px] border-none bg-transparent px-2 text-xs text-foreground shadow-none focus-visible:ring-2 focus-visible:ring-black/10 sm:min-w-[132px]"
            >
              <SelectValue placeholder="Theme" />
            </SelectTrigger>
            <SelectContent className="min-w-[132px]">
              {appThemeOptions.map((theme) => (
                <SelectItem key={theme.value} value={theme.value}>
                  {theme.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="topbar-chip flex shrink-0 items-center gap-1 rounded-2xl p-1">
          <div className="hidden items-center gap-1.5 pl-2 xl:flex">
            <Layers3 className="h-3.5 w-3.5 text-foreground/48" />
            <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-foreground/46">Service</span>
          </div>
          <Select value={serviceScope} onValueChange={setServiceScope}>
            <SelectTrigger
              size="sm"
              className="topbar-chip-hoverable h-7 min-w-[132px] border-none bg-transparent px-2 text-xs text-foreground shadow-none focus-visible:ring-2 focus-visible:ring-black/10 sm:min-w-[156px]"
            >
              <SelectValue placeholder="Service" />
            </SelectTrigger>
            <SelectContent className="min-w-[156px]">
              {props.serviceScopeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Tabs value={surfaceMode} onValueChange={(value) => setSurfaceMode(value as HeaderProps["surfaceMode"])}>
          <TabsList className="topbar-chip h-9 rounded-2xl p-1">
            <TabsTrigger value="runtime" className="topbar-tabs-trigger h-7 rounded-xl px-3 text-xs">
              Runtime
            </TabsTrigger>
            <TabsTrigger value="storage" className="topbar-tabs-trigger h-7 rounded-xl px-3 text-xs">
              Storage
            </TabsTrigger>
            <TabsTrigger value="provider" className="topbar-tabs-trigger h-7 rounded-xl px-3 text-xs">
              Provider
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <button
          type="button"
          onClick={() => setConsoleOpen((current) => !current)}
          className={`inline-flex h-9 items-center gap-2 rounded-2xl border px-3 text-xs transition ${
            consoleOpen
              ? "topbar-control-active text-foreground"
              : "topbar-control-idle"
          }`}
        >
          <SquareTerminal className="h-4 w-4" />
          <span className="hidden sm:inline">Console</span>
        </button>
      </div>
    </header>
  );
}

export const AppHeader = memo(AppHeaderImpl);
