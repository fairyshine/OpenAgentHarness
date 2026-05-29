import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";

import type { PlatformAssetKind, PlatformAssetRecord } from "@oah/api-contracts";
import { FileUp, RefreshCw, Search, Trash2, Upload } from "lucide-react";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

import { blurActiveDialogElement, deferDialogOpen } from "./sidebar-primitives";
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
    if (asset.provider && asset.modelName) {
      return `${asset.provider}/${asset.modelName}${asset.url ? ` · ${asset.url}` : ""}`;
    }
    return "Model asset";
  }
  if (kind === "tool" && "transportType" in asset) {
    if (!asset.transportType) {
      return "Tool server asset";
    }
    return `${asset.transportType}${asset.enabled ? "" : " · disabled"}${asset.toolPrefix ? ` · ${asset.toolPrefix}` : ""}`;
  }
  if (kind === "skill" && "description" in asset && asset.description) {
    return asset.description;
  }
  return "Platform asset";
}

export interface SidebarAssetDialogsHandle {
  openAssetManager: (kind?: PlatformAssetKind) => void;
}

function AssetList(props: {
  kind: PlatformAssetKind;
  items: PlatformAssetRecord[];
  loading: boolean;
  pendingDelete: string;
  busy: boolean;
  onEdit: (asset: PlatformAssetRecord) => void;
  onAskDelete: (name: string) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (name: string) => void;
}) {
  if (props.loading && props.items.length === 0) {
    return (
      <div className="flex h-[min(48vh,390px)] flex-col items-center justify-center rounded-2xl border border-dashed border-black/12 px-4 py-8 text-center">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl border border-black/8 bg-white/70 shadow-sm">
          <RefreshCw className="h-5 w-5 animate-spin text-foreground" />
        </div>
        <p className="mt-3 text-sm font-medium text-foreground">Loading {ASSET_COLLECTION_LABELS[props.kind].toLowerCase()}</p>
      </div>
    );
  }

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
      {props.loading ? (
        <div className="flex items-center gap-2 border-b border-black/8 bg-white/64 px-3 py-2 text-xs font-medium text-muted-foreground">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          Loading {ASSET_COLLECTION_LABELS[props.kind].toLowerCase()}
        </div>
      ) : null}
      <div className="divide-y divide-black/8">
        {props.items.map((asset) => {
          const name = assetDisplayName(asset);
          const isDeleting = props.pendingDelete === name;
          return (
            <div key={`${props.kind}-${name}`} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{name}</p>
                <p className="mt-1 line-clamp-2 break-words text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
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


export const SidebarAssetDialogs = forwardRef<SidebarAssetDialogsHandle, { props: SidebarProps }>(function SidebarAssetDialogs({ props }, ref) {
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
  const [assetManagerLocalLoading, setAssetManagerLocalLoading] = useState<Record<PlatformAssetKind, boolean>>({
    runtime: false,
    model: false,
    tool: false,
    skill: false
  });
  const [assetMutationBusy, setAssetMutationBusy] = useState(false);
  const [assetPendingDelete, setAssetPendingDelete] = useState("");
  const [assetEditorDraft, setAssetEditorDraft] = useState<AssetEditorDraft>(() => createDefaultAssetDraft("model"));
  const [assetEditorError, setAssetEditorError] = useState("");
  const [assetEditorLoading, setAssetEditorLoading] = useState(false);
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
  const assetManagerLoading = {
    runtime: props.platformAssetLoading.runtime || assetManagerLocalLoading.runtime,
    model: props.platformAssetLoading.model || assetManagerLocalLoading.model,
    tool: props.platformAssetLoading.tool || assetManagerLocalLoading.tool,
    skill: props.platformAssetLoading.skill || assetManagerLocalLoading.skill
  };

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

  async function refreshAssetManagerKind(kind: PlatformAssetKind, quiet = true) {
    setAssetManagerLocalLoading((current) => ({
      ...current,
      [kind]: true
    }));
    try {
      await props.refreshPlatformAssets(kind, quiet);
    } finally {
      setAssetManagerLocalLoading((current) => ({
        ...current,
        [kind]: false
      }));
    }
  }

  function openAssetManagerDialog(kind: PlatformAssetKind = "runtime") {
    blurActiveDialogElement();
    props.setShowWorkspaceCreator(false);
    setShowRuntimeUploadDialog(false);
    setAssetManagerTab(kind);
    deferDialogOpen(() => {
      setShowAssetManagerDialog(true);
      void refreshAssetManagerKind(kind, true);
    });
  }

  useImperativeHandle(ref, () => ({ openAssetManager: openAssetManagerDialog }));

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
      setAssetEditorLoading(false);
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
        void refreshAssetManagerKind("runtime", true);
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
    setAssetEditorLoading(false);
    setShowAssetManagerDialog(false);
    deferDialogOpen(() => setShowAssetEditorDialog(true));
  }

  async function openUpdateAssetEditor(kind: PlatformAssetKind, asset: PlatformAssetRecord) {
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
      primaryText: "",
      secondaryText: "{}"
    });
    setAssetEditorLoading(true);
    setShowAssetManagerDialog(false);
    deferDialogOpen(() => setShowAssetEditorDialog(true));
    try {
      const detail = await props.getPlatformAssetDetail(kind, name);
      if (!detail) {
        setAssetEditorError("Failed to load asset details.");
        return;
      }
      setAssetEditorDraft((current) => {
        if (current.kind !== kind || current.name !== name || current.mode !== "update") {
          return current;
        }
        if (detail.kind === "model") {
          return { ...current, primaryText: detail.yaml, secondaryText: "{}" };
        }
        if (detail.kind === "tool") {
          return {
            ...current,
            primaryText: JSON.stringify(detail.definition, null, 2),
            secondaryText: JSON.stringify(detail.serverFiles ?? {}, null, 2)
          };
        }
        return {
          ...current,
          primaryText: detail.skillMarkdown,
          secondaryText: JSON.stringify(detail.files ?? {}, null, 2)
        };
      });
    } finally {
      setAssetEditorLoading(false);
    }
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
          void refreshAssetManagerKind(assetEditorDraft.kind, true);
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
                void refreshAssetManagerKind(next, true);
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
                    disabled={
                      assetMutationBusy ||
                      runtimeMutationBusy ||
                      (assetManagerTab === "runtime" && !props.workspaceManagementEnabled)
                    }
                  >
                    <Upload className="h-4 w-4" />
                    Add
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void refreshAssetManagerKind(assetManagerTab, false)}
                    disabled={assetMutationBusy || runtimeMutationBusy}
                  >
                    <RefreshCw className={`h-4 w-4 ${assetManagerLoading[assetManagerTab] ? "animate-spin" : ""}`} />
                    {assetManagerLoading[assetManagerTab] ? "Loading" : "Refresh"}
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
                    loading={assetManagerLoading[kind]}
                    pendingDelete={assetPendingDelete}
                    busy={assetMutationBusy || runtimeMutationBusy}
                    onEdit={(asset) => {
                      if (kind === "runtime") {
                        openRuntimeUpdatePicker(assetDisplayName(asset));
                        return;
                      }
                      void openUpdateAssetEditor(kind, asset);
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
            {assetEditorLoading ? (
              <div className="flex items-center gap-2 rounded-xl border border-black/8 bg-white/64 px-3 py-2 text-sm text-muted-foreground">
                <RefreshCw className="h-4 w-4 animate-spin" />
                Loading asset details
              </div>
            ) : null}
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
                disabled={assetEditorLoading}
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
                  disabled={assetEditorLoading}
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
            <Button disabled={assetMutationBusy || assetEditorLoading || !assetEditorDraft.name.trim()} onClick={() => void submitAssetEditor()}>
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
});
