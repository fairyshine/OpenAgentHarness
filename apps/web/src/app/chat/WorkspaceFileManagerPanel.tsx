import { memo, useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent, type ReactNode } from "react";

import {
  ArrowUp,
  Braces,
  Check,
  Code2,
  Database,
  Download,
  Eye,
  FileArchive,
  FileAudio,
  FileCode2,
  FileCog,
  FileImage,
  FileJson,
  FilePlus2,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  FileVideo,
  Folder,
  FolderPlus,
  Loader2,
  Maximize2,
  Move,
  Package,
  PanelRightClose,
  PanelRightOpen,
  PencilLine,
  RefreshCw,
  Settings,
  Trash2,
  Upload,
  X
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { formatRelativeTimestamp, formatTimestamp, formatTimestampPrecise, pathLeaf, prettyJson } from "../support";
import {
  useWorkspaceFileManager,
  type WorkspaceFileManagerParams,
  type WorkspaceFileManagerSurfaceProps,
  type WorkspaceUploadItem
} from "../use-workspace-file-manager";
import { MarkdownText } from "./conversation-markdown";

type FileManagerProps = WorkspaceFileManagerSurfaceProps;

type PreviewWindowInteraction =
  | {
      type: "move";
      pointerId: number;
      startClientX: number;
      startClientY: number;
      startX: number;
      startY: number;
    }
  | {
      type: "resize";
      pointerId: number;
      startClientX: number;
      startClientY: number;
      startWidth: number;
      startHeight: number;
    };

interface PreviewWindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DroppedFileSystemEntry {
  name: string;
  fullPath?: string;
  isFile: boolean;
  isDirectory: boolean;
}

interface DroppedFileSystemFileEntry extends DroppedFileSystemEntry {
  isFile: true;
  file: (successCallback: (file: File) => void, errorCallback?: (error: DOMException) => void) => void;
}

interface DroppedFileSystemDirectoryEntry extends DroppedFileSystemEntry {
  isDirectory: true;
  createReader: () => {
    readEntries: (
      successCallback: (entries: DroppedFileSystemEntry[]) => void,
      errorCallback?: (error: DOMException) => void
    ) => void;
  };
}

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

function pathExtension(value: string): string {
  const leaf = pathLeaf(value);
  const dotIndex = leaf.lastIndexOf(".");
  return dotIndex >= 0 ? leaf.slice(dotIndex + 1).toLowerCase() : "";
}

type PreviewWindowState = FileManagerProps["previewWindows"][number];

function isEditablePreview(input: {
  workspaceReadOnly: boolean;
  preview: PreviewWindowState;
}): boolean {
  return Boolean(
    !input.workspaceReadOnly &&
      input.preview.entry.type === "file" &&
      input.preview.file?.encoding === "utf8" &&
      !input.preview.file.truncated &&
      !input.preview.file.readOnly
  );
}

function isPreviewDirty(input: {
  workspaceReadOnly: boolean;
  preview: PreviewWindowState;
}): boolean {
  return Boolean(isEditablePreview(input) && input.preview.file && input.preview.draft !== input.preview.file.content);
}

function getPreviewFileText(preview: PreviewWindowState): string {
  if (!preview.file || preview.file.encoding !== "utf8") {
    return "";
  }

  return !preview.file.truncated ? preview.draft : preview.file.content;
}

function getImagePreviewUrl(preview: PreviewWindowState): string | null {
  if (preview.entry.type !== "file" || preview.file?.encoding !== "base64" || !preview.file.mimeType?.startsWith("image/")) {
    return null;
  }

  return `data:${preview.file.mimeType};base64,${preview.file.content}`;
}

function isPreviewText(preview: PreviewWindowState): boolean {
  return preview.entry.type === "file" && preview.file?.encoding === "utf8";
}

function isPreviewMarkdown(preview: PreviewWindowState): boolean {
  if (!isPreviewText(preview)) {
    return false;
  }

  const mimeType = preview.file?.mimeType?.toLowerCase() ?? preview.entry.mimeType?.toLowerCase() ?? "";
  return mimeType.includes("markdown") || ["md", "mdx"].includes(pathExtension(preview.entry.path));
}

function isPreviewHtml(preview: PreviewWindowState): boolean {
  if (!isPreviewText(preview)) {
    return false;
  }

  const mimeType = preview.file?.mimeType?.toLowerCase() ?? preview.entry.mimeType?.toLowerCase() ?? "";
  return mimeType.includes("text/html") || mimeType.includes("application/xhtml") || ["html", "htm", "xhtml"].includes(pathExtension(preview.entry.path));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getDefaultPreviewFrame(): PreviewWindowFrame {
  if (typeof window === "undefined") {
    return {
      x: 24,
      y: 56,
      width: 960,
      height: 640
    };
  }

  const margin = 24;
  const reservedRight = window.innerWidth >= 768 ? 408 : margin;
  const reservedBottom = window.innerWidth >= 768 ? 112 : 96;
  const maxWidth = Math.max(320, window.innerWidth - reservedRight - margin);
  const maxHeight = Math.max(280, window.innerHeight - 112 - reservedBottom);
  const width = clampNumber(maxWidth, 360, 1040);
  const height = clampNumber(maxHeight, 320, 760);

  return {
    x: margin,
    y: window.innerWidth >= 768 ? 56 : 56,
    width,
    height
  };
}

function constrainPreviewFrame(frame: PreviewWindowFrame): PreviewWindowFrame {
  if (typeof window === "undefined") {
    return frame;
  }

  const margin = 12;
  const minWidth = Math.min(360, window.innerWidth - margin * 2);
  const minHeight = Math.min(260, window.innerHeight - margin * 2);
  const maxWidth = Math.max(minWidth, window.innerWidth - margin * 2);
  const maxHeight = Math.max(minHeight, window.innerHeight - margin * 2);
  const width = clampNumber(frame.width, minWidth, maxWidth);
  const height = clampNumber(frame.height, minHeight, maxHeight);

  return {
    width,
    height,
    x: clampNumber(frame.x, margin, Math.max(margin, window.innerWidth - width - margin)),
    y: clampNumber(frame.y, margin, Math.max(margin, window.innerHeight - height - margin))
  };
}

function DirectoryBreadcrumbs(props: Pick<FileManagerProps, "breadcrumbs" | "openDirectory">) {
  return (
    <div className="flex min-w-0 items-center gap-1 overflow-x-auto whitespace-nowrap">
      {props.breadcrumbs.map((segment, index) => (
        <div key={segment.path} className="flex shrink-0 items-center gap-1">
          {index > 0 ? <span className="shrink-0 text-muted-foreground/40">/</span> : null}
          <button
            className="max-w-28 truncate rounded-full px-2 py-1 text-xs text-muted-foreground transition hover:bg-black/5 hover:text-foreground"
            onClick={() => props.openDirectory(segment.path)}
            title={segment.path}
          >
            {segment.label}
          </button>
        </div>
      ))}
    </div>
  );
}

function RenderedMarkdownPreview(props: { text: string }) {
  return (
    <div className="h-full min-h-[280px] overflow-auto rounded-2xl border border-black/10 bg-white/60 p-4 text-foreground shadow-inner">
      <MarkdownText text={props.text} />
    </div>
  );
}

function RenderedHtmlPreview(props: { html: string; title: string }) {
  return (
    <iframe
      title={`Rendered preview of ${props.title}`}
      sandbox="allow-scripts allow-forms allow-modals"
      srcDoc={props.html}
      className="h-full min-h-[320px] w-full rounded-2xl border border-black/10 bg-white shadow-inner"
    />
  );
}

function TextSourcePreview(props: {
  selectedFile: NonNullable<PreviewWindowState["file"]>;
  draft: string;
  editable: boolean;
  onDraftChange: (value: string) => void;
}) {
  if (props.selectedFile.truncated) {
    return (
      <>
        <p className="text-xs text-muted-foreground">Large file preview loaded. Download the file to inspect the full content safely.</p>
        <pre className="h-full min-h-[280px] overflow-auto rounded-2xl border border-black/10 bg-black/[0.02] p-4 text-xs leading-6 text-foreground/80">
          {props.selectedFile.content}
        </pre>
      </>
    );
  }

  return (
    <Textarea
      value={props.draft}
      onChange={(event) => props.onDraftChange(event.target.value)}
      disabled={!props.editable}
      className="h-full min-h-[280px] resize-none rounded-2xl border-black/10 bg-black/[0.02] font-mono text-xs leading-6 shadow-none"
    />
  );
}

function TextPreview(props: {
  preview: PreviewWindowState;
  editable: boolean;
  onDraftChange: (value: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<"rendered" | "source">("rendered");

  if (!props.preview.file) {
    return null;
  }

  const canRenderMarkdown = isPreviewMarkdown(props.preview);
  const canRenderHtml = isPreviewHtml(props.preview);
  const previewText = getPreviewFileText(props.preview);

  if (!canRenderMarkdown && !canRenderHtml) {
    return (
      <div className="h-full min-h-0">
        <TextSourcePreview
          selectedFile={props.preview.file}
          draft={props.preview.draft}
          editable={props.editable}
          onDraftChange={props.onDraftChange}
        />
      </div>
    );
  }

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => setActiveTab(value === "source" ? "source" : "rendered")}
      className="relative h-full min-h-0"
    >
      <div className="pointer-events-none absolute right-2 top-2 z-10 flex items-center gap-2">
        <TabsList className="pointer-events-auto h-7 rounded-xl border-black/10 bg-background/86 p-0.5 shadow-sm backdrop-blur">
          <TabsTrigger value="rendered" className="h-6 px-2 text-xs">
            <Eye className="h-3.5 w-3.5" />
            Rendered
          </TabsTrigger>
          <TabsTrigger value="source" className="h-6 px-2 text-xs">
            <Code2 className="h-3.5 w-3.5" />
            Source
          </TabsTrigger>
        </TabsList>
        {canRenderHtml ? (
          <Badge variant="outline" className="pointer-events-auto h-6 shrink-0 bg-background/86 px-2 text-[10px] shadow-sm backdrop-blur">scripts on</Badge>
        ) : null}
      </div>
      {activeTab === "rendered" ? (
        <TabsContent value="rendered" className="m-0 h-full min-h-0">
          {canRenderMarkdown ? (
            <RenderedMarkdownPreview text={previewText} />
          ) : (
            <RenderedHtmlPreview html={previewText} title={props.preview.entry.name} />
          )}
        </TabsContent>
      ) : (
        <TabsContent value="source" className="m-0 h-full min-h-0">
          <div className="h-full min-h-0">
            <TextSourcePreview
              selectedFile={props.preview.file}
              draft={props.preview.draft}
              editable={props.editable}
              onDraftChange={props.onDraftChange}
            />
          </div>
        </TabsContent>
      )}
    </Tabs>
  );
}

function EntryIcon(props: { entry: Pick<NonNullable<FileManagerProps["selectedEntry"]>, "type" | "path" | "mimeType"> }) {
  const iconClassName = "h-3.5 w-3.5";
  const extension = pathExtension(props.entry.path);
  const mimeType = props.entry.mimeType?.toLowerCase() ?? "";

  if (props.entry.type === "directory") {
    return <Folder className={iconClassName} />;
  }

  if (mimeType.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(extension)) {
    return <FileImage className={iconClassName} />;
  }

  if (mimeType.startsWith("video/") || ["mp4", "mov", "webm", "mkv", "avi"].includes(extension)) {
    return <FileVideo className={iconClassName} />;
  }

  if (mimeType.startsWith("audio/") || ["mp3", "wav", "flac", "ogg", "m4a"].includes(extension)) {
    return <FileAudio className={iconClassName} />;
  }

  if (["zip", "tar", "gz", "tgz", "rar", "7z", "bz2", "xz"].includes(extension)) {
    return <FileArchive className={iconClassName} />;
  }

  if (["csv", "tsv", "xls", "xlsx"].includes(extension)) {
    return <FileSpreadsheet className={iconClassName} />;
  }

  if (["json", "jsonl", "map"].includes(extension) || mimeType.includes("json")) {
    return <FileJson className={iconClassName} />;
  }

  if (["yml", "yaml", "toml", "ini", "conf", "config"].includes(extension)) {
    return <FileCog className={iconClassName} />;
  }

  if (["env", "settings"].includes(extension) || props.entry.path.endsWith(".env")) {
    return <Settings className={iconClassName} />;
  }

  if (["sh", "bash", "zsh", "fish", "ps1", "bat", "cmd"].includes(extension)) {
    return <FileTerminal className={iconClassName} />;
  }

  if (["sql", "sqlite", "db"].includes(extension)) {
    return <Database className={iconClassName} />;
  }

  if (["html", "htm", "xml", "svg"].includes(extension)) {
    return <FileCode2 className={iconClassName} />;
  }

  if (["js", "jsx", "ts", "tsx", "mjs", "cjs", "css", "scss", "less", "py", "rb", "go", "rs", "java", "kt", "swift", "php", "c", "cpp", "h", "hpp"].includes(extension)) {
    return <Braces className={iconClassName} />;
  }

  if (["lock", "log"].includes(extension)) {
    return <FileType className={iconClassName} />;
  }

  if (["wasm", "bin", "dylib", "so", "dll", "exe"].includes(extension)) {
    return <Package className={iconClassName} />;
  }

  return <FileText className={iconClassName} />;
}

function getEntryIconTone(entry: Pick<NonNullable<FileManagerProps["selectedEntry"]>, "type" | "path" | "mimeType">) {
  const extension = pathExtension(entry.path);
  const mimeType = entry.mimeType?.toLowerCase() ?? "";

  if (entry.type === "directory") {
    return "border-amber-500/18 bg-amber-500/8 text-amber-700";
  }

  if (mimeType.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(extension)) {
    return "border-sky-500/18 bg-sky-500/8 text-sky-700";
  }

  if (mimeType.startsWith("video/") || mimeType.startsWith("audio/")) {
    return "border-fuchsia-500/18 bg-fuchsia-500/8 text-fuchsia-700";
  }

  if (["json", "jsonl", "map", "yml", "yaml", "toml", "ini", "conf", "config"].includes(extension) || mimeType.includes("json")) {
    return "border-emerald-500/18 bg-emerald-500/8 text-emerald-700";
  }

  if (["js", "jsx", "ts", "tsx", "mjs", "cjs", "html", "htm", "css", "scss", "less", "py", "rb", "go", "rs", "java", "kt", "swift", "php", "c", "cpp", "h", "hpp", "sh", "bash", "zsh"].includes(extension)) {
    return "border-violet-500/18 bg-violet-500/8 text-violet-700";
  }

  if (["zip", "tar", "gz", "tgz", "rar", "7z", "bz2", "xz"].includes(extension)) {
    return "border-orange-500/18 bg-orange-500/8 text-orange-700";
  }

  return "border-black/8 bg-black/[0.03] text-muted-foreground";
}

function renderEntryUpdatedAt(value?: string): { inline: string; detail: string } {
  if (!value) {
    return {
      inline: "time unknown",
      detail: "time unknown"
    };
  }

  const precise = formatTimestampPrecise(value);
  const relative = formatRelativeTimestamp(value);
  return {
    inline: relative ?? formatTimestamp(value),
    detail: relative ? `${precise} · ${relative}` : precise
  };
}

function isFileSystemFileEntry(entry: DroppedFileSystemEntry): entry is DroppedFileSystemFileEntry {
  return entry.isFile;
}

function isFileSystemDirectoryEntry(entry: DroppedFileSystemEntry): entry is DroppedFileSystemDirectoryEntry {
  return entry.isDirectory;
}

function isDroppedFileSystemEntry(value: unknown): value is DroppedFileSystemEntry {
  return Boolean(
    value &&
      typeof value === "object" &&
      "name" in value &&
      "isFile" in value &&
      "isDirectory" in value
  );
}

function getDroppedFileSystemEntry(item: DataTransferItem): DroppedFileSystemEntry | null {
  const getEntry = (item as { webkitGetAsEntry?: () => unknown }).webkitGetAsEntry;
  if (!getEntry) {
    return null;
  }

  const entry = getEntry.call(item);
  return isDroppedFileSystemEntry(entry) ? entry : null;
}

function readFileSystemFile(entry: DroppedFileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readFileSystemDirectoryEntries(entry: DroppedFileSystemDirectoryEntry): Promise<DroppedFileSystemEntry[]> {
  const reader = entry.createReader();
  const entries: DroppedFileSystemEntry[] = [];

  return new Promise((resolve, reject) => {
    function readNextBatch() {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(entries);
          return;
        }

        entries.push(...batch);
        readNextBatch();
      }, reject);
    }

    readNextBatch();
  });
}

