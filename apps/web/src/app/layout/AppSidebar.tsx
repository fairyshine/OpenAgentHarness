import { memo, useRef, useState } from "react";

import { formatSystemProfileDisplayName } from "@oah/api-contracts";
import type { PlatformAssetKind } from "@oah/api-contracts";
import {
  Bot,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  FolderPlus,
  Layers3,
  Network,
  Orbit,
  Palette,
  RefreshCw,
  Server,
  Settings2,
  SquareTerminal,
  Table2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useShallow } from "zustand/shallow";

import { useHealthStore } from "../stores/health-store";
import { useSettingsStore } from "../stores/settings-store";
import { useStreamStore } from "../stores/stream-store";
import { useUiStore } from "../stores/ui-store";
import { probeTone, streamTone, type StatusSemanticTone, type SurfaceMode } from "../support";
import { appThemeOptions, isAppThemeName } from "../theme";
import { ProviderSidebar } from "./ProviderSidebar";
import { RuntimeSidebar } from "./RuntimeSidebar";
import { StorageSidebar } from "./StorageSidebar";
import { SidebarAssetDialogs, type SidebarAssetDialogsHandle } from "./SidebarAssetDialogs";
import { StatusPill, blurActiveDialogElement } from "./sidebar-primitives";
import type { SidebarProps } from "./sidebar-types";

