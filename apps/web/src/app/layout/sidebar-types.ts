import type { Dispatch, SetStateAction } from "react";

import type { Run, SystemProfile } from "@oah/api-contracts";
import type { PlatformAssetDetail, PlatformAssetKind, PlatformAssetList } from "@oah/api-contracts";

import type { SavedSessionRecord, SavedWorkspaceRecord, WorkspaceDraft } from "../support";
import type { AppThemeName } from "../theme";
import type { StorageSurfaceProps } from "../use-storage-controller";

type SidebarStorageProps = Pick<
  StorageSurfaceProps,
  | "storageOverview"
  | "storageRedisEnabled"
  | "storageBrowserTab"
  | "onStorageBrowserTabChange"
  | "onRefreshStorageOverview"
  | "selectedStorageTable"
  | "onSelectStorageTable"
  | "storageTableSearch"
  | "onStorageTableSearchChange"
  | "storageTableWorkspaceId"
  | "onStorageTableWorkspaceIdChange"
  | "storageTableSessionId"
  | "onStorageTableSessionIdChange"
  | "storageTableRunId"
  | "onStorageTableRunIdChange"
  | "storageTableStatus"
  | "onStorageTableStatusChange"
  | "storageTableErrorCode"
  | "onStorageTableErrorCodeChange"
  | "storageTableRecoveryState"
  | "onStorageTableRecoveryStateChange"
  | "onRefreshStorageTable"
  | "onClearStorageTableFilters"
  | "redisKeyPattern"
  | "onRedisKeyPatternChange"
  | "redisKeyPage"
  | "selectedRedisKey"
  | "onSelectRedisKey"
  | "onRefreshRedisKeys"
  | "storageBusy"
>;

type SidebarProps = SidebarStorageProps & {
  serviceScope: string;
  serviceScopeOptions: Array<{ value: string; label: string }>;
  systemProfile: SystemProfile | null;
  selectedServiceScopeLabel: string;
  workspaceRuntimeFilterOptions: string[];
  filteredSavedWorkspaces: SavedWorkspaceRecord[];
  orderedSavedWorkspaces: SavedWorkspaceRecord[];
  savedSessionsCount: number;
  totalSavedSessionsCount: number;
  workspaceIndexLoading: boolean;
  workspaceSessionLoadingIds: string[];
  workspaceManagementEnabled: boolean;
  showWorkspaceCreator: boolean;
  setShowWorkspaceCreator: Dispatch<SetStateAction<boolean>>;
  activeWorkspaceId: string;
  expandWorkspaceInSidebar: (workspaceId: string) => void;
  workspaceDraft: WorkspaceDraft;
  setWorkspaceDraft: Dispatch<SetStateAction<WorkspaceDraft>>;
  workspaceRuntimes: string[];
  platformAssets: Record<PlatformAssetKind, PlatformAssetList>;
  platformAssetLoading: Record<PlatformAssetKind, boolean>;
  createWorkspace: () => Promise<void> | void;
  refreshWorkspaceRuntimes: (quiet?: boolean) => Promise<void> | void;
  refreshPlatformAssets: (kind?: PlatformAssetKind, quiet?: boolean) => Promise<void> | void;
  getPlatformAssetDetail: (kind: PlatformAssetKind, name: string) => Promise<PlatformAssetDetail | null>;
  uploadPlatformRuntimeAsset: (file: File, name: string, overwrite: boolean) => Promise<boolean>;
  updatePlatformRuntimeAsset: (name: string, file: File) => Promise<boolean>;
  deletePlatformRuntimeAsset: (name: string) => Promise<boolean>;
  uploadPlatformModelAsset: (name: string, yaml: string, overwrite: boolean) => Promise<boolean>;
  updatePlatformModelAsset: (name: string, yaml: string) => Promise<boolean>;
  deletePlatformModelAsset: (name: string) => Promise<boolean>;
  uploadPlatformToolAsset: (name: string, definition: Record<string, unknown>, serverFiles: Record<string, string>, overwrite: boolean) => Promise<boolean>;
  updatePlatformToolAsset: (name: string, definition: Record<string, unknown>, serverFiles: Record<string, string>) => Promise<boolean>;
  deletePlatformToolAsset: (name: string) => Promise<boolean>;
  uploadPlatformSkillAsset: (name: string, skillMarkdown: string, files: Record<string, string>, overwrite: boolean) => Promise<boolean>;
  updatePlatformSkillAsset: (name: string, skillMarkdown: string, files: Record<string, string>) => Promise<boolean>;
  deletePlatformSkillAsset: (name: string) => Promise<boolean>;
  refreshWorkspaceIndex: (quiet?: boolean) => Promise<void> | void;
  createSession: () => Promise<void> | void;
  sessionId: string;
  sessionRuns: Run[];
  refreshSessionById: (sessionId: string, quiet?: boolean) => Promise<unknown> | void;
  removeSavedSession: (sessionId: string) => Promise<void> | void;
  renameSession: (sessionId: string, title: string) => Promise<void> | void;
  sessionsByWorkspaceId: Map<string, SavedSessionRecord[]>;
  expandedWorkspaceIds: string[];
  expandedSessionIds: string[];
  openWorkspace: (workspaceId: string, quiet?: boolean) => Promise<unknown> | void;
  toggleWorkspaceExpansion: (workspaceId: string) => void;
  toggleSessionExpansion: (sessionId: string) => void;
  deleteWorkspace: (workspaceId: string) => Promise<void> | void;
  deleteWorkspacesForRuntime: (runtimeName: string, workspaceIds: string[]) => Promise<boolean>;
  storageInspectionEnabled: boolean;
  pingHealth: () => Promise<void> | void;
  refreshModelProviders: () => Promise<void> | void;
  refreshPlatformModels: () => Promise<void> | void;
  modelProviders: unknown[];
  theme: AppThemeName;
  onThemeChange: (theme: AppThemeName) => void;
};

export type { SidebarProps };
