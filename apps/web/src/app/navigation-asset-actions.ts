import { startTransition } from "react";

import type {
  PlatformAssetDetail,
  PlatformAssetKind,
  PlatformAssetList,
  WorkspaceRuntimeList
} from "@oah/api-contracts";

import {
  buildAuthHeaders,
  buildUrl,
  createHttpRequestError,
  isNotFoundError,
  toErrorMessage
} from "./support";
import type { NavigationActionParams } from "./navigation-action-types";

const PLATFORM_ASSET_COLLECTIONS: Record<PlatformAssetKind, "runtimes" | "models" | "tools" | "skills"> = {
  runtime: "runtimes",
  model: "models",
  tool: "tools",
  skill: "skills"
};

export function createNavigationAssetActions(params: NavigationActionParams) {
  async function requestWorkspaceRuntimeEndpoint<T>(path: string, legacyPath: string, init?: RequestInit) {
    try {
      return await params.request<T>(path, init);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }

      return params.request<T>(legacyPath, init);
    }
  }

  async function fetchWorkspaceRuntimeEndpoint(path: string, legacyPath: string, init: RequestInit) {
    const response = await fetch(buildUrl(params.connection.baseUrl, path), init);
    if (response.status !== 404) {
      return response;
    }

    return fetch(buildUrl(params.connection.baseUrl, legacyPath), init);
  }

  async function requestPlatformAssetEndpoint<T>(kind: PlatformAssetKind) {
    const collection = PLATFORM_ASSET_COLLECTIONS[kind];
    if (kind === "runtime") {
      const response = await requestWorkspaceRuntimeEndpoint<WorkspaceRuntimeList>("/api/v1/runtimes", "/api/v1/blueprints");
      return { kind: "runtime", items: response.items } as T;
    }

    try {
      return await params.request<T>(`/api/v1/assets/${collection}`);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }

      try {
        return await params.request<T>(`/api/v1/platform-assets/${collection}`);
      } catch (fallbackError) {
        if (!isNotFoundError(fallbackError)) {
          throw fallbackError;
        }
        return { kind, items: [] } as T;
      }
    }
  }

  async function fetchPlatformAssetEndpoint(kind: PlatformAssetKind, path: string, init: RequestInit) {
    if (kind === "runtime") {
      const runtimePath = path.replace(/^runtimes/u, "runtimes");
      const legacyPath = runtimePath.replace(/^runtimes/u, "blueprints");
      return fetchWorkspaceRuntimeEndpoint(`/api/v1/${runtimePath}`, `/api/v1/${legacyPath}`, init);
    }

    const assetsResponse = await fetch(buildUrl(params.connection.baseUrl, `/api/v1/assets/${path}`), init);
    if (assetsResponse.status !== 404) {
      return assetsResponse;
    }

    return fetch(buildUrl(params.connection.baseUrl, `/api/v1/platform-assets/${path}`), init);
  }

  async function refreshWorkspaceRuntimes(quiet = false) {
    try {
      const response = await requestWorkspaceRuntimeEndpoint<WorkspaceRuntimeList>(
        "/api/v1/runtimes",
        "/api/v1/blueprints"
      );
      startTransition(() => {
        params.navigation.setWorkspaceManagementEnabled(true);
        params.navigation.setWorkspaceRuntimes(response.items.map((item) => item.name));
        params.navigation.setPlatformAssets((current) => ({
          ...current,
          runtime: { kind: "runtime", items: response.items }
        }));
      });
      if (!quiet) {
        params.setActivity(`已加载 ${response.items.length} 个运行时`);
        params.setErrorMessage("");
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("workspace_runtimes_unavailable") ||
          error.message.includes("workspace_blueprints_unavailable") ||
          error.message.toLowerCase().includes("workspace runtimes are not available") ||
          error.message.toLowerCase().includes("workspace blueprints are not available"))
      ) {
        startTransition(() => {
          params.navigation.setWorkspaceManagementEnabled(false);
          params.navigation.setWorkspaceRuntimes([]);
        });
        if (!quiet) {
          params.setErrorMessage("");
        }
        return;
      }

      if (!quiet) {
        params.setErrorMessage(toErrorMessage(error));
      }
    }
  }

  async function uploadWorkspaceRuntime(file: File, name: string, overwrite: boolean): Promise<boolean> {
    try {
      const query = new URLSearchParams({ name });
      if (overwrite) {
        query.set("overwrite", "true");
      }
      const response = await fetchWorkspaceRuntimeEndpoint(
        `/api/v1/runtimes/upload?${query.toString()}`,
        `/api/v1/blueprints/upload?${query.toString()}`,
        {
          method: "POST",
          headers: buildAuthHeaders(params.connection, { "content-type": "application/octet-stream" }),
          body: file
        }
      );
      if (!response.ok) {
        throw await createHttpRequestError(response);
      }
      await refreshWorkspaceRuntimes(true);
      params.setActivity(`运行时 "${name}" 上传成功`);
      params.setErrorMessage("");
      return true;
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
      return false;
    }
  }

  async function deleteWorkspaceRuntime(runtimeName: string): Promise<boolean> {
    try {
      const encodedRuntimeName = encodeURIComponent(runtimeName);
      const response = await fetchWorkspaceRuntimeEndpoint(
        `/api/v1/runtimes/${encodedRuntimeName}`,
        `/api/v1/blueprints/${encodedRuntimeName}`,
        {
          method: "DELETE",
          headers: buildAuthHeaders(params.connection)
        }
      );
      if (!response.ok) {
        throw await createHttpRequestError(response);
      }
      await refreshWorkspaceRuntimes(true);
      params.setActivity(`运行时 "${runtimeName}" 已删除`);
      params.setErrorMessage("");
      return true;
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
      return false;
    }
  }

  async function updateWorkspaceRuntime(runtimeName: string, file: File): Promise<boolean> {
    try {
      const normalizedRuntimeName = runtimeName.trim();
      if (!normalizedRuntimeName) {
        params.setErrorMessage("请先选择一个 runtime。");
        return false;
      }

      const encodedRuntimeName = encodeURIComponent(normalizedRuntimeName);
      const response = await fetchWorkspaceRuntimeEndpoint(
        `/api/v1/runtimes/${encodedRuntimeName}`,
        `/api/v1/blueprints/${encodedRuntimeName}`,
        {
          method: "PUT",
          headers: buildAuthHeaders(params.connection, { "content-type": "application/octet-stream" }),
          body: file
        }
      );
      if (!response.ok) {
        throw await createHttpRequestError(response);
      }
      await refreshWorkspaceRuntimes(true);
      params.setActivity(`运行时 "${normalizedRuntimeName}" 已更新`);
      params.setErrorMessage("");
      return true;
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
      return false;
    }
  }

  async function refreshPlatformAssets(kind?: PlatformAssetKind, quiet = false) {
    const kinds: PlatformAssetKind[] = kind ? [kind] : ["runtime", "model", "tool", "skill"];
    params.navigation.setPlatformAssetLoading((current) => {
      const next = { ...current };
      for (const assetKind of kinds) {
        next[assetKind] = true;
      }
      return next;
    });
    try {
      const lists = await Promise.all(
        kinds.map(async (assetKind) => requestPlatformAssetEndpoint<PlatformAssetList>(assetKind))
      );
      startTransition(() => {
        params.navigation.setPlatformAssets((current) => {
          const next = { ...current };
          for (const list of lists) {
            next[list.kind] = list;
          }
          return next;
        });
        const runtimeList = lists.find((list): list is Extract<PlatformAssetList, { kind: "runtime" }> => list.kind === "runtime");
        if (runtimeList) {
          params.navigation.setWorkspaceManagementEnabled(true);
          params.navigation.setWorkspaceRuntimes(runtimeList.items.map((item) => item.name));
        }
      });
      if (!quiet) {
        const count = lists.reduce((sum, list) => sum + list.items.length, 0);
        params.setActivity(`已加载 ${count} 个资产`);
        params.setErrorMessage("");
      }
    } catch (error) {
      if (!quiet) {
        params.setErrorMessage(toErrorMessage(error));
      }
    } finally {
      params.navigation.setPlatformAssetLoading((current) => {
        const next = { ...current };
        for (const assetKind of kinds) {
          next[assetKind] = false;
        }
        return next;
      });
    }
  }

  async function getPlatformAssetDetail(kind: PlatformAssetKind, name: string): Promise<PlatformAssetDetail | null> {
    if (kind === "runtime") {
      return null;
    }
    const collection = PLATFORM_ASSET_COLLECTIONS[kind];
    try {
      return await params.request<PlatformAssetDetail>(`/api/v1/assets/${collection}/${encodeURIComponent(name)}`);
    } catch (error) {
      if (!isNotFoundError(error)) {
        params.setErrorMessage(toErrorMessage(error));
        return null;
      }
      try {
        return await params.request<PlatformAssetDetail>(`/api/v1/platform-assets/${collection}/${encodeURIComponent(name)}`);
      } catch (fallbackError) {
        params.setErrorMessage(toErrorMessage(fallbackError));
        return null;
      }
    }
  }

  async function uploadPlatformModelAsset(name: string, yaml: string, overwrite: boolean): Promise<boolean> {
    try {
      const assetName = name.trim();
      const query = new URLSearchParams({ name: assetName });
      if (overwrite) {
        query.set("overwrite", "true");
      }
      const response = await fetchPlatformAssetEndpoint("model", `models/upload?${query.toString()}`, {
        method: "POST",
        headers: buildAuthHeaders(params.connection, { "content-type": "application/octet-stream" }),
        body: new Blob([yaml], { type: "application/octet-stream" })
      });
      if (!response.ok) {
        throw await createHttpRequestError(response);
      }
      await refreshPlatformAssets("model", true);
      params.setActivity(`模型资产 "${assetName}" 上传成功`);
      params.setErrorMessage("");
      return true;
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
      return false;
    }
  }

  async function uploadPlatformRuntimeAsset(file: File, name: string, overwrite: boolean): Promise<boolean> {
    try {
      const assetName = name.trim();
      const query = new URLSearchParams({ name: assetName });
      if (overwrite) {
        query.set("overwrite", "true");
      }
      const response = await fetchPlatformAssetEndpoint("runtime", `runtimes/upload?${query.toString()}`, {
        method: "POST",
        headers: buildAuthHeaders(params.connection, { "content-type": "application/octet-stream" }),
        body: file
      });
      if (!response.ok) {
        throw await createHttpRequestError(response);
      }
      await refreshPlatformAssets("runtime", true);
      params.setActivity(`运行时资产 "${assetName}" 上传成功`);
      params.setErrorMessage("");
      return true;
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
      return false;
    }
  }

  async function updatePlatformRuntimeAsset(name: string, file: File): Promise<boolean> {
    try {
      const runtimeName = name.trim();
      const response = await fetchPlatformAssetEndpoint("runtime", `runtimes/${encodeURIComponent(runtimeName)}`, {
        method: "PUT",
        headers: buildAuthHeaders(params.connection, { "content-type": "application/octet-stream" }),
        body: file
      });
      if (!response.ok) {
        throw await createHttpRequestError(response);
      }
      await refreshPlatformAssets("runtime", true);
      params.setActivity(`运行时资产 "${runtimeName}" 已更新`);
      params.setErrorMessage("");
      return true;
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
      return false;
    }
  }

  async function updatePlatformModelAsset(name: string, yaml: string): Promise<boolean> {
    try {
      const assetName = name.trim();
      const response = await fetchPlatformAssetEndpoint("model", `models/${encodeURIComponent(assetName)}`, {
        method: "PUT",
        headers: buildAuthHeaders(params.connection, { "content-type": "application/octet-stream" }),
        body: new Blob([yaml], { type: "application/octet-stream" })
      });
      if (!response.ok) {
        throw await createHttpRequestError(response);
      }
      await refreshPlatformAssets("model", true);
      params.setActivity(`模型资产 "${assetName}" 已更新`);
      params.setErrorMessage("");
      return true;
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
      return false;
    }
  }

  async function mutateJsonAsset(
    path: string,
    method: "POST" | "PUT",
    body: Record<string, unknown>,
    kind: PlatformAssetKind,
    name: string,
    doneMessage: string
  ): Promise<boolean> {
    try {
      const response = await fetchPlatformAssetEndpoint(kind, path.replace(/^\/api\/v1\/assets\//u, ""), {
        method,
        headers: buildAuthHeaders(params.connection, { "content-type": "application/json" }),
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        throw await createHttpRequestError(response);
      }
      await refreshPlatformAssets(kind, true);
      params.setActivity(doneMessage);
      params.setErrorMessage("");
      return true;
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
      return false;
    }
  }

  async function deletePlatformAsset(kind: PlatformAssetKind, name: string): Promise<boolean> {
    try {
      const assetName = name.trim();
      const response = await fetchPlatformAssetEndpoint(kind, `${PLATFORM_ASSET_COLLECTIONS[kind]}/${encodeURIComponent(assetName)}`, {
        method: "DELETE",
        headers: buildAuthHeaders(params.connection)
      });
      if (!response.ok) {
        throw await createHttpRequestError(response);
      }
      await refreshPlatformAssets(kind, true);
      params.setActivity(`资产 "${assetName}" 已删除`);
      params.setErrorMessage("");
      return true;
    } catch (error) {
      params.setErrorMessage(toErrorMessage(error));
      return false;
    }
  }

  async function uploadPlatformToolAsset(
    name: string,
    definition: Record<string, unknown>,
    serverFiles: Record<string, string>,
    overwrite: boolean
  ): Promise<boolean> {
    const assetName = name.trim();
    const query = new URLSearchParams({ name: assetName });
    if (overwrite) {
      query.set("overwrite", "true");
    }
    return mutateJsonAsset(
      `/api/v1/assets/tools/upload?${query.toString()}`,
      "POST",
      {
        definition,
        ...(Object.keys(serverFiles).length > 0 ? { serverFiles } : {})
      },
      "tool",
      assetName,
      `工具资产 "${assetName}" 上传成功`
    );
  }

  async function updatePlatformToolAsset(
    name: string,
    definition: Record<string, unknown>,
    serverFiles: Record<string, string>
  ): Promise<boolean> {
    const assetName = name.trim();
    return mutateJsonAsset(
      `/api/v1/assets/tools/${encodeURIComponent(assetName)}`,
      "PUT",
      {
        definition,
        ...(Object.keys(serverFiles).length > 0 ? { serverFiles } : {})
      },
      "tool",
      assetName,
      `工具资产 "${assetName}" 已更新`
    );
  }

  async function uploadPlatformSkillAsset(
    name: string,
    skillMarkdown: string,
    files: Record<string, string>,
    overwrite: boolean
  ): Promise<boolean> {
    const assetName = name.trim();
    const query = new URLSearchParams({ name: assetName });
    if (overwrite) {
      query.set("overwrite", "true");
    }
    return mutateJsonAsset(
      `/api/v1/assets/skills/upload?${query.toString()}`,
      "POST",
      {
        skillMarkdown,
        ...(Object.keys(files).length > 0 ? { files } : {})
      },
      "skill",
      assetName,
      `技能资产 "${assetName}" 上传成功`
    );
  }

  async function updatePlatformSkillAsset(name: string, skillMarkdown: string, files: Record<string, string>): Promise<boolean> {
    const assetName = name.trim();
    return mutateJsonAsset(
      `/api/v1/assets/skills/${encodeURIComponent(assetName)}`,
      "PUT",
      {
        skillMarkdown,
        ...(Object.keys(files).length > 0 ? { files } : {})
      },
      "skill",
      assetName,
      `技能资产 "${assetName}" 已更新`
    );
  }


  return {
    refreshWorkspaceRuntimes,
    uploadWorkspaceRuntime,
    updateWorkspaceRuntime,
    deleteWorkspaceRuntime,
    refreshPlatformAssets,
    getPlatformAssetDetail,
    uploadPlatformRuntimeAsset,
    updatePlatformRuntimeAsset,
    uploadPlatformModelAsset,
    updatePlatformModelAsset,
    uploadPlatformToolAsset,
    updatePlatformToolAsset,
    uploadPlatformSkillAsset,
    updatePlatformSkillAsset,
    deletePlatformAsset
  };
}
