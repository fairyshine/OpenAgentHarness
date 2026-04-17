import { useMemo, useRef, useState } from "react";

import {
  ArrowUp,
  Download,
  File,
  FileImage,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  PencilLine,
  RefreshCw,
  Trash2,
  Upload,
  X
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { formatTimestamp, pathLeaf, prettyJson } from "../support";
import type { useAppController } from "../use-app-controller";

type FileManagerProps = ReturnType<typeof useAppController>["runtimeDetailSurfaceProps"]["fileManager"];

function normalizeWorkspaceInput(basePath: string, rawValue: string): string {
  const value = rawValue.trim().replace(/\\/g, "/");
  if (!value) {
    return "";
  }

  const combined = value.startsWith("/") ? value : basePath === "." ? value : `${basePath}/${value}`;
  const segments: string[] = [];
  for (const segment of combined.split("/")) {
    const normalizedSegment = segment.trim();
    if (!normalizedSegment || normalizedSegment === ".") {
      continue;
    }

    if (normalizedSegment === "..") {
      segments.pop();
      continue;
    }

    segments.push(normalizedSegment);
  }

  return segments.join("/");
}

function formatSize(sizeBytes: number | undefined): string {
  if (sizeBytes === undefined) {
    return "unknown size";
  }

  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImagePreview(fileManager: FileManagerProps): boolean {
  return Boolean(
    fileManager.selectedEntry?.type === "file" &&
      fileManager.selectedFile?.encoding === "base64" &&
      fileManager.selectedFile.mimeType?.startsWith("image/")
  );
}

function isTextPreview(fileManager: FileManagerProps): boolean {
  return Boolean(
    fileManager.selectedEntry?.type === "file" &&
      fileManager.selectedFile?.encoding === "utf8"
  );
}

function DirectoryBreadcrumbs(props: Pick<FileManagerProps, "breadcrumbs" | "openDirectory">) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {props.breadcrumbs.map((segment, index) => (
        <div key={segment.path} className="flex items-center gap-1">
          {index > 0 ? <span className="text-muted-foreground/40">/</span> : null}
          <button
            className="rounded-full px-2 py-1 text-xs text-muted-foreground transition hover:bg-black/5 hover:text-foreground"
            onClick={() => props.openDirectory(segment.path)}
          >
            {segment.label}
          </button>
        </div>
      ))}
    </div>
  );
}

function EntryIcon(props: { type: "file" | "directory"; image?: boolean }) {
  if (props.type === "directory") {
    return <Folder className="h-4 w-4" />;
  }

  if (props.image) {
    return <FileImage className="h-4 w-4" />;
  }

  return <FileText className="h-4 w-4" />;
}

