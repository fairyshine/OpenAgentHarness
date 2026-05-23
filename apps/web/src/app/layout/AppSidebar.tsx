import { memo, useMemo, useRef, useState } from "react";

import { formatSystemProfileDisplayName } from "@oah/api-contracts";
import type { PlatformAssetKind, PlatformAssetRecord } from "@oah/api-contracts";
import {
  Boxes,
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
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
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
type AssetEditorMode = "create" | "update";

interface RuntimeUploadDraft {
  mode: RuntimeUploadMode;
  file: File | null;
  name: string;
  overwrite: boolean;
  selectAfterUpload: boolean;
  returnToManager: boolean;
}

interface AssetEditorDraft {
  mode: AssetEditorMode;
  kind: PlatformAssetKind;
  name: string;
  overwrite: boolean;
  primaryText: string;
  secondaryText: string;
}

const ASSET_COLLECTION_LABELS: Record<PlatformAssetKind, string> = {
  runtime: "Runtimes",
  model: "Models",
  tool: "Tools",
  skill: "Skills"
};

const DEFAULT_MODEL_ASSET_TEXT = `example-model:
  provider: openai
  name: gpt-5
`;

const DEFAULT_TOOL_DEFINITION_TEXT = `{
  "command": "node ./servers/example-tool/index.js"
}`;

const DEFAULT_SKILL_TEXT = `---
description: Describe what this skill helps with
---
# Example Skill

Write clear task-specific instructions here.
`;

function createDefaultAssetDraft(kind: PlatformAssetKind): AssetEditorDraft {
  return {
    mode: "create",
    kind,
    name: "",
    overwrite: false,
    primaryText:
      kind === "runtime"
        ? ""
        : kind === "model"
        ? DEFAULT_MODEL_ASSET_TEXT
        : kind === "tool"
          ? DEFAULT_TOOL_DEFINITION_TEXT
          : DEFAULT_SKILL_TEXT,
    secondaryText: "{}"
  };
}

function deriveRuntimeNameFromFile(file: File): string {
  const normalized = file.name.replace(/\.zip$/i, "").replace(/[^a-zA-Z0-9_-]/g, "_");
  return normalized || "runtime";
}

function assetDisplayName(asset: PlatformAssetRecord): string {
  if ("id" in asset) {
    return asset.id;
  }
  return asset.name;
}

function parseJsonObject(input: string): Record<string, unknown> {
  const parsed = JSON.parse(input);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON must be an object.");
  }
  return parsed as Record<string, unknown>;
}

function parseJsonStringMap(input: string): Record<string, string> {
  const trimmed = input.trim();
  if (!trimmed) {
    return {};
  }
  const parsed = parseJsonObject(trimmed);
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error(`"${key}" must be a string value.`);
    }
  }
  return parsed as Record<string, string>;
}

function assetSubtitle(kind: PlatformAssetKind, asset: PlatformAssetRecord): string {
  if (kind === "runtime") {
    return "Available for new workspaces";
  }
  if (kind === "model" && "provider" in asset) {
    return `${asset.provider}/${asset.modelName}${asset.url ? ` · ${asset.url}` : ""}`;
  }
  if (kind === "tool" && "transportType" in asset) {
    return `${asset.transportType}${asset.enabled ? "" : " · disabled"}${asset.toolPrefix ? ` · ${asset.toolPrefix}` : ""}`;
  }
  if (kind === "skill" && "description" in asset && asset.description) {
    return asset.description;
  }
  return "Platform asset";
}