async function collectDroppedEntryFiles(entry: DroppedFileSystemEntry, parentPath = ""): Promise<WorkspaceUploadItem[]> {
  const relativePath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  if (isFileSystemFileEntry(entry)) {
    return [{ type: "file", file: await readFileSystemFile(entry), relativePath }];
  }

  if (!isFileSystemDirectoryEntry(entry)) {
    return [];
  }

  const children = await readFileSystemDirectoryEntries(entry);
  const nestedItems = await Promise.all(children.map((child) => collectDroppedEntryFiles(child, relativePath)));
  return [{ type: "directory", relativePath }, ...nestedItems.flat()];
}

async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<WorkspaceUploadItem[]> {
  const entries = Array.from(dataTransfer.items)
    .filter((item) => item.kind === "file")
    .map((item) => getDroppedFileSystemEntry(item))
    .filter((entry): entry is DroppedFileSystemEntry => entry !== null && entry !== undefined);

  if (entries.length > 0) {
    const nestedItems = await Promise.all(entries.map((entry) => collectDroppedEntryFiles(entry)));
    return nestedItems.flat();
  }

  return Array.from(dataTransfer.files).map((file) => ({
    type: "file",
    file,
    relativePath: file.webkitRelativePath || file.name
  }));
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
  const commandLabel =
    props.mode === "new-file"
      ? "Create file"
      : props.mode === "new-directory"
        ? "Create folder"
        : "Move entry";

  function commandIconButton(input: {
    label: string;
    icon: ReactNode;
    onClick: () => void;
    disabled?: boolean;
    active?: boolean;
    destructive?: boolean;
  }) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={input.active ? "secondary" : "ghost"}
            size="icon"
            title={input.label}
            aria-label={input.label}
            onClick={input.onClick}
            disabled={input.disabled}
            className={cn(
              "h-8 w-8 rounded-xl border border-transparent text-muted-foreground hover:border-black/8 hover:bg-white/70 hover:text-foreground",
              input.active ? "border-black/10 bg-white/80 text-foreground shadow-sm" : "",
              input.destructive ? "hover:text-destructive" : ""
            )}
          >
            {input.icon}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{input.label}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <TooltipProvider>
      <div className="space-y-2 border-b border-black/8 px-4 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center rounded-2xl border border-black/8 bg-black/[0.025] p-0.5">
            {commandIconButton({
              label: "Up",
              icon: <ArrowUp className="h-4 w-4" />,
              onClick: props.fileManager.navigateUp,
              disabled: atWorkspaceRoot || props.fileManager.entriesBusy
            })}
            {commandIconButton({
              label: "Refresh",
              icon: <RefreshCw className={cn("h-4 w-4", props.fileManager.entriesBusy ? "animate-spin" : "")} />,
              onClick: props.fileManager.refreshEntries,
              disabled: props.fileManager.entriesBusy
            })}
          </div>

          <div className="flex items-center rounded-2xl border border-black/8 bg-black/[0.025] p-0.5">
            {commandIconButton({
              label: "Upload",
              icon: <Upload className="h-4 w-4" />,
              onClick: props.onUpload,
              disabled: readOnly || props.fileManager.mutationBusy
            })}
            {commandIconButton({
              label: "New file",
              icon: <FilePlus2 className="h-4 w-4" />,
              onClick: () => props.setMode(props.mode === "new-file" ? null : "new-file"),
              disabled: readOnly || props.fileManager.mutationBusy,
              active: props.mode === "new-file"
            })}
            {commandIconButton({
              label: "New folder",
              icon: <FolderPlus className="h-4 w-4" />,
              onClick: () => props.setMode(props.mode === "new-directory" ? null : "new-directory"),
              disabled: readOnly || props.fileManager.mutationBusy,
              active: props.mode === "new-directory"
            })}
          </div>

          <div className="flex items-center rounded-2xl border border-black/8 bg-black/[0.025] p-0.5">
            {commandIconButton({
              label: "Rename or move",
              icon: <PencilLine className="h-4 w-4" />,
              onClick: () => props.setMode(props.mode === "move" ? null : "move"),
              disabled: readOnly || props.fileManager.mutationBusy || !selectedEntry,
              active: props.mode === "move"
            })}
            {commandIconButton({
              label: "Download",
              icon: <Download className="h-4 w-4" />,
              onClick: () => selectedEntry && props.fileManager.downloadEntry(selectedEntry),
              disabled: !selectedEntry || selectedEntry.type !== "file" || props.fileManager.mutationBusy
            })}
            {commandIconButton({
              label: "Delete",
              icon: <Trash2 className="h-4 w-4" />,
              destructive: true,
              onClick: () => {
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
              },
              disabled: readOnly || !selectedEntry || props.fileManager.mutationBusy
            })}
          </div>
        </div>

        {props.mode ? (
          <div className="rounded-2xl border border-black/8 bg-white/45 p-1.5 shadow-inner">
            <div className="flex items-center gap-2">
              <div className="flex h-7 min-w-7 shrink-0 items-center justify-center rounded-xl bg-black/[0.045] text-muted-foreground">
                {props.mode === "new-file" ? (
                  <FilePlus2 className="h-4 w-4" />
                ) : props.mode === "new-directory" ? (
                  <FolderPlus className="h-4 w-4" />
                ) : (
                  <PencilLine className="h-4 w-4" />
                )}
              </div>
              <Input
                value={props.inputValue}
                onChange={(event) => props.setInputValue(event.target.value)}
                placeholder={props.mode === "move" ? "Target path" : commandLabel}
                aria-label={commandLabel}
                className="h-8 min-w-0 flex-1 rounded-xl border-black/10 bg-white/80 text-sm shadow-none"
              />
              <Button size="icon" className="h-8 w-8 rounded-xl" onClick={props.onSubmit} disabled={!props.inputValue.trim() || props.fileManager.mutationBusy} title="Apply" aria-label="Apply">
                {props.fileManager.mutationBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-xl"
                title="Cancel"
                aria-label="Cancel"
                onClick={() => {
                  props.setMode(null);
                  props.setInputValue("");
                }}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </TooltipProvider>
  );
}

interface PreviewWindowActions {
  closePreviewWindow: (id: string) => void;
  focusPreviewWindow: (id: string) => void;
  savePreviewWindow: (id: string) => void;
  setPreviewWindowDraft: (id: string, value: string) => void;
}

const WorkspaceFilePreviewWindow = memo(function WorkspaceFilePreviewWindow(props: {
  preview: PreviewWindowState;
  index: number;
  previewCount: number;
  workspaceReadOnly: boolean;
  mutationBusy: boolean;
  actions: PreviewWindowActions;
}) {
  const { preview } = props;
  const selectedEntry = preview.entry;
  const selectedFile = preview.file;
  const imagePreviewUrl = getImagePreviewUrl(preview);
  const previewEditable = isEditablePreview({ workspaceReadOnly: props.workspaceReadOnly, preview });
  const previewDirty = isPreviewDirty({ workspaceReadOnly: props.workspaceReadOnly, preview });
  const [frame, setFrame] = useState<PreviewWindowFrame>(() => {
    const frame = getDefaultPreviewFrame();
    const offset = (preview.cascadeIndex % 6) * 34;
    return constrainPreviewFrame({
      ...frame,
      x: frame.x + offset,
      y: frame.y + offset
    });
  });
  const interactionRef = useRef<PreviewWindowInteraction | null>(null);

  useEffect(() => {
    const handleResize = () => {
      setFrame((current) => constrainPreviewFrame(current));
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  function startMove(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }

    const target = event.target as HTMLElement | null;
    if (target?.closest("button, input, textarea, select, a, [role='tab']")) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    interactionRef.current = {
      type: "move",
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: frame.x,
      startY: frame.y
    };
  }

  function startResize(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    interactionRef.current = {
      type: "resize",
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startWidth: frame.width,
      startHeight: frame.height
    };
  }

  function updateInteraction(event: PointerEvent<HTMLDivElement>) {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - interaction.startClientX;
    const deltaY = event.clientY - interaction.startClientY;
    if (interaction.type === "move") {
      setFrame((current) =>
        constrainPreviewFrame({
          ...current,
          x: interaction.startX + deltaX,
          y: interaction.startY + deltaY
        })
      );
      return;
    }

    setFrame((current) =>
      constrainPreviewFrame({
        ...current,
        width: interaction.startWidth + deltaX,
        height: interaction.startHeight + deltaY
      })
    );
  }

  function endInteraction(event: PointerEvent<HTMLDivElement>) {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) {
      return;
    }

    interactionRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function resetFrame() {
    setFrame(getDefaultPreviewFrame());
  }

  return (
    <div
      className="workspace-file-preview-shell absolute z-40"
      onPointerDown={() => props.actions.focusPreviewWindow(preview.id)}
      style={{
        left: 0,
        top: 0,
        width: frame.width,
        height: frame.height,
        transform: `translate3d(${frame.x}px, ${frame.y}px, 0)`,
        zIndex: 40 + Math.max(0, props.previewCount - props.index)
      }}
      onPointerMove={updateInteraction}
      onPointerUp={endInteraction}
      onPointerCancel={endInteraction}
    >
      <div className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-[28px] border border-black/10 bg-background/94 shadow-[0_32px_90px_-42px_rgba(15,23,42,0.6)] backdrop-blur-xl">
        <div
          className="flex cursor-move touch-none select-none items-center justify-between gap-3 border-b border-black/8 px-3 py-2"
          onPointerDown={startMove}
          onDoubleClick={resetFrame}
        >
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <Move className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
              <p className="truncate text-sm font-semibold tracking-tight text-foreground">{selectedEntry.name}</p>
              <span className="shrink-0 rounded-full border border-black/8 bg-black/[0.025] px-2 py-0.5 text-[10px] text-muted-foreground">
                {formatSize(selectedFile?.sizeBytes ?? selectedEntry.sizeBytes)}
              </span>
              <span
                className="hidden max-w-56 shrink truncate rounded-full border border-black/8 bg-black/[0.025] px-2 py-0.5 text-[10px] text-muted-foreground md:inline-block"
                title={selectedFile?.mimeType ?? selectedEntry.mimeType ?? "unknown"}
              >
                {selectedFile?.mimeType ?? selectedEntry.mimeType ?? "unknown"}
              </span>
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{selectedEntry.path}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {selectedFile?.truncated ? <Badge variant="outline">preview only</Badge> : null}
            {previewDirty ? <Badge variant="secondary">unsaved</Badge> : null}
            <Button
              size="sm"
              className="h-8"
              onClick={() => props.actions.savePreviewWindow(preview.id)}
              disabled={!previewDirty || !previewEditable || props.mutationBusy}
            >
              Save
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-xl" onClick={resetFrame} title="Reset preview window" aria-label="Reset preview window">
              <Maximize2 className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-xl" onClick={() => props.actions.closePreviewWindow(preview.id)} aria-label="Close preview">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden px-3 py-3">
          {!selectedFile ? (
            <div className="flex h-full min-h-[240px] items-center justify-center">
              <div className="text-center">
                <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
                <p className="mt-3 text-xs text-muted-foreground">Loading preview</p>
              </div>
            </div>
          ) : (
            <div className="h-full min-h-0">
              {imagePreviewUrl ? (
                <div className="h-full min-h-0 overflow-hidden rounded-2xl border border-black/10 bg-black/[0.03] p-2">
                  <img src={imagePreviewUrl} alt={selectedEntry.name} className="h-full w-full rounded-xl object-contain" />
                </div>
              ) : isPreviewText(preview) ? (
                <div className="h-full min-h-0">
                  <TextPreview
                    preview={preview}
                    editable={previewEditable}
                    onDraftChange={(value) => props.actions.setPreviewWindowDraft(preview.id, value)}
                  />
                </div>
              ) : (
                <div className="h-full min-h-0 space-y-3 overflow-auto">
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
        <div
          className="absolute bottom-2 right-2 h-5 w-5 cursor-nwse-resize touch-none rounded-md border border-black/10 bg-background/70 shadow-sm backdrop-blur transition hover:bg-background"
          onPointerDown={startResize}
          title="Resize preview window"
          aria-label="Resize preview window"
        >
          <div className="absolute bottom-1 right-1 h-2.5 w-2.5 border-b-2 border-r-2 border-muted-foreground/45" />
        </div>
      </div>
    </div>
  );
});

export function WorkspaceFileManagerPanel(props: { fileManager: FileManagerProps }) {
  const { fileManager } = props;
  const [commandMode, setCommandMode] = useState<"new-file" | "new-directory" | "move" | null>(null);
  const [commandValue, setCommandValue] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewActionRef = useRef({
    closePreviewWindow: fileManager.closePreviewWindow,
    focusPreviewWindow: fileManager.focusPreviewWindow,
    savePreviewWindow: fileManager.savePreviewWindow,
    setPreviewWindowDraft: fileManager.setPreviewWindowDraft
  });
  previewActionRef.current = {
    closePreviewWindow: fileManager.closePreviewWindow,
    focusPreviewWindow: fileManager.focusPreviewWindow,
    savePreviewWindow: fileManager.savePreviewWindow,
    setPreviewWindowDraft: fileManager.setPreviewWindowDraft
  };
  const previewActions = useMemo<PreviewWindowActions>(() => ({
    closePreviewWindow: (id) => previewActionRef.current.closePreviewWindow(id),
    focusPreviewWindow: (id) => previewActionRef.current.focusPreviewWindow(id),
    savePreviewWindow: (id) => previewActionRef.current.savePreviewWindow(id),
    setPreviewWindowDraft: (id, value) => previewActionRef.current.setPreviewWindowDraft(id, value)
  }), []);

  if (!fileManager.canManageFiles) {
    return null;
  }

  const selectedEntry = fileManager.selectedEntry;
  const busy = fileManager.entriesBusy || fileManager.entriesLoadingMore || fileManager.fileBusy || fileManager.mutationBusy;
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

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (fileManager.workspaceReadOnly || fileManager.mutationBusy) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragActive(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDragActive(false);
    }
  }

  async function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (fileManager.workspaceReadOnly || fileManager.mutationBusy) {
      return;
    }

    event.preventDefault();
    setDragActive(false);
    const uploadItems = await collectDroppedFiles(event.dataTransfer);
    if (uploadItems.length > 0) {
      fileManager.uploadFiles(uploadItems);
    }
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
        <div className="workspace-file-dock pointer-events-none absolute bottom-24 right-4 z-30 md:bottom-28 md:right-6">
          <Button
            className="workspace-file-dock-button pointer-events-auto h-12 rounded-2xl px-4 shadow-[0_22px_48px_-28px_rgba(15,23,42,0.55)]"
            onClick={() => fileManager.setOpen(true)}
          >
            <PanelRightOpen className="h-4 w-4" />
            Files
          </Button>
        </div>
      ) : (
        <>
          {fileManager.previewWindows.map((preview, index) => (
            <WorkspaceFilePreviewWindow
              key={preview.id}
              preview={preview}
              index={index}
              previewCount={fileManager.previewWindows.length}
              workspaceReadOnly={fileManager.workspaceReadOnly}
              mutationBusy={fileManager.mutationBusy}
              actions={previewActions}
            />
          ))}
          <div
            className="workspace-file-panel-shell absolute inset-x-3 bottom-24 z-20 md:inset-x-auto md:bottom-28 md:right-5 md:w-[320px]"
            style={{ top: "auto", height: "min(50%, calc(100% - 10.5rem))" }}
          >
            <div
              className={cn(
                "relative flex h-full flex-col overflow-hidden rounded-[28px] border bg-background/92 shadow-[0_32px_90px_-42px_rgba(15,23,42,0.55)] backdrop-blur-xl transition",
                dragActive ? "border-primary/45 ring-4 ring-primary/10" : "border-black/10"
              )}
              onDragOver={handleDragOver}
              onDragEnter={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              {dragActive ? (
                <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-[24px] border border-dashed border-primary/50 bg-background/35">
                  <div className="text-center">
                    <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                      <Upload className="h-5 w-5" />
                    </div>
                    <p className="mt-3 text-sm font-semibold text-foreground">Drop files or folders to upload</p>
                    <p className="mt-1 text-xs text-muted-foreground">Folder structure is preserved under {displayPath}.</p>
                  </div>
                </div>
              ) : null}
              <div className="border-b border-black/8 px-4 py-3">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border border-black/10 bg-black/[0.03] text-foreground">
                      <Folder className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <p className="truncate text-sm font-semibold tracking-tight text-foreground">Workspace Files</p>
                        {fileManager.workspaceReadOnly ? <Badge variant="outline" className="shrink-0">read only</Badge> : null}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {fileManager.workspaceName || fileManager.workspaceId}
                      </p>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant="outline" className="shrink-0">{fileManager.entries.length}</Badge>
                    <Button variant="ghost" size="icon" className="h-8 w-8 rounded-xl" onClick={() => fileManager.setOpen(false)} aria-label="Close files">
                    <PanelRightClose className="h-4 w-4" />
                  </Button>
                  </div>
                </div>
                <div className="mt-2 min-w-0 overflow-hidden rounded-xl border border-black/6 bg-black/[0.018] px-2 py-1">
                  <DirectoryBreadcrumbs breadcrumbs={fileManager.breadcrumbs} openDirectory={fileManager.openDirectory} />
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

              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex items-center justify-between px-4 py-3">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Directory</p>
                    <p className="mt-1 text-xs text-muted-foreground">{displayPath}</p>
                  </div>
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  ) : null}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
                  <div className="space-y-1">
                    {fileManager.entries.map((entry) => {
                      const active = selectedEntry?.path === entry.path;
                      const updatedAt = renderEntryUpdatedAt(entry.updatedAt);
                      const metaText = entry.type === "directory"
                        ? entry.updatedAt ? updatedAt.inline : "dir"
                        : `${formatSize(entry.sizeBytes)}${entry.updatedAt ? ` · ${updatedAt.inline}` : ""}`;

                      return (
                        <button
                          key={entry.path}
                          className={cn(
                            "flex h-9 w-full items-center gap-2 rounded-xl border px-2 text-left transition",
                            active ? "border-black/10 bg-black/[0.045] shadow-sm" : "border-transparent hover:border-black/8 hover:bg-black/[0.025]"
                          )}
                          title={`${entry.path}${entry.updatedAt ? `\n${updatedAt.detail}` : ""}`}
                          onClick={() => {
                            if (entry.type === "directory") {
                              fileManager.openDirectory(entry.path);
                              return;
                            }
                            fileManager.focusEntry(entry);
                          }}
                        >
                          <div className={cn(
                            "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border",
                            active ? "border-black/10 bg-white text-foreground" : getEntryIconTone(entry)
                          )}>
                            <EntryIcon entry={entry} />
                          </div>
                          <p className="min-w-0 flex-1 truncate text-[13px] font-medium leading-none text-foreground">{entry.name}</p>
                          <p className="max-w-[108px] shrink-0 truncate text-right text-[11px] leading-none text-muted-foreground">
                            {metaText}
                          </p>
                        </button>
                      );
                    })}

                    {fileManager.entries.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-black/10 px-4 py-8 text-center">
                        <p className="text-sm font-medium text-foreground">This directory is empty</p>
                        <p className="mt-1 text-xs text-muted-foreground">Drop files/folders here, upload files, or create a folder to get started.</p>
                      </div>
                    ) : null}

                    {fileManager.entriesHasMore ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={fileManager.loadMoreEntries}
                        disabled={fileManager.entriesLoadingMore}
                      >
                        {fileManager.entriesLoadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                        Load more
                      </Button>
                    ) : null}

                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

export const WorkspaceFileManagerContainer = memo(function WorkspaceFileManagerContainer(props: { fileManager: WorkspaceFileManagerParams }) {
  const fileManager = useWorkspaceFileManager(props.fileManager);
  return <WorkspaceFileManagerPanel fileManager={fileManager.fileManagerSurfaceProps} />;
});
