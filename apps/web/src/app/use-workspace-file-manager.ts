import { useEffect, useMemo, useRef, useState } from "react";

import type {
  CreateWorkspaceDirectoryRequest,
  MoveWorkspaceEntryRequest,
  SandboxHttpBody,
  PutWorkspaceFileRequest,
  SandboxHttpTransport,
  Workspace,
  WorkspaceDeleteEntryQuery,
  WorkspaceEntriesQuery,
  WorkspaceEntry,
  WorkspaceEntryPage,
  WorkspaceFileContent,
  WorkspaceFileContentQuery,
  WorkspaceFileUploadQuery
} from "@oah/api-contracts";
import {
  createSandboxHttpClient,
  joinWorkspaceRelativePath,
  normalizeWorkspaceRelativePath,
  parentWorkspaceRelativePath,
  sandboxPathToWorkspaceRelativePath,
  workspaceRelativePathToSandboxPath
} from "@oah/api-contracts";

import {
  buildAuthHeaders,
  buildUrl,
  createHttpRequestError,
  pathLeaf,
  toErrorMessage,
  type ConnectionSettings
} from "./support";

type AppRequest = <T>(path: string, init?: RequestInit, options?: { auth?: boolean }) => Promise<T>;

export interface WorkspaceFileManagerParams {
  connection: ConnectionSettings;
  request: AppRequest;
  workspaceId: string;
  workspace: Workspace | null;
  enabled: boolean;
  setActivity: (value: string) => void;
  setErrorMessage: (value: string) => void;
}

export type WorkspaceUploadItem = WorkspaceUploadFileItem | WorkspaceUploadDirectoryItem;

export interface WorkspaceUploadFileItem {
  type: "file";
  file: File;
  relativePath?: string;
}

export interface WorkspaceUploadDirectoryItem {
  type: "directory";
  relativePath: string;
}

const BINARY_PREVIEW_BYTES = 96 * 1024;
const ENTRY_METADATA_REFRESH_DELAY_MS = 700;
const ENTRY_CACHE_TTL_MS = 15_000;
const FILE_PREVIEW_CACHE_TTL_MS = 30_000;
const FILE_PREFETCH_MAX_BYTES = 128 * 1024;
const ENTRY_PREFETCH_DELAY_MS = 80;
const ENTRY_PAGE_SIZE = 200;

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function toWorkspaceEntry(entry: WorkspaceEntry): WorkspaceEntry {
  return {
    ...entry,
    path: sandboxPathToWorkspaceRelativePath(entry.path)
  };
}

function toWorkspaceEntryPage(page: WorkspaceEntryPage): WorkspaceEntryPage {
  return {
    ...page,
    path: sandboxPathToWorkspaceRelativePath(page.path),
    items: page.items.map(toWorkspaceEntry)
  };
}

function toWorkspaceFileContent(file: WorkspaceFileContent): WorkspaceFileContent {
  return {
    ...file,
    path: sandboxPathToWorkspaceRelativePath(file.path)
  };
}

function pathExtension(value: string): string {
  const leaf = pathLeaf(value);
  const dotIndex = leaf.lastIndexOf(".");
  return dotIndex >= 0 ? leaf.slice(dotIndex + 1).toLowerCase() : "";
}

function isImageEntry(entry: Pick<WorkspaceEntry, "path" | "mimeType">): boolean {
  if (entry.mimeType?.startsWith("image/")) {
    return true;
  }

  return ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(pathExtension(entry.path));
}

function shouldLimitFilePreview(entry: Pick<WorkspaceEntry, "path" | "mimeType">): boolean {
  return !isTextEntry(entry) && !isImageEntry(entry);
}

function isTextEntry(entry: Pick<WorkspaceEntry, "path" | "mimeType">): boolean {
  const mimeType = entry.mimeType?.toLowerCase() ?? "";
  if (
    mimeType.startsWith("text/") ||
    mimeType.includes("json") ||
    mimeType.includes("xml") ||
    mimeType.includes("yaml") ||
    mimeType.includes("javascript") ||
    mimeType.includes("typescript") ||
    mimeType.includes("markdown") ||
    mimeType.includes("x-sh")
  ) {
    return true;
  }

  return [
    "txt",
    "md",
    "mdx",
    "json",
    "js",
    "jsx",
    "ts",
    "tsx",
    "css",
    "scss",
    "html",
    "xml",
    "yml",
    "yaml",
    "toml",
    "ini",
    "conf",
    "env",
    "sh",
    "py",
    "rb",
    "go",
    "rs",
    "java",
    "kt",
    "swift",
    "sql",
    "log"
  ].includes(pathExtension(entry.path));
}

function isEditableFile(input: {
  workspaceReadOnly: boolean;
  entry: WorkspaceEntry | null;
  file: WorkspaceFileContent | null;
}): boolean {
  return Boolean(
    !input.workspaceReadOnly &&
      input.entry?.type === "file" &&
      input.file?.encoding === "utf8" &&
      !input.file.truncated &&
      !input.file.readOnly &&
      isTextEntry(input.entry)
  );
}

interface WorkspaceFilePreviewWindowState {
  id: string;
  entry: WorkspaceEntry;
  file: WorkspaceFileContent | null;
  draft: string;
  cascadeIndex: number;
}

interface CachedEntryPage {
  page: WorkspaceEntryPage;
  cachedAtMs: number;
}

