import type { StorageAdmin } from "../storage-admin.js";

export interface RuntimeAdminCapabilities {
  storageAdmin: StorageAdmin;
  close(): Promise<void>;
}

export function createRuntimeAdminCapabilities(input: {
  storageAdmin: StorageAdmin;
}): RuntimeAdminCapabilities {
  return {
    storageAdmin: input.storageAdmin,
    close() {
      return input.storageAdmin.close();
    }
  };
}
