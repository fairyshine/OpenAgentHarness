import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

function workspacePath(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

export default defineConfig({
  resolve: {
    alias: {
      "@oah/api-contracts": workspacePath("./packages/api-contracts/src/index.ts"),
      "@oah/config": workspacePath("./packages/config/src/index.ts"),
      "@oah/config/object-storage": workspacePath("./packages/config/src/object-storage.ts"),
      "@oah/config/platform-models": workspacePath("./packages/config/src/platform-models.ts"),
      "@oah/config/runtimes": workspacePath("./packages/config/src/runtimes.ts"),
      "@oah/config/server-config": workspacePath("./packages/config/src/server-config.ts"),
      "@oah/config/workspace": workspacePath("./packages/config/src/workspace.ts"),
      "@oah/model-runtime/providers": workspacePath("./packages/model-runtime/src/providers.ts"),
      "@oah/model-runtime": workspacePath("./packages/model-runtime/src/index.ts"),
      "@oah/native-bridge": workspacePath("./packages/native-bridge/src/index.ts"),
      "@oah/engine-core": workspacePath("./packages/engine-core/src/index.ts"),
      "@oah/storage-memory": workspacePath("./packages/storage-memory/src/index.ts"),
      "@oah/storage-sqlite": workspacePath("./packages/storage-sqlite/src/index.ts"),
      "@oah/storage-postgres": workspacePath("./packages/storage-postgres/src/index.ts"),
      "@oah/storage-redis": workspacePath("./packages/storage-redis/src/index.ts")
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"]
  }
});
