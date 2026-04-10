import { useEffect, useMemo, useState } from "react";

import type {
  Workspace,
  WorkspaceEntry,
  WorkspaceEntryPage,
  WorkspaceFileContent
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

const LARGE_TEXT_FILE_BYTES = 256 * 1024;
const BINARY_PREVIEW_BYTES = 192 * 1024;

function normalizeWorkspacePath(value: string): string {
  const rawSegments = value
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== ".");
  const segments: string[] = [];

  for (const segment of rawSegments) {
    if (segment === "..") {
      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  return segments.length > 0 ? segments.join("/") : ".";
}

function joinWorkspacePath(basePath: string, childPath: string): string {
  return normalizeWorkspacePath(basePath === "." ? childPath : `${basePath}/${childPath}`);
}

function parentWorkspacePath(value: string): string {
  const normalized = normalizeWorkspacePath(value);
  if (normalized === ".") {
    return ".";
  }

  const segments = normalized.split("/");
  return segments.length > 1 ? segments.slice(0, -1).join("/") : ".";
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
  const [fileBusy, setFileBusy] = useState(false);
  const [mutationBusy, setMutationBusy] = useState(false);

  const workspaceIdValue = params.workspaceId.trim();
  const workspaceReadOnly = params.workspace?.readOnly ?? false;
  const entries = entryPage?.items ?? [];
  const nextCursor = entryPage?.nextCursor;
  const selectedFileEditable =
    !workspaceReadOnly &&
    selectedEntry?.type === "file" &&
    selectedFile?.encoding === "utf8" &&
    !selectedFile.truncated &&
    !selectedFile.readOnly &&
    isTextEntry(selectedEntry);
  const selectedFileDirty = selectedFileEditable && selectedFile !== null && selectedFileDraft !== selectedFile.content;
  const breadcrumbs = useMemo(() => {
    const normalized = normalizeWorkspacePath(currentPath);
    if (normalized === ".") {
      return [{ label: "workspace", path: "." }];
    }

    const segments = normalized.split("/");
    return [
      { label: "workspace", path: "." },
      ...segments.map((segment, index) => ({
        label: segment,
        path: segments.slice(0, index + 1).join("/")
      }))
    ];
  }, [currentPath]);

  async function refreshEntries(options?: {
    path?: string;
    cursor?: string;
    append?: boolean;
    quiet?: boolean;
  }): Promise<WorkspaceEntryPage | null> {
    if (!workspaceIdValue) {
      setEntryPage(null);
      return null;
    }

    const targetPath = normalizeWorkspacePath(options?.path ?? currentPath);
    const query = new URLSearchParams({
      path: targetPath,
      pageSize: "100",
      sortBy: "name",
      sortOrder: "asc"
    });
    if (options?.cursor) {
      query.set("cursor", options.cursor);
    }

    try {
      setEntriesBusy(true);
      const response = await params.request<WorkspaceEntryPage>(
        `/api/v1/workspaces/${workspaceIdValue}/entries?${query.toString()}`
      );
      setCurrentPath(targetPath);
      setEntryPage((current) =>
        options?.append && current?.path === response.path
          ? {
              ...response,
              items: [...current.items, ...response.items]
            }
          : response
      );
      if (!options?.quiet) {
        params.setActivity(`已加载 ${response.path === "." ? "workspace 根目录" : response.path}`);
        params.setErrorMessage("");
      }
      return response;
    } catch (error) {
      if (!options?.quiet) {
        params.setErrorMessage(toErrorMessage(error));
      }
      return null;
    } finally {
      setEntriesBusy(false);
    }
  }

  async function focusEntry(entry: WorkspaceEntry, quiet = false): Promise<void> {
    setSelectedEntry(entry);
    if (entry.type === "directory") {
      setSelectedFile(null);
      setSelectedFileDraft("");
      return;
    }

    const query = new URLSearchParams({
      path: entry.path,
      encoding: isTextEntry(entry) ? "utf8" : "base64"
    });

    if (!isTextEntry(entry) || (entry.sizeBytes ?? 0) > LARGE_TEXT_FILE_BYTES) {
      query.set("maxBytes", String(BINARY_PREVIEW_BYTES));
    }

    try {
      setFileBusy(true);
      const response = await params.request<WorkspaceFileContent>(
        `/api/v1/workspaces/${workspaceIdValue}/files/content?${query.toString()}`
      );
      setSelectedFile(response);
      setSelectedFileDraft(response.encoding === "utf8" ? response.content : "");
      if (!quiet) {
        params.setActivity(`已打开 ${entry.name}`);
        params.setErrorMessage("");
      }
    } catch (error) {
      setSelectedFile(null);
      setSelectedFileDraft("");
      if (!quiet) {
        params.setErrorMessage(toErrorMessage(error));
      }
    } finally {
      setFileBusy(false);
    }
  }

  async function openDirectory(path: string, quiet = false): Promise<void> {
    setSelectedEntry(null);
    setSelectedFile(null);
    setSelectedFileDraft("");
    await refreshEntries({ path, quiet });
  }

  async function createDirectory(path: string): Promise<void> {
    if (!workspaceIdValue || workspaceReadOnly) {
      return;
    }

    const targetPath = normalizeWorkspacePath(path);
    try {
      setMutationBusy(true);
      const entry = await params.request<WorkspaceEntry>(`/api/v1/workspaces/${workspaceIdValue}/directories`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          path: targetPath,
          createParents: true
        })
      });
      await refreshEntries({ path: parentWorkspacePath(entry.path), quiet: true });
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

    const targetPath = normalizeWorkspacePath(path);
    try {
      setMutationBusy(true);
      const entry = await params.request<WorkspaceEntry>(`/api/v1/workspaces/${workspaceIdValue}/files/content`, {
        method: "PUT",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          path: targetPath,
          content: "",
          encoding: "utf8",
          overwrite: true
        })
      });
      await refreshEntries({ path: parentWorkspacePath(entry.path), quiet: true });
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
      const entry = await params.request<WorkspaceEntry>(`/api/v1/workspaces/${workspaceIdValue}/files/content`, {
        method: "PUT",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          path: selectedEntry.path,
          content: selectedFileDraft,
          encoding: "utf8",
          overwrite: true,
          ...(selectedFile?.etag ? { ifMatch: selectedFile.etag } : {})
        })
      });
      await refreshEntries({ path: parentWorkspacePath(entry.path), quiet: true });
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

    const normalizedSourcePath = normalizeWorkspacePath(sourcePath);
    const normalizedTargetPath = normalizeWorkspacePath(targetPath);

    try {
      setMutationBusy(true);
      const entry = await params.request<WorkspaceEntry>(`/api/v1/workspaces/${workspaceIdValue}/entries/move`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          sourcePath: normalizedSourcePath,
          targetPath: normalizedTargetPath,
          overwrite: false
        })
      });
      const targetDirectory = parentWorkspacePath(entry.path);
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

    const query = new URLSearchParams({
      path: entry.path
    });
    if (entry.type === "directory") {
      query.set("recursive", "true");
    }

    try {
      setMutationBusy(true);
      await params.request(`/api/v1/workspaces/${workspaceIdValue}/entries?${query.toString()}`, {
        method: "DELETE"
      });
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

  async function uploadFiles(files: FileList | File[]): Promise<void> {
    if (!workspaceIdValue || workspaceReadOnly) {
      return;
    }

    const normalizedFiles = Array.from(files);
    if (normalizedFiles.length === 0) {
      return;
    }

    try {
      setMutationBusy(true);
      for (const file of normalizedFiles) {
        const targetPath = joinWorkspacePath(currentPath, file.name);
        const query = new URLSearchParams({
          path: targetPath,
          overwrite: "true"
        });
        const response = await fetch(
          buildUrl(params.connection.baseUrl, `/api/v1/workspaces/${workspaceIdValue}/files/upload?${query.toString()}`),
          {
            method: "PUT",
            headers: buildAuthHeaders(params.connection, {
              "content-type": "application/octet-stream"
            }),
            body: file
          }
        );
        if (!response.ok) {
          throw await createHttpRequestError(response);
        }
      }
      await refreshEntries({ path: currentPath, quiet: true });
      params.setActivity(
        normalizedFiles.length === 1 ? `已上传 ${normalizedFiles[0]?.name ?? "1 个文件"}` : `已上传 ${normalizedFiles.length} 个文件`
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

    const query = new URLSearchParams({
      path: entry.path
    });

    try {
      setMutationBusy(true);
      const response = await fetch(
        buildUrl(params.connection.baseUrl, `/api/v1/workspaces/${workspaceIdValue}/files/download?${query.toString()}`),
        {
          method: "GET",
          headers: buildAuthHeaders(params.connection)
        }
      );
      if (!response.ok) {
        throw await createHttpRequestError(response);
      }

      const blob = await response.blob();
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
    if (!params.enabled || !open || !workspaceIdValue) {
      return;
    }

    if (entryPage?.workspaceId === workspaceIdValue && entryPage.path === currentPath) {
      return;
    }

    void refreshEntries({ path: currentPath, quiet: true });
  }, [params.enabled, open, workspaceIdValue, currentPath]);

  return {
    fileManagerSurfaceProps: {
      open,
      setOpen,
      workspaceId: workspaceIdValue,
      workspaceName: params.workspace?.name ?? "",
      workspaceReadOnly,
      currentPath,
      breadcrumbs,
      entries,
      nextCursor,
      entriesBusy,
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
      loadMoreEntries: () =>
        void refreshEntries({
          path: currentPath,
          ...(nextCursor ? { cursor: nextCursor } : {}),
          append: true,
          quiet: true
        }),
      focusEntry: (entry: WorkspaceEntry) => void focusEntry(entry),
      navigateUp: () => void openDirectory(parentWorkspacePath(currentPath)),
      closeSelection,
      createDirectory: (path: string) => void createDirectory(path),
      createFile: (path: string) => void createFile(path),
      saveSelectedFile: () => void saveSelectedFile(),
      moveEntry: (sourcePath: string, targetPath: string) => void moveEntry(sourcePath, targetPath),
      deleteEntry: (entry: WorkspaceEntry) => void deleteEntry(entry),
      uploadFiles: (files: FileList | File[]) => void uploadFiles(files),
      downloadEntry: (entry: WorkspaceEntry) => void downloadEntry(entry)
    }
  };
}