function FileManagerCommandBar(props: {
  fileManager: FileManagerProps;
  mode: "new-file" | "new-directory" | "move" | null;
  setMode: (value: "new-file" | "new-directory" | "move" | null) => void;
  inputValue: string;
  setInputValue: (value: string) => void;
  onSubmit: () => void;
  onUpload: () => void;
}) {
  const selectedEntry = props.fileManager.selectedEntry;
  const readOnly = props.fileManager.workspaceReadOnly;
  const atWorkspaceRoot = props.fileManager.currentPath.trim() === "" || props.fileManager.currentPath === ".";

  return (
    <div className="space-y-3 border-b border-black/8 px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={props.fileManager.navigateUp} disabled={atWorkspaceRoot || props.fileManager.entriesBusy}>
          <ArrowUp className="h-4 w-4" />
          Up
        </Button>
        <Button variant="outline" size="sm" onClick={props.fileManager.refreshEntries} disabled={props.fileManager.entriesBusy}>
          <RefreshCw className={cn("h-4 w-4", props.fileManager.entriesBusy ? "animate-spin" : "")} />
          Refresh
        </Button>
        <Button variant="outline" size="sm" onClick={props.onUpload} disabled={readOnly || props.fileManager.mutationBusy}>
          <Upload className="h-4 w-4" />
          Upload
        </Button>
        <Button variant="outline" size="sm" onClick={() => props.setMode(props.mode === "new-file" ? null : "new-file")} disabled={readOnly || props.fileManager.mutationBusy}>
          <FilePlus2 className="h-4 w-4" />
          New File
        </Button>
        <Button variant="outline" size="sm" onClick={() => props.setMode(props.mode === "new-directory" ? null : "new-directory")} disabled={readOnly || props.fileManager.mutationBusy}>
          <FolderPlus className="h-4 w-4" />
          New Folder
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => props.setMode(props.mode === "move" ? null : "move")}
          disabled={readOnly || props.fileManager.mutationBusy || !selectedEntry}
        >
          <PencilLine className="h-4 w-4" />
          Rename / Move
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => selectedEntry && props.fileManager.downloadEntry(selectedEntry)}
          disabled={!selectedEntry || selectedEntry.type !== "file" || props.fileManager.mutationBusy}
        >
          <Download className="h-4 w-4" />
          Download
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => {
            if (!selectedEntry) {
              return;
            }

            const confirmed = window.confirm(
              selectedEntry.type === "directory"
                ? `Delete directory ${selectedEntry.path} recursively?`
                : `Delete file ${selectedEntry.path}?`
            );
            if (confirmed) {
              props.fileManager.deleteEntry(selectedEntry);
            }
          }}
          disabled={readOnly || !selectedEntry || props.fileManager.mutationBusy}
        >
          <Trash2 className="h-4 w-4" />
          Delete
        </Button>
      </div>

      {props.mode ? (
        <div className="flex flex-col gap-2 rounded-2xl border border-black/8 bg-black/[0.025] p-3 md:flex-row md:items-center">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {props.mode === "new-file" ? "Create File" : props.mode === "new-directory" ? "Create Folder" : "Move Entry"}
            </p>
            <Input
              value={props.inputValue}
              onChange={(event) => props.setInputValue(event.target.value)}
              placeholder={props.mode === "move" ? "Target path" : "Path"}
              className="mt-2 h-9 rounded-xl border-black/10 bg-white/70 text-sm shadow-none"
            />
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={props.onSubmit} disabled={!props.inputValue.trim() || props.fileManager.mutationBusy}>
              {props.fileManager.mutationBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Apply
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                props.setMode(null);
                props.setInputValue("");
              }}
            >
              <X className="h-4 w-4" />
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function WorkspaceFileManagerPanel(props: { fileManager: FileManagerProps }) {
  const { fileManager } = props;
  const [commandMode, setCommandMode] = useState<"new-file" | "new-directory" | "move" | null>(null);
  const [commandValue, setCommandValue] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imagePreviewUrl = useMemo(() => {
    if (!isImagePreview(fileManager) || !fileManager.selectedFile?.mimeType) {
      return null;
    }

    return `data:${fileManager.selectedFile.mimeType};base64,${fileManager.selectedFile.content}`;
  }, [fileManager]);

  if (!fileManager.canManageFiles) {
    return null;
  }

  const selectedEntry = fileManager.selectedEntry;
  const selectedFile = fileManager.selectedFile;
  const busy = fileManager.entriesBusy || fileManager.fileBusy || fileManager.mutationBusy;
  const displayPath = fileManager.currentPath.trim() === "" || fileManager.currentPath === "." ? "workspace root" : fileManager.currentPath;

  function openCommand(mode: "new-file" | "new-directory" | "move") {
    setCommandMode(mode);
    if (mode === "move" && selectedEntry) {
      setCommandValue(selectedEntry.path);
      return;
    }

    setCommandValue("");
  }

  function submitCommand() {
    const nextValue = commandValue.trim();
    if (!nextValue) {
      return;
    }

    if (commandMode === "new-file") {
      fileManager.createFile(normalizeWorkspaceInput(fileManager.currentPath, nextValue));
    } else if (commandMode === "new-directory") {
      fileManager.createDirectory(normalizeWorkspaceInput(fileManager.currentPath, nextValue));
    } else if (commandMode === "move" && selectedEntry) {
      fileManager.moveEntry(
        selectedEntry.path,
        normalizeWorkspaceInput(
          selectedEntry.path.includes("/") ? selectedEntry.path.slice(0, selectedEntry.path.lastIndexOf("/")) || "." : ".",
          nextValue
        )
      );
    }
    setCommandMode(null);
    setCommandValue("");
  }

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        multiple
        onChange={(event) => {
          if (event.target.files && event.target.files.length > 0) {
            fileManager.uploadFiles(event.target.files);
            event.target.value = "";
          }
        }}
      />

      {!fileManager.open ? (
        <div className="pointer-events-none absolute bottom-24 right-4 z-30 md:bottom-28 md:right-6">
          <Button
            className="pointer-events-auto h-12 rounded-2xl px-4 shadow-[0_22px_48px_-28px_rgba(15,23,42,0.55)]"
            onClick={() => fileManager.setOpen(true)}
          >
            <PanelRightOpen className="h-4 w-4" />
            Files
          </Button>
        </div>
      ) : (
        <div className="absolute inset-x-3 bottom-24 z-30 top-4 md:inset-x-auto md:bottom-28 md:right-6 md:top-6 md:w-[min(940px,calc(100%-3rem))]">
          <div className="flex h-full flex-col overflow-hidden rounded-[28px] border border-black/10 bg-background/92 shadow-[0_32px_90px_-42px_rgba(15,23,42,0.55)] backdrop-blur-xl">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-black/8 px-4 py-4">
              <div className="min-w-0 space-y-2">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-black/10 bg-black/[0.03] text-foreground">
                    <Folder className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold tracking-tight text-foreground">Workspace Files</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {fileManager.workspaceName || fileManager.workspaceId}
                    </p>
                  </div>
                  {fileManager.workspaceReadOnly ? <Badge variant="outline">read only</Badge> : null}
                </div>
                <DirectoryBreadcrumbs breadcrumbs={fileManager.breadcrumbs} openDirectory={fileManager.openDirectory} />
              </div>

              <div className="flex items-center gap-2">
                <Badge variant="outline">{fileManager.entries.length} items</Badge>
                {selectedEntry ? <Badge variant="secondary">{pathLeaf(selectedEntry.path)}</Badge> : null}
                <Button variant="ghost" size="icon" className="h-9 w-9 rounded-xl" onClick={() => fileManager.setOpen(false)}>
                  <PanelRightClose className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <FileManagerCommandBar
              fileManager={fileManager}
              mode={commandMode}
              setMode={(value) => {
                if (value === null) {
                  setCommandMode(null);
                  setCommandValue("");
                  return;
                }

                openCommand(value);
              }}
              inputValue={commandValue}
              setInputValue={setCommandValue}
              onSubmit={submitCommand}
              onUpload={() => fileInputRef.current?.click()}
            />

            <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,320px)_minmax(0,1fr)] md:grid-cols-[320px_minmax(0,1fr)] md:grid-rows-1">
              <div className="flex min-h-0 flex-col border-b border-black/8 md:border-b-0 md:border-r">
                <div className="flex items-center justify-between px-4 py-3">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Directory</p>
                    <p className="mt-1 text-xs text-muted-foreground">{displayPath}</p>
                  </div>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
                  <div className="space-y-1.5">
                    {fileManager.entries.map((entry) => {
                      const active = selectedEntry?.path === entry.path;
                      const image = entry.type === "file" && (entry.mimeType?.startsWith("image/") ?? false);
                      return (
                        <button
                          key={entry.path}
                          className={cn(
                            "flex w-full items-start gap-3 rounded-2xl px-3 py-2.5 text-left transition",
                            active ? "border border-black/10 bg-black/[0.045] shadow-sm" : "border border-transparent hover:border-black/8 hover:bg-black/[0.025]"
                          )}
                          onClick={() => fileManager.focusEntry(entry)}
                          onDoubleClick={() => {
                            if (entry.type === "directory") {
                              fileManager.openDirectory(entry.path);
                            }
                          }}
                        >
                          <div className={cn(
                            "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border",
                            active ? "border-black/10 bg-white text-foreground" : "border-black/8 bg-black/[0.03] text-muted-foreground"
                          )}>
                            <EntryIcon type={entry.type} image={image} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <p className="truncate text-sm font-medium text-foreground">{entry.name}</p>
                              {entry.type === "directory" ? <Badge variant="outline">dir</Badge> : null}
                            </div>
                            <p className="mt-1 truncate text-xs text-muted-foreground">
                              {entry.type === "directory"
                                ? entry.updatedAt ? `updated ${formatTimestamp(entry.updatedAt)}` : "directory"
                                : `${formatSize(entry.sizeBytes)}${entry.updatedAt ? ` · ${formatTimestamp(entry.updatedAt)}` : ""}`}
                            </p>
                          </div>
                        </button>
                      );
                    })}

                    {fileManager.entries.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-black/10 px-4 py-8 text-center">
                        <p className="text-sm font-medium text-foreground">This directory is empty</p>
                        <p className="mt-1 text-xs text-muted-foreground">Upload files or create a folder to get started.</p>
                      </div>
                    ) : null}

                    {fileManager.nextCursor ? (
                      <Button variant="outline" className="mt-2 w-full rounded-2xl" onClick={fileManager.loadMoreEntries} disabled={fileManager.entriesBusy}>
                        Load More
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="flex min-h-0 flex-col">
                <div className="flex items-center justify-between gap-3 border-b border-black/8 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Preview</p>
                    <p className="mt-1 truncate text-sm font-medium text-foreground">
                      {selectedEntry ? selectedEntry.path : "Select an entry"}
                    </p>
                  </div>
                  {selectedEntry?.type === "file" ? (
                    <div className="flex items-center gap-2">
                      {selectedFile?.truncated ? <Badge variant="outline">preview only</Badge> : null}
                      {fileManager.selectedFileDirty ? <Badge variant="secondary">unsaved</Badge> : null}
                      <Button
                        size="sm"
                        onClick={fileManager.saveSelectedFile}
                        disabled={!fileManager.selectedFileDirty || !fileManager.selectedFileEditable || fileManager.mutationBusy}
                      >
                        Save
                      </Button>
                    </div>
                  ) : null}
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                  {!selectedEntry ? (
                    <div className="flex h-full min-h-[240px] items-center justify-center">
                      <div className="max-w-sm text-center">
                        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-black/10 bg-black/[0.03] text-muted-foreground">
                          <File className="h-5 w-5" />
                        </div>
                        <p className="mt-4 text-sm font-medium text-foreground">Browse a directory or open a file</p>
                        <p className="mt-1 text-sm text-muted-foreground">The panel supports upload, download, text editing, renaming, and recursive delete.</p>
                      </div>
                    </div>
                  ) : selectedEntry.type === "directory" ? (
                    <div className="space-y-4">
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="rounded-2xl border border-black/8 bg-black/[0.02] px-4 py-3">
                          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Directory</p>
                          <p className="mt-2 text-sm font-medium text-foreground">{selectedEntry.name}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{selectedEntry.path}</p>
                        </div>
                        <div className="rounded-2xl border border-black/8 bg-black/[0.02] px-4 py-3">
                          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Last Updated</p>
                          <p className="mt-2 text-sm font-medium text-foreground">{selectedEntry.updatedAt ? formatTimestamp(selectedEntry.updatedAt) : "unknown"}</p>
                          <p className="mt-1 text-xs text-muted-foreground">Double-click it in the list to step into this directory.</p>
                        </div>
                      </div>
                      <Button variant="outline" onClick={() => fileManager.openDirectory(selectedEntry.path)}>
                        <Folder className="h-4 w-4" />
                        Open Directory
                      </Button>
                    </div>
                  ) : fileManager.fileBusy ? (
                    <div className="flex h-full min-h-[240px] items-center justify-center">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="grid gap-3 md:grid-cols-3">
                        <div className="rounded-2xl border border-black/8 bg-black/[0.02] px-4 py-3">
                          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Size</p>
                          <p className="mt-2 text-sm font-medium text-foreground">{formatSize(selectedFile?.sizeBytes ?? selectedEntry.sizeBytes)}</p>
                        </div>
                        <div className="rounded-2xl border border-black/8 bg-black/[0.02] px-4 py-3">
                          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Encoding</p>
                          <p className="mt-2 text-sm font-medium text-foreground">{selectedFile?.encoding ?? "unknown"}</p>
                        </div>
                        <div className="rounded-2xl border border-black/8 bg-black/[0.02] px-4 py-3">
                          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">MIME</p>
                          <p className="mt-2 truncate text-sm font-medium text-foreground">{selectedFile?.mimeType ?? selectedEntry.mimeType ?? "unknown"}</p>
                        </div>
                      </div>

                      {isImagePreview(fileManager) && imagePreviewUrl ? (
                        <div className="overflow-hidden rounded-[24px] border border-black/10 bg-black/[0.03] p-3">
                          <img src={imagePreviewUrl} alt={selectedEntry.name} className="max-h-[420px] w-full rounded-[18px] object-contain" />
                        </div>
                      ) : isTextPreview(fileManager) ? (
                        <div className="space-y-2">
                          {selectedFile?.truncated ? (
                            <p className="text-xs text-muted-foreground">Large file preview loaded. Download the file to inspect the full content safely.</p>
                          ) : null}
                          <Textarea
                            value={fileManager.selectedFileDraft}
                            onChange={(event) => fileManager.setSelectedFileDraft(event.target.value)}
                            disabled={!fileManager.selectedFileEditable}
                            className="min-h-[340px] resize-y rounded-[24px] border-black/10 bg-black/[0.02] font-mono text-xs leading-6 shadow-none"
                          />
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <div className="rounded-[24px] border border-black/10 bg-black/[0.02] p-4">
                            <p className="text-sm font-medium text-foreground">Binary or non-editable preview</p>
                            <p className="mt-1 text-sm text-muted-foreground">This file is being shown as metadata / preview only. Use download for the raw bytes.</p>
                          </div>
                          <pre className="max-h-[340px] overflow-auto rounded-[24px] border border-black/10 bg-black/[0.02] p-4 text-xs leading-6 text-foreground/75">
                            {prettyJson(selectedFile)}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
