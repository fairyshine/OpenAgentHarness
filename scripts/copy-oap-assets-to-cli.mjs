import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repoRoot, "template", "deploy-root");
const targetRoot = path.join(repoRoot, "apps", "cli", "dist", "assets", "deploy-root");

await rm(targetRoot, { recursive: true, force: true });
await copyDeployRootAssets(sourceRoot, targetRoot);

console.log(`Copied OAP deploy-root assets to ${path.relative(repoRoot, targetRoot)}`);

async function copyDeployRootAssets(sourceDirectory, targetDirectory) {
  await mkdir(targetDirectory, { recursive: true });
  const entries = await readdir(sourceDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "README.md") {
      continue;
    }
    const sourcePath = path.join(sourceDirectory, entry.name);
    const targetPath = path.join(targetDirectory, entry.name);
    if (entry.isDirectory()) {
      await copyDeployRootAssets(sourcePath, targetPath);
      continue;
    }
    await cp(sourcePath, targetPath, { preserveTimestamps: true });
  }
}
