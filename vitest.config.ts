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
      "@oah/model-gateway": workspacePath("./packages/model-gateway/src/index.ts"),
      "@oah/runtime-core": workspacePath("./packages/runtime-core/src/index.ts"),
      "@oah/storage-memory": workspacePath("./packages/storage-memory/src/index.ts"),
      "@oah/storage-postgres": workspacePath("./packages/storage-postgres/src/index.ts"),
      "@oah/storage-redis": workspacePath("./packages/storage-redis/src/index.ts")
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"]
  }
});