interface CachedFileContent {
  file: WorkspaceFileContent;
  cachedAtMs: number;
  entryStamp: string;
}

function mergeWorkspaceEntries(pages: WorkspaceEntryPage[]): WorkspaceEntryPage | null {
  if (pages.length === 0) {
    return null;
  }

  const itemsByPath = new Map<string, WorkspaceEntry>();
  for (const page of pages) {
    for (const entry of page.items) {
      itemsByPath.set(entry.path, entry);
    }
  }

  const lastPage = pages[pages.length - 1];
  if (!lastPage) {
    return null;
  }

  return {
    workspaceId: lastPage.workspaceId,
    path: lastPage.path,
    items: [...itemsByPath.values()]
  };
}

function workspaceCacheKey(workspaceId: string, targetPath: string): string {
  return `${workspaceId}::${normalizeWorkspaceRelativePath(targetPath)}`;
}

function filePreviewCacheKey(workspaceId: string, entry: Pick<WorkspaceEntry, "path">): string {
  return `${workspaceId}::${normalizeWorkspaceRelativePath(entry.path)}`;
}

function entryCacheStamp(entry: Pick<WorkspaceEntry, "etag" | "sizeBytes" | "updatedAt" | "mimeType">): string {
  return [entry.etag ?? "", entry.sizeBytes ?? "", entry.updatedAt ?? "", entry.mimeType ?? ""].join("|");
}

function getCachedEntryPage(
  cache: Map<string, CachedEntryPage>,
  workspaceId: string,
  targetPath: string
): WorkspaceEntryPage | null {
  const cached = cache.get(workspaceCacheKey(workspaceId, targetPath));
  if (!cached || Date.now() - cached.cachedAtMs > ENTRY_CACHE_TTL_MS) {
    return null;
  }

  return cached.page;
}

function setCachedEntryPage(
  cache: Map<string, CachedEntryPage>,
  workspaceId: string,
  targetPath: string,
  page: WorkspaceEntryPage
): void {
  cache.set(workspaceCacheKey(workspaceId, targetPath), {
    page,
    cachedAtMs: Date.now()
  });
}

function getCachedFileContent(
  cache: Map<string, CachedFileContent>,
  workspaceId: string,
  entry: WorkspaceEntry
): WorkspaceFileContent | null {
  const cached = cache.get(filePreviewCacheKey(workspaceId, entry));
  if (!cached || Date.now() - cached.cachedAtMs > FILE_PREVIEW_CACHE_TTL_MS) {
    return null;
  }

  const stamp = entryCacheStamp(entry);
  if (stamp !== "|||" && cached.entryStamp !== stamp) {
    return null;
  }

  return cached.file;
}

function setCachedFileContent(
  cache: Map<string, CachedFileContent>,
  workspaceId: string,
  entry: WorkspaceEntry,
  file: WorkspaceFileContent
): void {
  cache.set(filePreviewCacheKey(workspaceId, entry), {
    file,
    cachedAtMs: Date.now(),
    entryStamp: entryCacheStamp({
      ...entry,
      etag: file.etag ?? entry.etag,
      sizeBytes: file.sizeBytes ?? entry.sizeBytes,
      updatedAt: file.updatedAt ?? entry.updatedAt,
      mimeType: file.mimeType ?? entry.mimeType
    })
  });
}

function areEntryPagesEqual(left: WorkspaceEntryPage | null, right: WorkspaceEntryPage | null): boolean {
  if (left === right) {
    return true;
  }

  if (!left || !right || left.path !== right.path || left.nextCursor !== right.nextCursor || left.items.length !== right.items.length) {
    return false;
  }

  return left.items.every((entry, index) => {
    const next = right.items[index];
    return Boolean(
      next &&
        entry.path === next.path &&
        entry.name === next.name &&
        entry.type === next.type &&
        entry.sizeBytes === next.sizeBytes &&
        entry.mimeType === next.mimeType &&
        entry.etag === next.etag &&
        entry.updatedAt === next.updatedAt &&
        entry.readOnly === next.readOnly
    );
  });
}

async function loadEntryPages(input: {
  workspaceId: string;
  targetPath: string;
  sandboxClient: ReturnType<typeof createSandboxHttpClient>;
  includeEntryMetadata: boolean;
  includeDirectoryDescendantUpdatedAt?: boolean | undefined;
  pageSize?: number | undefined;
  maxPages?: number | undefined;
  signal?: AbortSignal | undefined;
  onPage?: ((pages: WorkspaceEntryPage[]) => void) | undefined;
  isCurrent?: (() => boolean) | undefined;
}): Promise<WorkspaceEntryPage | null> {
  const pages: WorkspaceEntryPage[] = [];
  let cursor: string | undefined;

  do {
    const page = toWorkspaceEntryPage(
      await input.sandboxClient.listEntries(input.workspaceId, {
        path: workspaceRelativePathToSandboxPath(input.targetPath),
        pageSize: input.pageSize ?? ENTRY_PAGE_SIZE,
        sortBy: "name",
        sortOrder: "asc",
        ...(cursor ? { cursor } : {}),
        includeDirectoryDescendantUpdatedAt: input.includeDirectoryDescendantUpdatedAt,
        includeEntryMetadata: input.includeEntryMetadata
      } satisfies WorkspaceEntriesQuery,
      input.signal ? { signal: input.signal } : undefined)
    );
    if (input.isCurrent && !input.isCurrent()) {
      return null;
    }

    pages.push(page);
    input.onPage?.(pages);
    if (input.maxPages !== undefined && pages.length >= input.maxPages) {
      break;
    }
    cursor = page.nextCursor;
  } while (cursor);

  return mergeWorkspaceEntries(pages);
}

