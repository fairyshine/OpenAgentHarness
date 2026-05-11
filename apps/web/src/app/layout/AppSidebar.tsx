import { memo, useMemo, useRef, useState } from "react";

import { formatSystemProfileDisplayName } from "@oah/api-contracts";
import {
  Bot,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  FileUp,
  FolderPlus,
  Layers3,
  Network,
  Orbit,
  Palette,
  RefreshCw,
  Search,
  Server,
  Settings2,
  SquareTerminal,
  Table2,
  Trash2,
  Upload,
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
import { ScrollArea } from "@/components/ui/scroll-area";
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
import {
  StatusPill,
  blurActiveDialogElement,
  deferDialogOpen
} from "./sidebar-primitives";
import type { SidebarProps } from "./sidebar-types";

type RuntimeUploadMode = "create" | "update";

interface RuntimeUploadDraft {
  mode: RuntimeUploadMode;
  file: File | null;
  name: string;
  overwrite: boolean;
  selectAfterUpload: boolean;
  returnToManager: boolean;
}

function deriveRuntimeNameFromFile(file: File): string {
  const normalized = file.name.replace(/\.zip$/i, "").replace(/[^a-zA-Z0-9_-]/g, "_");
  return normalized || "runtime";
}

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
  const uploadTemplateInputRef = useRef<HTMLInputElement>(null);
  const updateTemplateInputRef = useRef<HTMLInputElement>(null);
  const [runtimeUploadDraft, setRuntimeUploadDraft] = useState<RuntimeUploadDraft>({
    mode: "create",
    file: null,
    name: "",
    overwrite: false,
    selectAfterUpload: false,
    returnToManager: false
  });
  const [showRuntimeUploadDialog, setShowRuntimeUploadDialog] = useState(false);
  const [showRuntimeManagerDialog, setShowRuntimeManagerDialog] = useState(false);
  const [runtimeMutationBusy, setRuntimeMutationBusy] = useState(false);
  const [runtimePendingDelete, setRuntimePendingDelete] = useState("");
  const [runtimeManagerSearch, setRuntimeManagerSearch] = useState("");
  const [workspaceCreateBusy, setWorkspaceCreateBusy] = useState(false);

  const icon = surfaceIcon(surfaceMode);
  const title = surfaceTitle(surfaceMode);
  const subtitle =
    surfaceMode === "storage"
      ? "Inspect Postgres tables and Redis keyspace."
      : surfaceMode === "provider"
        ? "Connection, health, and provider registry."
        : "Navigate workspaces and sessions.";
  const currentThemeLabel = appThemeOptions.find((option) => option.value === props.theme)?.label ?? props.theme;
  const serviceScopeOptions = props.serviceScopeOptions ?? [];
  const serverLabel = props.systemProfile ? formatSystemProfileDisplayName(props.systemProfile) : "unknown";
  const serverTone: StatusSemanticTone = props.systemProfile?.deploymentKind === "oap" ? "emerald" : props.systemProfile ? "sky" : "amber";
  const selectedRuntimeName = props.workspaceDraft.runtime?.trim() ?? "";
  const runtimeUploadTitle = runtimeUploadDraft.mode === "update" ? "Update Runtime" : "Upload Runtime";
  const runtimeUploadDescription =
    runtimeUploadDraft.mode === "update"
      ? `Replace runtime "${runtimeUploadDraft.name}" with the selected .zip package.`
      : "Upload a .zip file containing the runtime folder structure.";
  const runtimeUploadSubmitLabel = runtimeUploadDraft.mode === "update" ? "Update" : "Upload";
  const filteredRuntimeNames = useMemo(() => {
    const query = runtimeManagerSearch.trim().toLowerCase();
    if (!query) {
      return props.workspaceRuntimes;
    }
    return props.workspaceRuntimes.filter((runtime) => runtime.toLowerCase().includes(query));
  }, [props.workspaceRuntimes, runtimeManagerSearch]);
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

  function openRuntimeUploadDialog(
    file: File,
    options?: { mode?: RuntimeUploadMode; name?: string; selectAfterUpload?: boolean; returnToManager?: boolean }
  ) {
    blurActiveDialogElement();
    setRuntimeUploadDraft({
      mode: options?.mode ?? "create",
      file,
      name: options?.name ?? deriveRuntimeNameFromFile(file),
      overwrite: options?.mode === "update",
      selectAfterUpload: options?.selectAfterUpload ?? false,
      returnToManager: options?.returnToManager ?? true
    });
    setShowRuntimeManagerDialog(false);
    props.setShowWorkspaceCreator(false);
    deferDialogOpen(() => setShowRuntimeUploadDialog(true));
  }

  function openRuntimeUpdatePicker(runtimeName: string) {
    setRuntimeUploadDraft((current) => ({
      ...current,
      mode: "update",
      name: runtimeName,
      file: null,
      overwrite: true,
      selectAfterUpload: false,
      returnToManager: true
    }));
    deferDialogOpen(() => updateTemplateInputRef.current?.click());
  }

  function openRuntimeManagerDialog() {
    blurActiveDialogElement();
    props.setShowWorkspaceCreator(false);
    setShowRuntimeUploadDialog(false);
    deferDialogOpen(() => {
      setShowRuntimeManagerDialog(true);
      void props.refreshWorkspaceRuntimes(true);
    });
  }

  function setWorkspaceCreatorOpen(open: boolean) {
    if (!open) {
      blurActiveDialogElement();
    }
    props.setShowWorkspaceCreator(open);
  }

  function setRuntimeManagerOpen(open: boolean) {
    if (!open) {
      blurActiveDialogElement();
      setRuntimePendingDelete("");
    }
    setShowRuntimeManagerDialog(open);
  }

  function setRuntimeUploadOpen(open: boolean) {
    if (open) {
      setShowRuntimeUploadDialog(true);
      return;
    }

    closeRuntimeUploadDialog({ returnToManager: runtimeUploadDraft.returnToManager });
  }

  function closeRuntimeUploadDialog(options?: { returnToManager?: boolean }) {
    blurActiveDialogElement();
    setShowRuntimeUploadDialog(false);
    const shouldReturnToManager = options?.returnToManager ?? false;
    if (shouldReturnToManager) {
      deferDialogOpen(() => {
        setShowRuntimeManagerDialog(true);
        void props.refreshWorkspaceRuntimes(true);
      });
    }
  }

  async function submitRuntimeUpload() {
    if (!runtimeUploadDraft.file || !runtimeUploadDraft.name.trim()) {
      return;
    }

    setRuntimeMutationBusy(true);
    try {
      const runtimeName = runtimeUploadDraft.name.trim();
      const ok =
        runtimeUploadDraft.mode === "update"
          ? await props.updateWorkspaceRuntime(runtimeName, runtimeUploadDraft.file)
          : await props.uploadWorkspaceRuntime(runtimeUploadDraft.file, runtimeName, runtimeUploadDraft.overwrite);
      if (ok) {
        const shouldReturnToManager = runtimeUploadDraft.returnToManager;
        setRuntimeManagerSearch(runtimeName);
        closeRuntimeUploadDialog({ returnToManager: shouldReturnToManager });
        setRuntimeUploadDraft({
          mode: "create",
          file: null,
          name: "",
          overwrite: false,
          selectAfterUpload: false,
          returnToManager: false
        });
        if (runtimeUploadDraft.selectAfterUpload) {
          props.setWorkspaceDraft((current) => ({
            ...current,
            runtime: runtimeName
          }));
        }
      }
    } finally {
      setRuntimeMutationBusy(false);
    }
  }

  async function deleteRuntime(runtimeName: string) {
    if (!runtimeName.trim()) {
      return;
    }

    setRuntimeMutationBusy(true);
    try {
      const ok = await props.deleteWorkspaceRuntime(runtimeName);
      if (ok) {
        if (selectedRuntimeName === runtimeName) {
          props.setWorkspaceDraft((current) => ({
            ...current,
            runtime: ""
          }));
        }
        setRuntimePendingDelete("");
      }
    } finally {
      setRuntimeMutationBusy(false);
    }
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
            <RuntimeSidebar {...props} onOpenRuntimeManager={openRuntimeManagerDialog} />
          )}
        </div>

        <div className="shrink-0 border-t border-black/8 px-3 py-3">
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

      <input
        ref={uploadTemplateInputRef}
        type="file"
        accept=".zip"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          openRuntimeUploadDialog(file, { selectAfterUpload: props.showWorkspaceCreator, returnToManager: true });
          event.target.value = "";
        }}
      />
      <input
        ref={updateTemplateInputRef}
        type="file"
        accept=".zip"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          openRuntimeUploadDialog(file, {
            mode: "update",
            name: runtimeUploadDraft.name || selectedRuntimeName,
            returnToManager: true
          });
          event.target.value = "";
        }}
      />

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
                  ? "Choose a runtime, or manage packages from Runtime Manager."
                  : "Runtime list is empty. Open Runtime Manager to upload a .zip package."}
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
                openRuntimeManagerDialog();
              }}
            >
              <Settings2 className="h-4 w-4" />
              Manage
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

      <Dialog open={showRuntimeManagerDialog} onOpenChange={setRuntimeManagerOpen}>
        <DialogContent className="max-h-[86vh] max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto]">
          <DialogHeader>
            <DialogTitle>Runtime Manager</DialogTitle>
            <DialogDescription>Upload, replace, and remove workspace runtime packages.</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-4 overflow-hidden">
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="relative min-w-0">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={runtimeManagerSearch}
                  onChange={(event) => setRuntimeManagerSearch(event.target.value)}
                  placeholder="Search runtimes"
                  className="h-10 rounded-xl border-black/10 bg-white/68 pl-9 text-sm shadow-none"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="default"
                  onClick={() => uploadTemplateInputRef.current?.click()}
                  disabled={!props.workspaceManagementEnabled || runtimeMutationBusy}
                >
                  <Upload className="h-4 w-4" />
                  Upload
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => props.refreshWorkspaceRuntimes()}
                  disabled={!props.workspaceManagementEnabled || runtimeMutationBusy}
                >
                  <RefreshCw className="h-4 w-4" />
                  Refresh
                </Button>
                <Badge variant="outline">
                  {filteredRuntimeNames.length === props.workspaceRuntimes.length
                    ? `${props.workspaceRuntimes.length} runtimes`
                    : `${filteredRuntimeNames.length}/${props.workspaceRuntimes.length}`}
                </Badge>
              </div>
            </div>
            {props.workspaceManagementEnabled ? (
              props.workspaceRuntimes.length > 0 ? (
                <ScrollArea className="h-[min(52vh,420px)] rounded-2xl border border-black/8">
                  <div className="divide-y divide-black/8">
                    {filteredRuntimeNames.length === 0 ? (
                      <div className="px-4 py-8 text-center">
                        <p className="text-sm font-medium text-foreground">No matching runtimes</p>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">Try a shorter search term.</p>
                      </div>
                    ) : null}
                    {filteredRuntimeNames.map((runtime) => {
                      const isDeleting = runtimePendingDelete === runtime;
                      return (
                        <div key={runtime} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground">{runtime}</p>
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">
                              {isDeleting
                                ? "Confirm deletion, or cancel to keep this runtime."
                                : selectedRuntimeName === runtime
                                  ? "Selected for the next workspace."
                                  : "Available for new workspaces."}
                            </p>
                          </div>
                          <div className="flex shrink-0 flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-8 rounded-xl"
                              onClick={() => openRuntimeUpdatePicker(runtime)}
                              disabled={runtimeMutationBusy}
                            >
                              <FileUp className="h-3.5 w-3.5" />
                              Update
                            </Button>
                            {isDeleting ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-8 rounded-xl"
                                onClick={() => setRuntimePendingDelete("")}
                                disabled={runtimeMutationBusy}
                              >
                                Cancel
                              </Button>
                            ) : null}
                            <Button
                              type="button"
                              variant={isDeleting ? "destructive" : "outline"}
                              size="sm"
                              className="h-8 rounded-xl"
                              onClick={() => {
                                if (isDeleting) {
                                  void deleteRuntime(runtime);
                                  return;
                                }
                                setRuntimePendingDelete(runtime);
                              }}
                              disabled={runtimeMutationBusy}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              {isDeleting ? "Confirm" : "Delete"}
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
              ) : (
                <div className="rounded-2xl border border-dashed border-black/12 px-4 py-8 text-center">
                  <p className="text-sm font-medium text-foreground">No runtimes yet</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">Upload a .zip package to make it available for new workspaces.</p>
                </div>
              )
            ) : (
              <div className="rounded-2xl border border-dashed border-black/12 px-4 py-8 text-center">
                <p className="text-sm font-medium text-foreground">Runtime management is unavailable</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">This server is running without multi-workspace runtime management.</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                blurActiveDialogElement();
                setShowRuntimeManagerDialog(false);
              }}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showRuntimeUploadDialog} onOpenChange={setRuntimeUploadOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{runtimeUploadTitle}</DialogTitle>
            <DialogDescription>{runtimeUploadDescription}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              value={runtimeUploadDraft.name}
              onChange={(event) =>
                setRuntimeUploadDraft((current) => ({
                  ...current,
                  name: event.target.value.replace(/[^a-zA-Z0-9_-]/g, "_")
                }))
              }
              placeholder="Runtime name"
              disabled={runtimeUploadDraft.mode === "update"}
            />
            <p className="px-1 text-xs leading-5 text-muted-foreground">
              Only alphanumeric characters, hyphens, and underscores are allowed.
            </p>
            {runtimeUploadDraft.mode === "create" ? (
              <div className="flex items-center gap-2">
                <Switch
                  checked={runtimeUploadDraft.overwrite}
                  onCheckedChange={(checked) =>
                    setRuntimeUploadDraft((current) => ({
                      ...current,
                      overwrite: checked
                    }))
                  }
                  id="overwrite-runtime"
                />
                <label htmlFor="overwrite-runtime" className="text-sm text-muted-foreground">
                  Overwrite if exists
                </label>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                closeRuntimeUploadDialog({ returnToManager: runtimeUploadDraft.returnToManager });
              }}
              disabled={runtimeMutationBusy}
            >
              Cancel
            </Button>
            <Button
              disabled={!runtimeUploadDraft.name.trim() || !runtimeUploadDraft.file || runtimeMutationBusy}
              onClick={() => {
                void submitRuntimeUpload();
              }}
            >
              {runtimeUploadDraft.mode === "update" ? <FileUp className="h-4 w-4" /> : <Upload className="h-4 w-4" />}
              {runtimeUploadSubmitLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