function AssetList(props: {
  kind: PlatformAssetKind;
  items: PlatformAssetRecord[];
  pendingDelete: string;
  busy: boolean;
  onEdit: (asset: PlatformAssetRecord) => void;
  onAskDelete: (name: string) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (name: string) => void;
}) {
  if (props.items.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-black/12 px-4 py-8 text-center">
        <p className="text-sm font-medium text-foreground">No {ASSET_COLLECTION_LABELS[props.kind].toLowerCase()} found</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">Add an asset to make it available to the platform.</p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-[min(48vh,390px)] rounded-2xl border border-black/8">
      <div className="divide-y divide-black/8">
        {props.items.map((asset) => {
          const name = assetDisplayName(asset);
          const isDeleting = props.pendingDelete === name;
          return (
            <div key={`${props.kind}-${name}`} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{name}</p>
                <p className="mt-1 truncate text-xs leading-5 text-muted-foreground">
                  {isDeleting ? "Confirm deletion, or cancel to keep this asset." : assetSubtitle(props.kind, asset)}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-xl"
                  onClick={() => props.onEdit(asset)}
                  disabled={props.busy}
                >
                  <FileUp className="h-3.5 w-3.5" />
                  Update
                </Button>
                {isDeleting ? (
                  <Button type="button" variant="outline" size="sm" className="h-8 rounded-xl" onClick={props.onCancelDelete} disabled={props.busy}>
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
                      props.onConfirmDelete(name);
                      return;
                    }
                    props.onAskDelete(name);
                  }}
                  disabled={props.busy}
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
  );
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
  const [runtimeMutationBusy, setRuntimeMutationBusy] = useState(false);
  const [showAssetManagerDialog, setShowAssetManagerDialog] = useState(false);
  const [showAssetEditorDialog, setShowAssetEditorDialog] = useState(false);
  const [assetManagerTab, setAssetManagerTab] = useState<PlatformAssetKind>("model");
  const [assetManagerSearch, setAssetManagerSearch] = useState("");
  const [assetMutationBusy, setAssetMutationBusy] = useState(false);
  const [assetPendingDelete, setAssetPendingDelete] = useState("");
  const [assetEditorDraft, setAssetEditorDraft] = useState<AssetEditorDraft>(() => createDefaultAssetDraft("model"));
  const [assetEditorError, setAssetEditorError] = useState("");
  const [workspaceCreateBusy, setWorkspaceCreateBusy] = useState(false);

  const icon = surfaceIcon(surfaceMode);
  const title = surfaceTitle(surfaceMode);
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
  const currentAssetList = props.platformAssets[assetManagerTab]?.items ?? [];
  const filteredAssets = useMemo(() => {
    const query = assetManagerSearch.trim().toLowerCase();
    if (!query) {
      return currentAssetList;
    }
    return currentAssetList.filter((asset) => assetDisplayName(asset).toLowerCase().includes(query));
  }, [assetManagerSearch, currentAssetList]);
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
    setShowAssetManagerDialog(false);
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

  function openRuntimeAssetsDialog() {
    openAssetManagerDialog("runtime");
  }

  function openAssetManagerDialog(kind: PlatformAssetKind = assetManagerTab) {
    blurActiveDialogElement();
    props.setShowWorkspaceCreator(false);
    setShowRuntimeUploadDialog(false);
    setAssetManagerTab(kind);
    deferDialogOpen(() => {
      setShowAssetManagerDialog(true);
      void props.refreshPlatformAssets(kind, true);
    });
  }

  function setWorkspaceCreatorOpen(open: boolean) {
    if (!open) {
      blurActiveDialogElement();
    }
    props.setShowWorkspaceCreator(open);
  }

  function setRuntimeUploadOpen(open: boolean) {
    if (open) {
      setShowRuntimeUploadDialog(true);
      return;
    }

    closeRuntimeUploadDialog({ returnToManager: runtimeUploadDraft.returnToManager });
  }

  function setAssetManagerOpen(open: boolean) {
    if (!open) {
      blurActiveDialogElement();
      setAssetPendingDelete("");
    }
    setShowAssetManagerDialog(open);
  }

  function setAssetEditorOpen(open: boolean) {
    if (!open) {
      blurActiveDialogElement();
    }
    setShowAssetEditorDialog(open);
  }

  function closeRuntimeUploadDialog(options?: { returnToManager?: boolean }) {
    blurActiveDialogElement();
    setShowRuntimeUploadDialog(false);
    const shouldReturnToManager = options?.returnToManager ?? false;
    if (shouldReturnToManager) {
      deferDialogOpen(() => {
        setAssetManagerTab("runtime");
        setShowAssetManagerDialog(true);
        void props.refreshPlatformAssets("runtime", true);
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
          ? await props.updatePlatformRuntimeAsset(runtimeName, runtimeUploadDraft.file)
          : await props.uploadPlatformRuntimeAsset(runtimeUploadDraft.file, runtimeName, runtimeUploadDraft.overwrite);
      if (ok) {
        const shouldReturnToManager = runtimeUploadDraft.returnToManager;
        setAssetManagerSearch(runtimeName);
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

  async function deleteRuntime(runtimeName: string): Promise<boolean> {
    if (!runtimeName.trim()) {
      return false;
    }

    setRuntimeMutationBusy(true);
    try {
      const ok = await props.deletePlatformRuntimeAsset(runtimeName);
      if (ok) {
        if (selectedRuntimeName === runtimeName) {
          props.setWorkspaceDraft((current) => ({
            ...current,
            runtime: ""
          }));
        }
      }
      return ok;
    } finally {
      setRuntimeMutationBusy(false);
    }
  }

  function openCreateAssetEditor(kind: PlatformAssetKind) {
    if (kind === "runtime") {
      uploadTemplateInputRef.current?.click();
      return;
    }
    blurActiveDialogElement();
    setAssetEditorDraft(createDefaultAssetDraft(kind));
    setAssetEditorError("");
    setShowAssetManagerDialog(false);
    deferDialogOpen(() => setShowAssetEditorDialog(true));
  }

  function openUpdateAssetEditor(kind: PlatformAssetKind, asset: PlatformAssetRecord) {
    if (kind === "runtime") {
      openRuntimeUpdatePicker(assetDisplayName(asset));
      return;
    }
    const name = assetDisplayName(asset);
    setAssetEditorError("");
    setAssetEditorDraft({
      mode: "update",
      kind,
      name,
      overwrite: true,
      primaryText:
        kind === "model"
          ? `${name}:\n  provider: ${"provider" in asset ? asset.provider : "openai"}\n  name: ${"modelName" in asset ? asset.modelName : ""}\n${
              "url" in asset && asset.url ? `  url: ${asset.url}\n` : ""
            }`
          : kind === "tool"
            ? JSON.stringify(
                {
                  ...("enabled" in asset && !asset.enabled ? { enabled: false } : {}),
                  ...("transportType" in asset && asset.transportType === "http"
                    ? { url: "https://example.internal/mcp" }
                    : { command: `node ./servers/${name}/index.js` }),
                  ...("toolPrefix" in asset && asset.toolPrefix ? { expose: { tool_prefix: asset.toolPrefix } } : {})
                },
                null,
                2
              )
            : `# ${name}\n\nUpdate this skill's instructions.\n`,
      secondaryText: "{}"
    });
    setShowAssetManagerDialog(false);
    deferDialogOpen(() => setShowAssetEditorDialog(true));
  }

  async function submitAssetEditor() {
    const assetName = assetEditorDraft.name.trim();
    if (!assetName || assetMutationBusy) {
      return;
    }
    if (assetEditorDraft.kind === "runtime") {
      setShowAssetEditorDialog(false);
      deferDialogOpen(() => setShowAssetManagerDialog(true));
      return;
    }

    setAssetMutationBusy(true);
    setAssetEditorError("");
    try {
      let ok = false;
      if (assetEditorDraft.kind === "model") {
        ok =
          assetEditorDraft.mode === "update"
            ? await props.updatePlatformModelAsset(assetName, assetEditorDraft.primaryText)
            : await props.uploadPlatformModelAsset(assetName, assetEditorDraft.primaryText, assetEditorDraft.overwrite);
      } else if (assetEditorDraft.kind === "tool") {
        const definition = parseJsonObject(assetEditorDraft.primaryText);
        const serverFiles = parseJsonStringMap(assetEditorDraft.secondaryText);
        ok =
          assetEditorDraft.mode === "update"
            ? await props.updatePlatformToolAsset(assetName, definition, serverFiles)
            : await props.uploadPlatformToolAsset(assetName, definition, serverFiles, assetEditorDraft.overwrite);
      } else {
        const files = parseJsonStringMap(assetEditorDraft.secondaryText);
        ok =
          assetEditorDraft.mode === "update"
            ? await props.updatePlatformSkillAsset(assetName, assetEditorDraft.primaryText, files)
            : await props.uploadPlatformSkillAsset(assetName, assetEditorDraft.primaryText, files, assetEditorDraft.overwrite);
      }

      if (ok) {
        setAssetManagerSearch(assetName);
        setShowAssetEditorDialog(false);
        deferDialogOpen(() => {
          setShowAssetManagerDialog(true);
          void props.refreshPlatformAssets(assetEditorDraft.kind, true);
        });
      }
    } catch (error) {
      setAssetEditorError(error instanceof Error ? error.message : String(error));
    } finally {
      setAssetMutationBusy(false);
    }
  }

  async function deleteAsset(kind: PlatformAssetKind, name: string) {
    if (!name.trim()) {
      return;
    }
    if (kind === "runtime") {
      const ok = await deleteRuntime(name);
      if (ok) {
        setAssetPendingDelete("");
      }
      return;
    }

    setAssetMutationBusy(true);
    try {
      const ok =
        kind === "model"
          ? await props.deletePlatformModelAsset(name)
          : kind === "tool"
            ? await props.deletePlatformToolAsset(name)
            : await props.deletePlatformSkillAsset(name);
      if (ok) {
        setAssetPendingDelete("");
      }
    } finally {
      setAssetMutationBusy(false);
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
            <RuntimeSidebar {...props} onOpenRuntimeAssets={openRuntimeAssetsDialog} />
          )}
        </div>

        <div className="shrink-0 space-y-2 border-t border-black/8 px-3 py-3">
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-10 justify-center rounded-2xl bg-white/52 px-2 text-xs shadow-none col-span-2"
              onClick={() => openAssetManagerDialog()}
            >
              <Boxes className="h-4 w-4" />
              Assets
            </Button>
          </div>
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
                openAssetManagerDialog("runtime");
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

      <Dialog open={showAssetManagerDialog} onOpenChange={setAssetManagerOpen}>
        <DialogContent className="max-h-[86vh] max-w-3xl grid-rows-[auto_minmax(0,1fr)_auto]">
          <DialogHeader>
            <DialogTitle>Asset Manager</DialogTitle>
            <DialogDescription>Manage runtimes, models, tool servers, and skills.</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-4 overflow-hidden">
            <Tabs
              value={assetManagerTab}
              onValueChange={(value) => {
                const next = value as PlatformAssetKind;
                setAssetManagerTab(next);
                setAssetPendingDelete("");
                void props.refreshPlatformAssets(next, true);
              }}
              className="min-h-0"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <TabsList>
                  <TabsTrigger value="runtime">Runtimes</TabsTrigger>
                  <TabsTrigger value="model">Models</TabsTrigger>
                  <TabsTrigger value="tool">Tools</TabsTrigger>
                  <TabsTrigger value="skill">Skills</TabsTrigger>
                </TabsList>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    onClick={() => {
                      if (assetManagerTab === "runtime") {
                        uploadTemplateInputRef.current?.click();
                        return;
                      }
                      openCreateAssetEditor(assetManagerTab);
                    }}
                    disabled={assetMutationBusy || runtimeMutationBusy || (assetManagerTab === "runtime" && !props.workspaceManagementEnabled)}
                  >
                    <Upload className="h-4 w-4" />
                    Add
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => props.refreshPlatformAssets(assetManagerTab)}
                    disabled={assetMutationBusy || runtimeMutationBusy}
                  >
                    <RefreshCw className="h-4 w-4" />
                    Refresh
                  </Button>
                  <Badge variant="outline">
                    {filteredAssets.length === currentAssetList.length
                      ? `${currentAssetList.length} ${ASSET_COLLECTION_LABELS[assetManagerTab].toLowerCase()}`
                      : `${filteredAssets.length}/${currentAssetList.length}`}
                  </Badge>
                </div>
              </div>
              <div className="relative min-w-0">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={assetManagerSearch}
                  onChange={(event) => setAssetManagerSearch(event.target.value)}
                  placeholder={`Search ${ASSET_COLLECTION_LABELS[assetManagerTab].toLowerCase()}`}
                  className="h-10 rounded-xl border-black/10 bg-white/68 pl-9 text-sm shadow-none"
                />
              </div>
              {(["runtime", "model", "tool", "skill"] as PlatformAssetKind[]).map((kind) => (
                <TabsContent key={kind} value={kind} className="mt-0 min-h-0">
                  <AssetList
                    kind={kind}
                    items={kind === assetManagerTab ? filteredAssets : props.platformAssets[kind].items}
                    pendingDelete={assetPendingDelete}
                    busy={assetMutationBusy || runtimeMutationBusy}
                    onEdit={(asset) => {
                      if (kind === "runtime") {
                        openRuntimeUpdatePicker(assetDisplayName(asset));
                        return;
                      }
                      openUpdateAssetEditor(kind, asset);
                    }}
                    onCancelDelete={() => setAssetPendingDelete("")}
                    onAskDelete={(name) => setAssetPendingDelete(name)}
                    onConfirmDelete={(name) => void deleteAsset(kind, name)}
                  />
                </TabsContent>
              ))}
            </Tabs>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                blurActiveDialogElement();
                setShowAssetManagerDialog(false);
              }}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showAssetEditorDialog} onOpenChange={setAssetEditorOpen}>
        <DialogContent className="max-h-[86vh] max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {assetEditorDraft.mode === "update" ? "Update" : "Add"} {ASSET_COLLECTION_LABELS[assetEditorDraft.kind].slice(0, -1)}
            </DialogTitle>
            <DialogDescription>
              {assetEditorDraft.kind === "model"
                ? "Paste a single model YAML definition."
                : assetEditorDraft.kind === "tool"
                  ? "Provide one tool server definition and optional server files."
                  : "Provide SKILL.md content and optional supporting files."}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
            <Input
              value={assetEditorDraft.name}
              onChange={(event) =>
                setAssetEditorDraft((current) => ({
                  ...current,
                  name: event.target.value.replace(/[^a-zA-Z0-9._-]/g, "_")
                }))
              }
              placeholder="Asset name"
              disabled={assetEditorDraft.mode === "update"}
            />
            {assetEditorDraft.mode === "create" ? (
              <label className="flex items-center justify-between gap-3 rounded-xl border border-black/8 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="block font-medium text-foreground">Overwrite existing asset</span>
                </span>
                <Switch
                  checked={assetEditorDraft.overwrite}
                  onCheckedChange={(checked) => setAssetEditorDraft((current) => ({ ...current, overwrite: checked }))}
                />
              </label>
            ) : null}
            <div className="space-y-1.5">
              <Label>
                {assetEditorDraft.kind === "model"
                  ? "Model YAML"
                  : assetEditorDraft.kind === "tool"
                    ? "Tool definition JSON"
                    : "SKILL.md"}
              </Label>
              <Textarea
                value={assetEditorDraft.primaryText}
                onChange={(event) => setAssetEditorDraft((current) => ({ ...current, primaryText: event.target.value }))}
                className="min-h-[220px] resize-y rounded-xl border-black/10 bg-white/68 font-mono text-xs shadow-none"
                spellCheck={false}
              />
            </div>
            {assetEditorDraft.kind === "tool" || assetEditorDraft.kind === "skill" ? (
              <div className="space-y-1.5">
                <Label>{assetEditorDraft.kind === "tool" ? "Server files JSON" : "Supporting files JSON"}</Label>
                <Textarea
                  value={assetEditorDraft.secondaryText}
                  onChange={(event) => setAssetEditorDraft((current) => ({ ...current, secondaryText: event.target.value }))}
                  className="min-h-[120px] resize-y rounded-xl border-black/10 bg-white/68 font-mono text-xs shadow-none"
                  spellCheck={false}
                />
              </div>
            ) : null}
            {assetEditorError ? <p className="rounded-xl border border-destructive/25 bg-destructive/8 px-3 py-2 text-xs text-destructive">{assetEditorError}</p> : null}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowAssetEditorDialog(false);
                deferDialogOpen(() => setShowAssetManagerDialog(true));
              }}
            >
              Cancel
            </Button>
            <Button disabled={assetMutationBusy || !assetEditorDraft.name.trim()} onClick={() => void submitAssetEditor()}>
              {assetMutationBusy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {assetEditorDraft.mode === "update" ? "Update" : "Save"}
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