async function loadEntryPage(input: {
  workspaceId: string;
  targetPath: string;
  sandboxClient: ReturnType<typeof createSandboxHttpClient>;
  includeEntryMetadata: boolean;
  includeDirectoryDescendantUpdatedAt?: boolean | undefined;
  cursor?: string | undefined;
  pageSize?: number | undefined;
  signal?: AbortSignal | undefined;
}): Promise<WorkspaceEntryPage> {
  return toWorkspaceEntryPage(
    await input.sandboxClient.listEntries(input.workspaceId, {
      path: workspaceRelativePathToSandboxPath(input.targetPath),
      pageSize: input.pageSize ?? ENTRY_PAGE_SIZE,
      sortBy: "name",
      sortOrder: "asc",
      ...(input.cursor ? { cursor: input.cursor } : {}),
      includeDirectoryDescendantUpdatedAt: input.includeDirectoryDescendantUpdatedAt,
      includeEntryMetadata: input.includeEntryMetadata
    } satisfies WorkspaceEntriesQuery,
    input.signal ? { signal: input.signal } : undefined)
  );
}

export function useWorkspaceFileManager(params: WorkspaceFileManagerParams) {
  const [open, setOpen] = useState(false);
  const [currentPath, setCurrentPath] = useState(".");
  const [entryPage, setEntryPage] = useState<WorkspaceEntryPage | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<WorkspaceEntry | null>(null);
  const [selectedFile, setSelectedFile] = useState<WorkspaceFileContent | null>(null);
  const [selectedFileDraft, setSelectedFileDraft] = useState("");
  const [previewWindows, setPreviewWindows] = useState<WorkspaceFilePreviewWindowState[]>([]);
  const [entriesBusy, setEntriesBusy] = useState(false);
  const [entriesLoadingMore, setEntriesLoadingMore] = useState(false);
  const [entriesRefreshingMetadata, setEntriesRefreshingMetadata] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [mutationBusy, setMutationBusy] = useState(false);
  const previousOpenRef = useRef(false);
  const previousWorkspaceIdRef = useRef(params.workspaceId.trim());
  const entriesRequestSeqRef = useRef(0);
  const fileRequestSeqRef = useRef(0);
  const entriesAbortRef = useRef<AbortController | null>(null);
  const metadataAbortRef = useRef<AbortController | null>(null);
  const fileAbortRef = useRef<AbortController | null>(null);
  const metadataRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const entryPrefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const entryPageCacheRef = useRef(new Map<string, CachedEntryPage>());
  const fileContentCacheRef = useRef(new Map<string, CachedFileContent>());
  const filePrefetchingRef = useRef(new Set<string>());
  const previewWindowSeqRef = useRef(0);

  const workspaceIdValue = params.workspaceId.trim();
  const workspaceReadOnly = params.workspace?.readOnly ?? false;
  const normalizedCurrentPath = normalizeWorkspaceRelativePath(currentPath);
  const entries = entryPage?.items ?? [];

  const sandboxClient = useMemo(() => {
    const transport: SandboxHttpTransport = {
      requestJson: (path, init) => params.request(path, init),
      async requestBytes(path, init) {
        const response = await fetch(buildUrl(params.connection.baseUrl, path), {
          ...init,
          headers: buildAuthHeaders(params.connection, init?.headers)
        });
        if (!response.ok) {
          throw await createHttpRequestError(response);
        }

        return new Uint8Array(await response.arrayBuffer());
      }
    };

    return createSandboxHttpClient(transport);
  }, [params.connection, params.request]);

  const selectedFileEditable = isEditableFile({
    workspaceReadOnly,
    entry: selectedEntry,
    file: selectedFile
  });
  const selectedFileDirty = selectedFileEditable && selectedFile !== null && selectedFileDraft !== selectedFile.content;

  const breadcrumbs = useMemo(() => {
    if (normalizedCurrentPath === ".") {
      return [{ label: "workspace", path: "." }];
    }

    const segments = normalizedCurrentPath.split("/");
    return [
      { label: "workspace", path: "." },
      ...segments.map((segment, index) => ({
        label: segment,
        path: segments.slice(0, index + 1).join("/")
      }))
    ];
  }, [normalizedCurrentPath]);

  async function refreshEntries(options?: {
    path?: string;
    quiet?: boolean;
  }): Promise<WorkspaceEntryPage | null> {
    const requestSeq = entriesRequestSeqRef.current + 1;
    entriesRequestSeqRef.current = requestSeq;
    entriesAbortRef.current?.abort();
    metadataAbortRef.current?.abort();
    if (metadataRefreshTimerRef.current) {
      clearTimeout(metadataRefreshTimerRef.current);
      metadataRefreshTimerRef.current = null;
    }
    if (entryPrefetchTimerRef.current) {
      clearTimeout(entryPrefetchTimerRef.current);
      entryPrefetchTimerRef.current = null;
    }
    if (!workspaceIdValue) {
      setEntryPage(null);
      return null;
    }

    const targetPath = normalizeWorkspaceRelativePath(options?.path ?? currentPath);
    const entriesController = new AbortController();
    entriesAbortRef.current = entriesController;
    const cachedPage = getCachedEntryPage(entryPageCacheRef.current, workspaceIdValue, targetPath);

    try {
      if (cachedPage) {
        setCurrentPath(normalizeWorkspaceRelativePath(cachedPage.path));
        setEntryPage(cachedPage);
      }
      if (!cachedPage) {
        setEntriesBusy(true);
      }
      const initialResponse = await loadEntryPage({
        workspaceId: workspaceIdValue,
        targetPath,
        sandboxClient,
        includeEntryMetadata: false,
        includeDirectoryDescendantUpdatedAt: false,
        signal: entriesController.signal,
        pageSize: ENTRY_PAGE_SIZE
      });
      if (entriesRequestSeqRef.current !== requestSeq) {
        return null;
      }

      if (!initialResponse) {
        setEntryPage(null);
        return null;
      }

      setCurrentPath(normalizeWorkspaceRelativePath(initialResponse.path));
      const normalizedResponse = {
        ...initialResponse,
        path: normalizeWorkspaceRelativePath(initialResponse.path)
      };
      setCachedEntryPage(entryPageCacheRef.current, workspaceIdValue, targetPath, normalizedResponse);
      setEntryPage((current) => (areEntryPagesEqual(current, normalizedResponse) ? current : normalizedResponse));
      if (!options?.quiet) {
        const responsePath = normalizeWorkspaceRelativePath(initialResponse.path);
        params.setActivity(
          `已加载 ${responsePath === "." ? "workspace 根目录" : responsePath}（${initialResponse.items.length}${initialResponse.nextCursor ? "+" : ""} 项）`
        );
        params.setErrorMessage("");
      }
      metadataRefreshTimerRef.current = setTimeout(() => {
        metadataRefreshTimerRef.current = null;
        void refreshEntryMetadata({
          path: targetPath,
          expectedRequestSeq: requestSeq,
          quiet: true
        });
      }, ENTRY_METADATA_REFRESH_DELAY_MS);
      entryPrefetchTimerRef.current = setTimeout(() => {
        entryPrefetchTimerRef.current = null;
        void prefetchSmallFilePreviews(initialResponse.items);
      }, ENTRY_PREFETCH_DELAY_MS);
      return initialResponse;
    } catch (error) {
      if (isAbortError(error)) {
        return null;
      }
      if (entriesRequestSeqRef.current === requestSeq && !options?.quiet) {
        params.setErrorMessage(toErrorMessage(error));
      }
      return null;
    } finally {
      if (entriesAbortRef.current === entriesController) {
        entriesAbortRef.current = null;
      }
      if (entriesRequestSeqRef.current === requestSeq) {
        setEntriesBusy(false);
      }
    }
  }

  async function loadMoreEntries(): Promise<void> {
    if (!workspaceIdValue || entriesBusy || entriesLoadingMore || !entryPage?.nextCursor) {
      return;
    }

    const requestSeq = entriesRequestSeqRef.current;
    const targetPath = normalizeWorkspaceRelativePath(entryPage.path);
    const cursor = entryPage.nextCursor;
    const entriesController = new AbortController();
    entriesAbortRef.current?.abort();
    entriesAbortRef.current = entriesController;
    try {
      setEntriesLoadingMore(true);
      const response = await loadEntryPage({
        workspaceId: workspaceIdValue,
        targetPath,
        sandboxClient,
        includeEntryMetadata: true,
        includeDirectoryDescendantUpdatedAt: false,
        cursor,
        pageSize: ENTRY_PAGE_SIZE,
        signal: entriesController.signal
      });
      if (entriesRequestSeqRef.current !== requestSeq) {
        return;
      }

      setEntryPage((current) => {
        if (!current || normalizeWorkspaceRelativePath(current.path) !== normalizeWorkspaceRelativePath(response.path)) {
          return current;
        }

        const itemsByPath = new Map(current.items.map((entry) => [entry.path, entry]));
        for (const entry of response.items) {
          itemsByPath.set(entry.path, entry);
        }
        const next = {
          ...response,
          path: normalizeWorkspaceRelativePath(response.path),
          items: [...itemsByPath.values()]
        };
        setCachedEntryPage(entryPageCacheRef.current, workspaceIdValue, targetPath, next);
        return next;
      });
      void prefetchSmallFilePreviews(response.items);
    } catch (error) {
      if (!isAbortError(error)) {
        params.setErrorMessage(toErrorMessage(error));
      }
    } finally {
      if (entriesAbortRef.current === entriesController) {
        entriesAbortRef.current = null;
      }
      if (entriesRequestSeqRef.current === requestSeq) {
        setEntriesLoadingMore(false);
      }
    }
  }

  async function refreshEntryMetadata(options: {
    path: string;
    expectedRequestSeq: number;
    quiet?: boolean | undefined;
  }): Promise<void> {
    if (!workspaceIdValue) {
      return;
    }

    const targetPath = normalizeWorkspaceRelativePath(options.path);
    metadataAbortRef.current?.abort();
    const metadataController = new AbortController();
    metadataAbortRef.current = metadataController;
    try {
      setEntriesRefreshingMetadata(true);
      const loadedItemCount = entryPage?.items.length ?? ENTRY_PAGE_SIZE;
      const loadedPageCount = Math.max(1, Math.ceil(loadedItemCount / ENTRY_PAGE_SIZE));
      const response = await loadEntryPages({
        workspaceId: workspaceIdValue,
        targetPath,
        sandboxClient,
        includeEntryMetadata: true,
        includeDirectoryDescendantUpdatedAt: false,
        maxPages: loadedPageCount,
        signal: metadataController.signal,
        isCurrent: () => entriesRequestSeqRef.current === options.expectedRequestSeq
      });
      if (!response || entriesRequestSeqRef.current !== options.expectedRequestSeq) {
        return;
      }

      setEntryPage((current) => {
        if (!current || normalizeWorkspaceRelativePath(current.path) !== normalizeWorkspaceRelativePath(response.path)) {
          return current;
        }

        const itemsByPath = new Map(current.items.map((entry) => [entry.path, entry]));
        for (const entry of response.items) {
          itemsByPath.set(entry.path, entry);
        }
        const next = {
          ...current,
          items: [...itemsByPath.values()]
        };
        setCachedEntryPage(entryPageCacheRef.current, workspaceIdValue, targetPath, next);
        return areEntryPagesEqual(current, next) ? current : next;
      });
      void prefetchSmallFilePreviews(response.items);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      if (entriesRequestSeqRef.current === options.expectedRequestSeq && !options.quiet) {
        params.setErrorMessage(toErrorMessage(error));
      }
    } finally {
      if (metadataAbortRef.current === metadataController) {
        metadataAbortRef.current = null;
      }
      if (entriesRequestSeqRef.current === options.expectedRequestSeq) {
        setEntriesRefreshingMetadata(false);
      }
    }
  }

  async function prefetchSmallFilePreviews(candidateEntries: WorkspaceEntry[]): Promise<void> {
    if (!workspaceIdValue) {
      return;
    }

    const candidates = candidateEntries
      .filter((entry) => entry.type === "file")
      .filter((entry) => typeof entry.sizeBytes === "number" && entry.sizeBytes <= FILE_PREFETCH_MAX_BYTES)
      .filter((entry) => isTextEntry(entry) || isImageEntry(entry))
      .filter((entry) => !getCachedFileContent(fileContentCacheRef.current, workspaceIdValue, entry))
      .slice(0, 8);

    await Promise.all(
      candidates.map(async (entry) => {
        const key = filePreviewCacheKey(workspaceIdValue, entry);
        if (filePrefetchingRef.current.has(key)) {
          return;
        }

        filePrefetchingRef.current.add(key);
        try {
          const response = toWorkspaceFileContent(
            await sandboxClient.getFileContent(workspaceIdValue, {
              path: workspaceRelativePathToSandboxPath(entry.path),
              encoding: isTextEntry(entry) ? "utf8" : "base64"
            } satisfies WorkspaceFileContentQuery)
          );
          setCachedFileContent(fileContentCacheRef.current, workspaceIdValue, entry, response);
        } catch {
          // Prefetch is only an opportunistic latency hint.
        } finally {
          filePrefetchingRef.current.delete(key);
        }
      })
    );
  }

  async function focusEntry(entry: WorkspaceEntry, quiet = false): Promise<void> {
    if (entry.type === "file") {
      const existingPreview = previewWindows.find((preview) => preview.id === entry.path);
      if (existingPreview?.file) {
        setSelectedEntry(entry);
        setPreviewWindows((current) => [existingPreview, ...current.filter((preview) => preview.id !== entry.path)]);
        if (!quiet) {
          params.setActivity(`已打开 ${entry.name}`);
          params.setErrorMessage("");
        }
        return;
      }

      const cachedFile = getCachedFileContent(fileContentCacheRef.current, workspaceIdValue, entry);
      if (cachedFile) {
        fileRequestSeqRef.current += 1;
        fileAbortRef.current?.abort();
        setSelectedEntry(entry);
        setFileBusy(false);
        setPreviewWindows((current) => {
          const existing = current.find((preview) => preview.id === entry.path);
          const nextPreview: WorkspaceFilePreviewWindowState = {
            id: entry.path,
            entry,
            file: cachedFile,
            draft: existing && existing.file?.content === cachedFile.content ? existing.draft : cachedFile.encoding === "utf8" ? cachedFile.content : "",
            cascadeIndex: existing?.cascadeIndex ?? previewWindowSeqRef.current++
          };
          return [nextPreview, ...current.filter((preview) => preview.id !== entry.path)];
        });
        if (!quiet) {
          params.setActivity(`已打开 ${entry.name}`);
          params.setErrorMessage("");
        }
        return;
      }
    }

    const requestSeq = fileRequestSeqRef.current + 1;
    fileRequestSeqRef.current = requestSeq;
    fileAbortRef.current?.abort();
    const fileController = new AbortController();
    fileAbortRef.current = fileController;
    setSelectedEntry(entry);
    if (entry.type === "directory") {
      setSelectedFile(null);
      setSelectedFileDraft("");
      setFileBusy(false);
      if (fileAbortRef.current === fileController) {
        fileAbortRef.current = null;
      }
      return;
    }

    setPreviewWindows((current) => {
      const existing = current.find((preview) => preview.id === entry.path);
      const nextPreview: WorkspaceFilePreviewWindowState = existing ?? {
        id: entry.path,
        entry,
        file: null,
        draft: "",
        cascadeIndex: previewWindowSeqRef.current++
      };
      return [nextPreview, ...current.filter((preview) => preview.id !== entry.path)];
    });

    try {
      setFileBusy(true);
      const response = toWorkspaceFileContent(
        await sandboxClient.getFileContent(workspaceIdValue, {
          path: workspaceRelativePathToSandboxPath(entry.path),
          encoding: isTextEntry(entry) ? "utf8" : "base64",
          ...(shouldLimitFilePreview(entry) ? { maxBytes: BINARY_PREVIEW_BYTES } : {})
        } satisfies WorkspaceFileContentQuery,
        { signal: fileController.signal })
      );
      if (fileRequestSeqRef.current !== requestSeq) {
        return;
      }

      setCachedFileContent(fileContentCacheRef.current, workspaceIdValue, entry, response);
      setPreviewWindows((current) => {
        const existing = current.find((preview) => preview.id === entry.path);
        const nextPreview: WorkspaceFilePreviewWindowState = {
          id: entry.path,
          entry,
          file: response,
          draft: existing && existing.file?.content === response.content ? existing.draft : response.encoding === "utf8" ? response.content : "",
          cascadeIndex: existing?.cascadeIndex ?? previewWindowSeqRef.current++
        };
        return [nextPreview, ...current.filter((preview) => preview.id !== entry.path)];
      });
      if (!quiet) {
        params.setActivity(`已打开 ${entry.name}`);
        params.setErrorMessage("");
      }
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      if (fileRequestSeqRef.current !== requestSeq) {
        return;
      }

      setPreviewWindows((current) =>
        current.map((preview) => (preview.id === entry.path ? { ...preview, file: null, draft: "" } : preview))
      );
      if (!quiet) {
        params.setErrorMessage(toErrorMessage(error));
      }
    } finally {
      if (fileAbortRef.current === fileController) {
        fileAbortRef.current = null;
      }
      if (fileRequestSeqRef.current === requestSeq) {
        setFileBusy(false);
      }
    }
  }

  async function openDirectory(path: string, quiet = false): Promise<void> {
    const targetPath = normalizeWorkspaceRelativePath(path);
    if (targetPath === normalizedCurrentPath && entryPage && !entriesBusy) {
      return;
    }
    setSelectedEntry(null);
    setSelectedFile(null);
    setSelectedFileDraft("");
    await refreshEntries({ path: targetPath, quiet });
  }

  function closePreviewWindow(id: string): void {
    setPreviewWindows((current) => current.filter((preview) => preview.id !== id));
    if (selectedEntry?.path === id) {
      setSelectedEntry(null);
      setSelectedFile(null);
      setSelectedFileDraft("");
    }
  }

  function focusPreviewWindow(id: string): void {
    setPreviewWindows((current) => {
      const target = current.find((preview) => preview.id === id);
      if (!target) {
        return current;
      }

      return [target, ...current.filter((preview) => preview.id !== id)];
    });
  }

  function setPreviewWindowDraft(id: string, draft: string): void {
    setPreviewWindows((current) =>
      current.map((preview) => (preview.id === id ? { ...preview, draft } : preview))
    );
    if (selectedEntry?.path === id) {
      setSelectedFileDraft(draft);
    }
  }

  async function createDirectory(path: string): Promise<void> {
    if (!workspaceIdValue || workspaceReadOnly) {
      return;
    }

    const targetPath = normalizeWorkspaceRelativePath(path);
    try {
      setMutationBusy(true);
      const entry = toWorkspaceEntry(
        await sandboxClient.createDirectory(workspaceIdValue, {
          path: workspaceRelativePathToSandboxPath(targetPath),
          createParents: true
        } satisfies CreateWorkspaceDirectoryRequest)
      );
      await refreshEntries({ path: parentWorkspaceRelativePath(entry.path), quiet: true });
      setSelectedEntry(entry);
      setSelectedFile(null);
      setSelectedFileDraft("");
      params.setActivity(`已创建目录 ${entry.path}`);
      params.setErrorMessage("");
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
    } finally {
      setMutationBusy(false);
    }
  }

  async function createFile(path: string): Promise<void> {
    if (!workspaceIdValue || workspaceReadOnly) {
      return;
    }

    const targetPath = normalizeWorkspaceRelativePath(path);
    try {
      setMutationBusy(true);
      const entry = toWorkspaceEntry(
        await sandboxClient.putFileContent(workspaceIdValue, {
          path: workspaceRelativePathToSandboxPath(targetPath),
          content: "",
          encoding: "utf8",
          overwrite: true
        } satisfies PutWorkspaceFileRequest)
      );
      await refreshEntries({ path: parentWorkspaceRelativePath(entry.path), quiet: true });
      await focusEntry(entry, true);
      params.setActivity(`已创建文件 ${entry.path}`);
      params.setErrorMessage("");
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
    } finally {
      setMutationBusy(false);
    }
  }

  async function saveSelectedFile(): Promise<void> {
    if (!workspaceIdValue || !selectedEntry || !selectedFileEditable) {
      return;
    }

    await savePreviewWindow(selectedEntry.path);
  }

  async function savePreviewWindow(id: string): Promise<void> {
    if (!workspaceIdValue) {
      return;
    }

    const preview = previewWindows.find((item) => item.id === id);
    if (!preview || !isEditableFile({ workspaceReadOnly, entry: preview.entry, file: preview.file })) {
      return;
    }

    try {
      setMutationBusy(true);
      const entry = toWorkspaceEntry(
        await sandboxClient.putFileContent(workspaceIdValue, {
          path: workspaceRelativePathToSandboxPath(preview.entry.path),
          content: preview.draft,
          encoding: "utf8",
          overwrite: true,
          ...(preview.file?.etag ? { ifMatch: preview.file.etag } : {})
        } satisfies PutWorkspaceFileRequest)
      );
      await refreshEntries({ path: parentWorkspaceRelativePath(entry.path), quiet: true });
      const response = toWorkspaceFileContent(
        await sandboxClient.getFileContent(workspaceIdValue, {
          path: workspaceRelativePathToSandboxPath(entry.path),
          encoding: "utf8"
        } satisfies WorkspaceFileContentQuery)
      );
      setPreviewWindows((current) =>
        current.map((item) =>
          item.id === id
            ? {
                id: entry.path,
                entry,
                file: response,
                draft: response.encoding === "utf8" ? response.content : "",
                cascadeIndex: item.cascadeIndex
              }
            : item
        )
      );
      setCachedFileContent(fileContentCacheRef.current, workspaceIdValue, entry, response);
      params.setActivity(`已保存 ${entry.path}`);
      params.setErrorMessage("");
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
    } finally {
      setMutationBusy(false);
    }
  }

  async function moveEntry(sourcePath: string, targetPath: string): Promise<void> {
    if (!workspaceIdValue || workspaceReadOnly) {
      return;
    }

    const normalizedSourcePath = normalizeWorkspaceRelativePath(sourcePath);
    const normalizedTargetPath = normalizeWorkspaceRelativePath(targetPath);

    try {
      setMutationBusy(true);
      const entry = toWorkspaceEntry(
        await sandboxClient.moveEntry(workspaceIdValue, {
          sourcePath: workspaceRelativePathToSandboxPath(normalizedSourcePath),
          targetPath: workspaceRelativePathToSandboxPath(normalizedTargetPath),
          overwrite: false
        } satisfies MoveWorkspaceEntryRequest)
      );
      fileContentCacheRef.current.delete(filePreviewCacheKey(workspaceIdValue, { path: normalizedSourcePath }));
      const targetDirectory = parentWorkspaceRelativePath(entry.path);
      if (targetDirectory === currentPath) {
        await refreshEntries({ path: currentPath, quiet: true });
        await focusEntry(entry, true);
      } else {
        await refreshEntries({ path: currentPath, quiet: true });
        setSelectedEntry(null);
        setSelectedFile(null);
        setSelectedFileDraft("");
      }
      params.setActivity(`已移动到 ${entry.path}`);
      params.setErrorMessage("");
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
    } finally {
      setMutationBusy(false);
    }
  }

  async function deleteEntry(entry: WorkspaceEntry): Promise<void> {
    if (!workspaceIdValue || workspaceReadOnly) {
      return;
    }

    try {
      setMutationBusy(true);
      await sandboxClient.deleteEntry(workspaceIdValue, {
        path: workspaceRelativePathToSandboxPath(entry.path),
        recursive: entry.type === "directory"
      } satisfies WorkspaceDeleteEntryQuery);
      for (const key of fileContentCacheRef.current.keys()) {
        const pathKey = `${workspaceIdValue}::`;
        if (key.startsWith(pathKey)) {
          const cachedPath = key.slice(pathKey.length);
          if (entry.type === "directory" ? cachedPath === entry.path || cachedPath.startsWith(`${entry.path}/`) : cachedPath === entry.path) {
            fileContentCacheRef.current.delete(key);
          }
        }
      }
      await refreshEntries({ path: currentPath, quiet: true });
      setPreviewWindows((current) =>
        current.filter((preview) =>
          entry.type === "directory" ? preview.entry.path !== entry.path && !preview.entry.path.startsWith(`${entry.path}/`) : preview.entry.path !== entry.path
        )
      );
      if (selectedEntry?.path === entry.path) {
        setSelectedEntry(null);
        setSelectedFile(null);
        setSelectedFileDraft("");
      }
      params.setActivity(`已删除 ${entry.path}`);
      params.setErrorMessage("");
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
    } finally {
      setMutationBusy(false);
    }
  }

  async function uploadFiles(files: FileList | File[] | WorkspaceUploadItem[]): Promise<void> {
    if (!workspaceIdValue || workspaceReadOnly) {
      return;
    }

    const uploadItems = Array.from(files as Iterable<File | WorkspaceUploadItem> | ArrayLike<File | WorkspaceUploadItem>).map((item) => {
      if (item instanceof File) {
        return { type: "file", file: item, relativePath: item.webkitRelativePath || item.name } satisfies WorkspaceUploadItem;
      }

      return item;
    });
    if (uploadItems.length === 0) {
      return;
    }

    try {
      setMutationBusy(true);
      for (const item of uploadItems) {
        if (item.type === "directory") {
          const uploadPath = normalizeWorkspaceRelativePath(item.relativePath);
          if (uploadPath !== ".") {
            await sandboxClient.createDirectory(workspaceIdValue, {
              path: workspaceRelativePathToSandboxPath(joinWorkspaceRelativePath(currentPath, uploadPath)),
              createParents: true
            } satisfies CreateWorkspaceDirectoryRequest);
          }
          continue;
        }

        const file = item.file;
        const uploadPath = normalizeWorkspaceRelativePath(item.relativePath || file.webkitRelativePath || file.name);
        const targetPath = joinWorkspaceRelativePath(currentPath, uploadPath);
        await sandboxClient.uploadFile(workspaceIdValue, {
          path: workspaceRelativePathToSandboxPath(targetPath),
          overwrite: true,
          data: file,
          contentType: "application/octet-stream",
          ...(typeof file.lastModified === "number" && file.lastModified > 0 ? { mtimeMs: file.lastModified } : {})
        } satisfies WorkspaceFileUploadQuery & { data: SandboxHttpBody; contentType: string });
      }
      await refreshEntries({ path: currentPath, quiet: true });
      const fileCount = uploadItems.filter((item) => item.type === "file").length;
      const directoryCount = uploadItems.length - fileCount;
      params.setActivity(
        fileCount === 1 && directoryCount === 0
          ? `已上传 ${uploadItems[0]?.type === "file" ? uploadItems[0].file.name : "1 个文件"}`
          : `已上传 ${fileCount} 个文件${directoryCount > 0 ? ` / ${directoryCount} 个目录` : ""}`
      );
      params.setErrorMessage("");
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
    } finally {
      setMutationBusy(false);
    }
  }

  async function downloadEntry(entry: WorkspaceEntry): Promise<void> {
    if (!workspaceIdValue || entry.type !== "file") {
      return;
    }

    try {
      setMutationBusy(true);
      const bytes = await sandboxClient.downloadFile(workspaceIdValue, {
        path: workspaceRelativePathToSandboxPath(entry.path)
      });
      const blob = new Blob([Uint8Array.from(bytes)]);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = entry.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      params.setActivity(`已开始下载 ${entry.name}`);
      params.setErrorMessage("");
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
    } finally {
      setMutationBusy(false);
    }
  }

  function closeSelection(): void {
    setSelectedEntry(null);
    setSelectedFile(null);
    setSelectedFileDraft("");
  }

  function closeAllPreviewWindows(): void {
    setPreviewWindows([]);
    closeSelection();
  }

  useEffect(() => {
    setCurrentPath(".");
    setEntryPage(null);
    closeAllPreviewWindows();
    entriesAbortRef.current?.abort();
    metadataAbortRef.current?.abort();
    fileAbortRef.current?.abort();
    if (metadataRefreshTimerRef.current) {
      clearTimeout(metadataRefreshTimerRef.current);
      metadataRefreshTimerRef.current = null;
    }
    if (entryPrefetchTimerRef.current) {
      clearTimeout(entryPrefetchTimerRef.current);
      entryPrefetchTimerRef.current = null;
    }
    entryPageCacheRef.current.clear();
    fileContentCacheRef.current.clear();
    filePrefetchingRef.current.clear();
  }, [workspaceIdValue]);

  useEffect(() => {
    return () => {
      entriesAbortRef.current?.abort();
      metadataAbortRef.current?.abort();
      fileAbortRef.current?.abort();
      if (metadataRefreshTimerRef.current) {
        clearTimeout(metadataRefreshTimerRef.current);
      }
      if (entryPrefetchTimerRef.current) {
        clearTimeout(entryPrefetchTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const wasOpen = previousOpenRef.current;
    const previousWorkspaceId = previousWorkspaceIdRef.current;
    const workspaceChanged = previousWorkspaceId !== workspaceIdValue;
    previousOpenRef.current = open;
    previousWorkspaceIdRef.current = workspaceIdValue;

    if (!params.enabled || !open || !workspaceIdValue) {
      return;
    }

    if (wasOpen && !workspaceChanged) {
      return;
    }

    void refreshEntries({
      path: workspaceChanged ? "." : normalizedCurrentPath,
      quiet: true
    });
  }, [params.enabled, open, workspaceIdValue, normalizedCurrentPath, sandboxClient]);

  return {
    fileManagerSurfaceProps: {
      open,
      setOpen,
      workspaceId: workspaceIdValue,
      workspaceName: params.workspace?.name ?? "",
      workspaceReadOnly,
      currentPath: normalizedCurrentPath,
      breadcrumbs,
      entries,
      entriesBusy,
      entriesLoadingMore,
      entriesHasMore: Boolean(entryPage?.nextCursor),
      entriesRefreshingMetadata,
      fileBusy,
      mutationBusy,
      selectedEntry,
      selectedFile,
      selectedFileDraft,
      setSelectedFileDraft,
      selectedFileEditable,
      selectedFileDirty,
      previewWindows,
      canManageFiles: Boolean(workspaceIdValue),
      openDirectory: (path: string) => void openDirectory(path, true),
      refreshEntries: () => void refreshEntries(),
      loadMoreEntries: () => void loadMoreEntries(),
      focusEntry: (entry: WorkspaceEntry) => void focusEntry(entry),
      navigateUp: () => void openDirectory(parentWorkspaceRelativePath(normalizedCurrentPath), true),
      closeSelection,
      createDirectory: (path: string) => void createDirectory(path),
      createFile: (path: string) => void createFile(path),
      saveSelectedFile: () => void saveSelectedFile(),
      savePreviewWindow: (id: string) => void savePreviewWindow(id),
      setPreviewWindowDraft,
      closePreviewWindow,
      focusPreviewWindow,
      moveEntry: (sourcePath: string, targetPath: string) => void moveEntry(sourcePath, targetPath),
      deleteEntry: (entry: WorkspaceEntry) => void deleteEntry(entry),
      uploadFiles: (files: FileList | File[] | WorkspaceUploadItem[]) => void uploadFiles(files),
      downloadEntry: (entry: WorkspaceEntry) => void downloadEntry(entry)
    }
  };
}

export type WorkspaceFileManagerSurfaceProps = ReturnType<typeof useWorkspaceFileManager>["fileManagerSurfaceProps"];
