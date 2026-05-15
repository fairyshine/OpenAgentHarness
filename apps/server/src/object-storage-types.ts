import type { ServerConfig } from "@oah/config";
import type { NativeWorkspaceSyncObjectStoreConfig } from "@oah/native-bridge";

export type ManagedPathKey = "workspace" | "runtime" | "model" | "tool" | "skill";

export type ObjectStorageConfig = NonNullable<ServerConfig["object_storage"]> & {
  managed_paths?: ManagedPathKey[] | undefined;
};

export interface ObjectStorageEntry {
  key: string;
  size: number;
  lastModified?: Date | undefined;
}

export interface ObjectStorageDirectoryEntry {
  name: string;
  kind: "file" | "directory";
  size?: number | undefined;
  lastModified?: Date | undefined;
}

export interface LocalDirectorySnapshot {
  files: Map<string, { absolutePath: string; size: number; mtimeMs: number }>;
  emptyDirectories: Set<string>;
}

export interface DirectorySyncOptions {
  excludeRelativePath?: ((relativePath: string) => boolean) | undefined;
  preserveTopLevelNames?: string[] | undefined;
}

export interface DirectoryObjectStore {
  listEntries(prefix: string): Promise<ObjectStorageEntry[]>;
  listEntriesPaged?(prefix: string): AsyncIterable<ObjectStorageEntry[]>;
  listDirectoryEntries?(prefix: string, directory: string): Promise<ObjectStorageDirectoryEntry[]>;
  getObjectInfo?(
    key: string
  ): Promise<{ size?: number | undefined; lastModified?: Date | undefined; metadata?: Record<string, string> | undefined }>;
  getObject(key: string): Promise<{ body: Buffer; metadata?: Record<string, string> | undefined }>;
  getObjectStream?(key: string): Promise<{ body: NodeJS.ReadableStream; metadata?: Record<string, string> | undefined }>;
  getObjectToFile?(key: string, targetPath: string): Promise<{ metadata?: Record<string, string> | undefined }>;
  putObject(key: string, body: Buffer, options?: { mtimeMs?: number | undefined }): Promise<void>;
  putObjectFromStream?(key: string, body: NodeJS.ReadableStream, options?: { mtimeMs?: number | undefined }): Promise<void>;
  putObjectFromFile?(key: string, filePath: string, options?: { mtimeMs?: number | undefined }): Promise<void>;
  deleteObjects(keys: string[]): Promise<void>;
  deletePrefix?(prefix: string): Promise<number>;
  getNativeWorkspaceSyncConfig?(): NativeWorkspaceSyncObjectStoreConfig | undefined;
  bucket?: string | undefined;
}

export const OBJECT_MTIME_METADATA_KEY = "oah-mtime-ms";