function AppSidebarImpl(props: SidebarProps) {
  const healthStatus = useHealthStore((state) => state.healthStatus);
  const streamState = useStreamStore((state) => state.streamState);
  const { surfaceMode, setSurfaceMode } = useUiStore(
    useShallow((state) => ({
      surfaceMode: state.surfaceMode,
      setSurfaceMode: state.setSurfaceMode
    }))
  );
  const { consoleOpen, setConsoleOpen } = useUiStore(
    useShallow((state) => ({
      consoleOpen: state.consoleOpen,
      setConsoleOpen: state.setConsoleOpen
    }))
  );
  const { sidebarCollapsed, setSidebarCollapsed } = useUiStore(
    useShallow((state) => ({
      sidebarCollapsed: state.sidebarCollapsed,
      setSidebarCollapsed: state.setSidebarCollapsed
    }))
  );
  const { serviceScope, setServiceScope } = useSettingsStore(
    useShallow((state) => ({
      serviceScope: state.serviceScope,
      setServiceScope: state.setServiceScope
    }))
  );
  const assetDialogsRef = useRef<SidebarAssetDialogsHandle>(null);
  const [workspaceCreateBusy, setWorkspaceCreateBusy] = useState(false);
  const icon = surfaceIcon(surfaceMode);
  const title = surfaceTitle(surfaceMode);
  const currentThemeLabel = appThemeOptions.find((option) => option.value === props.theme)?.label ?? props.theme;
  const serviceScopeOptions = props.serviceScopeOptions ?? [];
  const serverLabel = props.systemProfile ? formatSystemProfileDisplayName(props.systemProfile) : "unknown";
  const serverTone: StatusSemanticTone = props.systemProfile?.deploymentKind === "oap" ? "emerald" : props.systemProfile ? "sky" : "amber";
  const collapseButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-8 w-8 rounded-xl text-muted-foreground hover:bg-white/55 hover:text-foreground"
      onClick={() => setSidebarCollapsed((current) => !current)}
      title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
    >
      {sidebarCollapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
    </Button>
  );

  function openAssetManager(kind: PlatformAssetKind = "runtime") {
    assetDialogsRef.current?.openAssetManager(kind);
  }

  function setWorkspaceCreatorOpen(open: boolean) {
    if (!open) {
      blurActiveDialogElement();
    }
    props.setShowWorkspaceCreator(open);
  }

  return (
    <>
      <div
        className={`relative min-h-0 shrink-0 overflow-visible transition-[width] duration-300 ease-out ${
          sidebarCollapsed ? "w-0" : "w-[288px]"
        }`}
      >
        <div
          className={`absolute left-3 top-3 z-40 transition-all duration-300 ease-out ${
            sidebarCollapsed
              ? "pointer-events-auto translate-x-0 opacity-100"
              : "pointer-events-none -translate-x-2 opacity-0"
          }`}
        >
          <div className="rounded-2xl border border-border/70 bg-background/86 p-1 shadow-[0_10px_24px_-20px_rgba(17,17,17,0.38)] backdrop-blur-md">
            {collapseButton}
          </div>
        </div>
        <aside
          className={`app-sidebar-surface absolute inset-y-0 left-0 flex min-h-0 w-[288px] shrink-0 flex-col border-r border-black/10 transition-[transform,opacity] duration-300 ease-out ${
            sidebarCollapsed ? "pointer-events-none -translate-x-full opacity-0" : "translate-x-0 opacity-100"
          }`}
        >
          <>
            <div className="sidebar-surface-hero border-b border-black/8 px-4 py-3">
              <div className="flex items-center gap-3">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="sidebar-surface-brand-logo flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-black/8 bg-white/50 p-1.5">
                      <img src="/oah-logo.png" alt="Open Agent Harness logo" className="h-full w-full object-contain dark:hidden" />
                      <img src="/oah-logo-dark.png" alt="" aria-hidden="true" className="hidden h-full w-full object-contain dark:block" />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={10} align="start" className="max-w-none items-start rounded-2xl bg-popover p-3 text-popover-foreground shadow-[0_24px_48px_-32px_rgba(17,17,17,0.45)] ring-1 ring-foreground/10">
                    <div className="space-y-2">
                      <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Server Status</p>
                      <div className="flex flex-wrap gap-1.5">
                        <StatusPill icon={Network} label="Health" value={healthStatus} tone={probeTone(healthStatus)} />
                        <StatusPill icon={Orbit} label="Stream" value={streamState} tone={streamTone(streamState)} />
                        <StatusPill icon={Server} label="Server" value={serverLabel} tone={serverTone} />
                      </div>
                    </div>
                  </TooltipContent>
                </Tooltip>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-semibold leading-5 tracking-tight text-foreground">Open Agent Harness</p>
                  <div className="mt-0.5 flex min-w-0 items-center gap-2">
                    <p className="truncate text-xs leading-4 text-muted-foreground">WebUI</p>
                    <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[9px] font-medium uppercase tracking-[0.14em] text-foreground/52">
                      Beta
                    </Badge>
                  </div>
                </div>
                {collapseButton}
              </div>

              <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="sidebar-surface-switch group mt-3 flex h-10 w-full items-center gap-2 rounded-xl border border-black/8 bg-white/34 px-2.5 text-left transition hover:bg-white/54 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/10"
                aria-label="Surface"
              >
                <span className="sidebar-surface-hero-icon flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground">
                  {icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium leading-5 tracking-tight text-foreground">{title}</span>
                </span>
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition group-data-[state=open]:rotate-180" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[260px] rounded-2xl p-1.5">
              <DropdownMenuLabel className="px-2 pt-1 pb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Surface
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup value={surfaceMode} onValueChange={(value) => setSurfaceMode(value as SurfaceMode)}>
                <DropdownMenuRadioItem value="engine" className="mx-1 rounded-xl px-2 py-2">
                  <Bot className="h-4 w-4 text-muted-foreground" />
                  Engine
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="storage" disabled={!props.storageInspectionEnabled} className="mx-1 rounded-xl px-2 py-2">
                  <Table2 className="h-4 w-4 text-muted-foreground" />
                  Storage
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="provider" className="mx-1 rounded-xl px-2 py-2">
                  <Network className="h-4 w-4 text-muted-foreground" />
                  Provider
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {surfaceMode === "storage" ? (
            <div className="h-full overflow-y-auto overflow-x-hidden">
              <StorageSidebar {...props} />
            </div>
          ) : surfaceMode === "provider" ? (
            <div className="h-full overflow-y-auto overflow-x-hidden">
              <ProviderSidebar {...props} />
            </div>
          ) : (
            <RuntimeSidebar {...props} onOpenRuntimeAssets={() => openAssetManager("runtime")} />
          )}
        </div>

        <div className="shrink-0 space-y-2 border-t border-black/8 px-3 py-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="info-panel info-panel-hoverable h-auto w-full justify-between rounded-2xl px-3 py-3 text-left">
                <span className="flex min-w-0 items-center gap-3">
                  <span className="ob-list-item-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-xl">
                    <Settings2 className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">Settings</span>
                    <span className="block truncate text-xs leading-5 text-muted-foreground">Theme: {currentThemeLabel}</span>
                  </span>
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-[260px] min-w-[260px] rounded-2xl p-2">
              <DropdownMenuLabel className="px-2 pt-1 pb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Interface Settings
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <div className="px-2 py-2">
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  <Layers3 className="h-3.5 w-3.5" />
                  Service
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">Choose which service namespace the sidebar and storage views use.</p>
                <Select value={serviceScope} onValueChange={setServiceScope}>
                  <SelectTrigger className="mt-2 h-9 w-full rounded-xl border-black/10 bg-white/68 text-xs shadow-none" aria-label="Service scope">
                    <SelectValue placeholder="Service" />
                  </SelectTrigger>
                  <SelectContent align="start">
                    {serviceScopeOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <DropdownMenuSeparator />
              <div className="px-2 py-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                      <SquareTerminal className="h-3.5 w-3.5" />
                      Console
                    </div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">Show the runtime event console below the engine view.</p>
                  </div>
                  <Switch checked={consoleOpen} onCheckedChange={setConsoleOpen} aria-label="Toggle console" />
                </div>
              </div>
              <DropdownMenuSeparator />
              <div className="px-2 py-2">
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  <Palette className="h-3.5 w-3.5" />
                  Theme
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">Choose the visual theme for the web app.</p>
              </div>
              <DropdownMenuRadioGroup
                value={props.theme}
                onValueChange={(value) => {
                  if (isAppThemeName(value)) {
                    props.onThemeChange(value);
                  }
                }}
              >
                {appThemeOptions.map((theme) => (
                  <DropdownMenuRadioItem key={theme.value} value={theme.value} className="mx-1 rounded-xl px-2 py-2">
                    {theme.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        </>
        </aside>
      </div>

      <Dialog open={props.showWorkspaceCreator} onOpenChange={setWorkspaceCreatorOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Workspace</DialogTitle>
            <DialogDescription>
              Leave Root path empty to create a managed workspace folder named with a generated workspace id.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              value={props.workspaceDraft.name ?? ""}
              onChange={(event) => props.setWorkspaceDraft((current) => ({ ...current, name: event.target.value }))}
              placeholder="Workspace name"
            />
            <div className="space-y-1">
              <Select
                value={props.workspaceDraft.runtime?.trim() ?? ""}
                onValueChange={(value) => props.setWorkspaceDraft((current) => ({ ...current, runtime: value }))}
              >
                <SelectTrigger className="h-10 flex-1 rounded-xl border-black/10 bg-white/68 text-sm shadow-none" aria-label="Workspace runtime">
                  <SelectValue placeholder={props.workspaceRuntimes.length > 0 ? "Select runtime" : "No runtimes available"} />
                </SelectTrigger>
                <SelectContent align="start">
                  {props.workspaceRuntimes.length > 0 ? (
                    props.workspaceRuntimes.map((runtime) => (
                      <SelectItem key={runtime} value={runtime}>
                        {runtime}
                      </SelectItem>
                    ))
                  ) : (
                    <SelectItem value="__no_templates__" disabled>
                      No runtimes available
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
              <p className="px-1 text-xs leading-5 text-muted-foreground">
                {props.workspaceRuntimes.length > 0
                  ? "Choose a runtime, or manage packages from Asset Manager."
                  : "Runtime list is empty. Open Asset Manager to upload a .zip package."}
              </p>
            </div>
            <Input
              value={props.workspaceDraft.rootPath ?? ""}
              onChange={(event) => props.setWorkspaceDraft((current) => ({ ...current, rootPath: event.target.value }))}
              placeholder="Root path"
            />
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Input
                  value={props.workspaceDraft.ownerId ?? ""}
                  onChange={(event) => props.setWorkspaceDraft((current) => ({ ...current, ownerId: event.target.value }))}
                  placeholder="Owner ID (optional)"
                />
                <p className="px-1 text-xs leading-5 text-muted-foreground">
                  Only set this when the workspace should stay bound to one owner.
                </p>
              </div>
              <div className="space-y-1">
                <Input
                  value={props.workspaceDraft.serviceName ?? ""}
                  onChange={(event) =>
                    props.setWorkspaceDraft((current) => ({ ...current, serviceName: event.target.value }))
                  }
                  placeholder="Service name (optional)"
                />
                <p className="px-1 text-xs leading-5 text-muted-foreground">
                  Leave empty to use the default OAH service namespace.
                </p>
              </div>
            </div>
            <p className="px-1 text-xs leading-5 text-muted-foreground">
              Managed mode: auto-create under workspace_dir/workspace_id. Custom mode: use the path you enter here.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                openAssetManager("runtime");
              }}
            >
              <Settings2 className="h-4 w-4" />
              Assets
            </Button>
            <Button variant="outline" onClick={() => props.refreshWorkspaceRuntimes()}>
              <RefreshCw className="h-4 w-4" />
              Runtimes
            </Button>
            <Button
              disabled={workspaceCreateBusy || !props.workspaceDraft.name.trim()}
              onClick={async () => {
                if (workspaceCreateBusy) {
                  return;
                }
                setWorkspaceCreateBusy(true);
                try {
                  await props.createWorkspace();
                } finally {
                  setWorkspaceCreateBusy(false);
                }
              }}
            >
              {workspaceCreateBusy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <FolderPlus className="h-4 w-4" />}
              {workspaceCreateBusy ? "Creating" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SidebarAssetDialogs ref={assetDialogsRef} props={props} />
    </>
  );
}

function surfaceIcon(surfaceMode: SurfaceMode) {
  if (surfaceMode === "storage") {
    return <Table2 className="h-4 w-4" />;
  }
  if (surfaceMode === "provider") {
    return <Network className="h-4 w-4" />;
  }
  return <Bot className="h-4 w-4" />;
}

function surfaceTitle(surfaceMode: SurfaceMode) {
  if (surfaceMode === "storage") {
    return "Storage";
  }
  if (surfaceMode === "provider") {
    return "Provider";
  }
  return "Engine";
}

export const AppSidebar = memo(AppSidebarImpl);

