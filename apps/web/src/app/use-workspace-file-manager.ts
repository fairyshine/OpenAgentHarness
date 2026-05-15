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

const LARGE_TEXT_FILE_BYTES = 256 * 1024;
const BINARY_PREVIEW_BYTES = 192 * 1024;

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

export function useWorkspaceFileManager(params: {
  connection: ConnectionSettings;
  request: AppRequest;
  workspaceId: string;
  workspace: Workspace | null;
  enabled: boolean;
  setActivity: (value: string) => void;
  setErrorMessage: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [currentPath, setCurrentPath] = useState(".");
  const [entryPage, setEntryPage] = useState<WorkspaceEntryPage | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<WorkspaceEntry | null>(null);
  const [selectedFile, setSelectedFile] = useState<WorkspaceFileContent | null>(null);
  const [selectedFileDraft, setSelectedFileDraft] = useState("");
  const [entriesBusy, setEntriesBusy] = useState(false);
  const [entriesRefreshingMetadata, setEntriesRefreshingMetadata] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [mutationBusy, setMutationBusy] = useState(false);
  const previousOpenRef = useRef(false);
  const previousWorkspaceIdRef = useRef(params.workspaceId.trim());
  const entriesRequestSeqRef = useRef(0);
  const fileRequestSeqRef = useRef(0);

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

  const selectedFileEditable =
    !workspaceReadOnly &&
    selectedEntry?.type === "file" &&
    selectedFile?.encoding === "utf8" &&
    !selectedFile.truncated &&
    !selectedFile.readOnly &&
    isTextEntry(selectedEntry);
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
    if (!workspaceIdValue) {
      setEntryPage(null);
      return null;
    }

    const targetPath = normalizeWorkspaceRelativePath(options?.path ?? currentPath);

    try {
      setEntriesBusy(true);
      const initialResponse = toWorkspaceEntryPage(
        await sandboxClient.listEntries(workspaceIdValue, {
          path: workspaceRelativePathToSandboxPath(targetPath),
          pageSize: 200,
          sortBy: "name",
          sortOrder: "asc",
          includeDirectoryDescendantUpdatedAt: false,
          includeEntryMetadata: false
        } satisfies WorkspaceEntriesQuery)
      );
      if (entriesRequestSeqRef.current !== requestSeq) {
        return null;
      }

      const initialPage = {
        ...initialResponse,
        path: normalizeWorkspaceRelativePath(initialResponse.path)
      };
      setCurrentPath(initialPage.path);
      setEntryPage(initialPage);
      if (!options?.quiet) {
        const responsePath = normalizeWorkspaceRelativePath(initialPage.path);
        params.setActivity(
          `已加载 ${responsePath === "." ? "workspace 根目录" : responsePath}（${initialPage.items.length}${initialResponse.nextCursor ? "+" : ""} 项）`
        );
        params.setErrorMessage("");
      }

      const pages: WorkspaceEntryPage[] = [initialPage];
      let cursor = initialResponse.nextCursor;

      while (cursor) {
        const page = toWorkspaceEntryPage(
          await sandboxClient.listEntries(workspaceIdValue, {
            path: workspaceRelativePathToSandboxPath(targetPath),
            pageSize: 200,
            sortBy: "name",
            sortOrder: "asc",
            cursor,
            includeDirectoryDescendantUpdatedAt: false,
            includeEntryMetadata: false
          } satisfies WorkspaceEntriesQuery)
        );
        if (entriesRequestSeqRef.current !== requestSeq) {
          return null;
        }

        pages.push(page);
        const mergedPage = mergeWorkspaceEntries(pages);
        if (mergedPage) {
          setEntryPage({
            ...mergedPage,
            path: normalizeWorkspaceRelativePath(mergedPage.path)
          });
        }
        cursor = page.nextCursor;
      }

      const response = mergeWorkspaceEntries(pages);
      if (!response) {
        setEntryPage(null);
        return null;
      }

      setCurrentPath(normalizeWorkspaceRelativePath(response.path));
      setEntryPage({
        ...response,
        path: normalizeWorkspaceRelativePath(response.path)
      });
      if (!options?.quiet) {
        const responsePath = normalizeWorkspaceRelativePath(response.path);
        params.setActivity(`已加载 ${responsePath === "." ? "workspace 根目录" : responsePath}（${response.items.length} 项）`);
        params.setErrorMessage("");
      }
      void refreshEntryMetadata({
        path: targetPath,
        expectedRequestSeq: requestSeq,
        quiet: options?.quiet
      });
      return response;
    } catch (error) {
      if (entriesRequestSeqRef.current === requestSeq && !options?.quiet) {
        params.setErrorMessage(toErrorMessage(error));
      }
      return null;
    } finally {
      if (entriesRequestSeqRef.current === requestSeq) {
        setEntriesBusy(false);
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
    try {
      setEntriesRefreshingMetadata(true);
      const initialResponse = toWorkspaceEntryPage(
        await sandboxClient.listEntries(workspaceIdValue, {
          path: workspaceRelativePathToSandboxPath(targetPath),
          pageSize: 200,
          sortBy: "name",
          sortOrder: "asc"
        } satisfies WorkspaceEntriesQuery)
      );
      if (entriesRequestSeqRef.current !== options.expectedRequestSeq) {
        return;
      }

      const pages: WorkspaceEntryPage[] = [
        {
          ...initialResponse,
          path: normalizeWorkspaceRelativePath(initialResponse.path)
        }
      ];
      let cursor = initialResponse.nextCursor;

      while (cursor) {
        const page = toWorkspaceEntryPage(
          await sandboxClient.listEntries(workspaceIdValue, {
            path: workspaceRelativePathToSandboxPath(targetPath),
            pageSize: 200,
            sortBy: "name",
            sortOrder: "asc",
            cursor
          } satisfies WorkspaceEntriesQuery)
        );
        if (entriesRequestSeqRef.current !== options.expectedRequestSeq) {
          return;
        }

        pages.push(page);
        cursor = page.nextCursor;
      }

      const response = mergeWorkspaceEntries(pages);
      if (!response || entriesRequestSeqRef.current !== options.expectedRequestSeq) {
        return;
      }

      setEntryPage((current) => {
        if (!current || normalizeWorkspaceRelativePath(current.path) !== normalizeWorkspaceRelativePath(response.path)) {
          return current;
        }

        return {
          ...response,
          path: normalizeWorkspaceRelativePath(response.path)
        };
      });
    } catch (error) {
      if (entriesRequestSeqRef.current === options.expectedRequestSeq && !options.quiet) {
        params.setErrorMessage(toErrorMessage(error));
      }
    } finally {
      if (entriesRequestSeqRef.current === options.expectedRequestSeq) {
        setEntriesRefreshingMetadata(false);
      }
    }
  }

  async function focusEntry(entry: WorkspaceEntry, quiet = false): Promise<void> {
    const requestSeq = fileRequestSeqRef.current + 1;
    fileRequestSeqRef.current = requestSeq;
    setSelectedEntry(entry);
    if (entry.type === "directory") {
      setSelectedFile(null);
      setSelectedFileDraft("");
      setFileBusy(false);
      return;
    }

    try {
      setFileBusy(true);
      const response = toWorkspaceFileContent(
        await sandboxClient.getFileContent(workspaceIdValue, {
          path: workspaceRelativePathToSandboxPath(entry.path),
          encoding: isTextEntry(entry) ? "utf8" : "base64",
          ...(!isTextEntry(entry) || (entry.sizeBytes ?? 0) > LARGE_TEXT_FILE_BYTES ? { maxBytes: BINARY_PREVIEW_BYTES } : {})
        } satisfies WorkspaceFileContentQuery)
      );
      if (fileRequestSeqRef.current !== requestSeq) {
        return;
      }

      setSelectedFile(response);
      setSelectedFileDraft(response.encoding === "utf8" ? response.content : "");
      if (!quiet) {
        params.setActivity(`已打开 ${entry.name}`);
        params.setErrorMessage("");
      }
    } catch (error) {
      if (fileRequestSeqRef.current !== requestSeq) {
        return;
      }

      setSelectedFile(null);
      setSelectedFileDraft("");
      if (!quiet) {
        params.setErrorMessage(toErrorMessage(error));
      }
    } finally {
      if (fileRequestSeqRef.current === requestSeq) {
        setFileBusy(false);
      }
    }
  }

  async function openDirectory(path: string, quiet = false): Promise<void> {
    setSelectedEntry(null);
    setSelectedFile(null);
    setSelectedFileDraft("");
    await refreshEntries({ path: normalizeWorkspaceRelativePath(path), quiet });
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

    try {
      setMutationBusy(true);
      const entry = toWorkspaceEntry(
        await sandboxClient.putFileContent(workspaceIdValue, {
          path: workspaceRelativePathToSandboxPath(selectedEntry.path),
          content: selectedFileDraft,
          encoding: "utf8",
          overwrite: true,
          ...(selectedFile?.etag ? { ifMatch: selectedFile.etag } : {})
        } satisfies PutWorkspaceFileRequest)
      );
      await refreshEntries({ path: parentWorkspaceRelativePath(entry.path), quiet: true });
      await focusEntry(entry, true);
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
      await refreshEntries({ path: currentPath, quiet: true });
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

  useEffect(() => {
    setCurrentPath(".");
    setEntryPage(null);
    closeSelection();
  }, [workspaceIdValue]);

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
      entriesRefreshingMetadata,
      fileBusy,
      mutationBusy,
      selectedEntry,
      selectedFile,
      selectedFileDraft,
      setSelectedFileDraft,
      selectedFileEditable,
      selectedFileDirty,
      canManageFiles: Boolean(workspaceIdValue),
      openDirectory: (path: string) => void openDirectory(path),
      refreshEntries: () => void refreshEntries(),
      focusEntry: (entry: WorkspaceEntry) => void focusEntry(entry),
      navigateUp: () => void openDirectory(parentWorkspaceRelativePath(normalizedCurrentPath)),
      closeSelection,
      createDirectory: (path: string) => void createDirectory(path),
      createFile: (path: string) => void createFile(path),
      saveSelectedFile: () => void saveSelectedFile(),
      moveEntry: (sourcePath: string, targetPath: string) => void moveEntry(sourcePath, targetPath),
      deleteEntry: (entry: WorkspaceEntry) => void deleteEntry(entry),
      uploadFiles: (files: FileList | File[] | WorkspaceUploadItem[]) => void uploadFiles(files),
      downloadEntry: (entry: WorkspaceEntry) => void downloadEntry(entry)
    }
  };
}
