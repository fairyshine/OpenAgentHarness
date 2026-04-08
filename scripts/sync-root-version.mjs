import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const checkOnly = process.argv.includes("--check");

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function getWorkspacePackageJsonPaths() {
  const workspacePath = path.join(repoRoot, "pnpm-workspace.yaml");
  const workspaceContent = await readFile(workspacePath, "utf8");
  const patterns = workspaceContent
    .split("\n")
    .map((line) => line.match(/^\s*-\s+(.+?)\s*$/)?.[1])
    .filter(Boolean);

  const packageJsonPaths = [];

  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) {
      throw new Error(`Unsupported workspace pattern: ${pattern}`);
    }

    const parentDir = path.join(repoRoot, pattern.slice(0, -2));
    const entries = await readdir(parentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      packageJsonPaths.push(path.join(parentDir, entry.name, "package.json"));
    }
  }

  return packageJsonPaths.sort();
}

async function syncWorkspacePackageVersion(filePath, rootVersion) {
  const packageJson = await readJson(filePath);
  const currentVersion = packageJson.version;

  if (currentVersion === rootVersion) {
    return null;
  }

  if (checkOnly) {
    return { filePath, currentVersion };
  }

  packageJson.version = rootVersion;
  await writeFile(filePath, formatJson(packageJson));
  return { filePath, currentVersion };
}

async function syncOpenApiVersion(rootVersion) {
  const openApiPath = path.join(repoRoot, "docs", "openapi", "openapi.yaml");
  const content = await readFile(openApiPath, "utf8");
  const match = content.match(/^(\s*version:\s*)(.+)$/m);

  if (!match) {
    throw new Error(`Unable to find OpenAPI version in ${openApiPath}`);
  }

  const currentVersion = match[2].trim();

  if (currentVersion === rootVersion) {
    return null;
  }

  if (checkOnly) {
    return { filePath: openApiPath, currentVersion };
  }

  const nextContent = content.replace(/^(\s*version:\s*)(.+)$/m, `$1${rootVersion}`);
  await writeFile(openApiPath, nextContent);
  return { filePath: openApiPath, currentVersion };
}

async function main() {
  const rootPackagePath = path.join(repoRoot, "package.json");
  const rootPackageJson = await readJson(rootPackagePath);
  const rootVersion = rootPackageJson.version;

  if (typeof rootVersion !== "string" || rootVersion.trim() === "") {
    throw new Error("Root package.json must define a non-empty version string.");
  }

  const workspacePackageJsonPaths = await getWorkspacePackageJsonPaths();
  const results = await Promise.all(
    workspacePackageJsonPaths.map((filePath) => syncWorkspacePackageVersion(filePath, rootVersion))
  );
  results.push(await syncOpenApiVersion(rootVersion));

  const mismatches = results.filter(Boolean);

  if (checkOnly) {
    if (mismatches.length > 0) {
      for (const mismatch of mismatches) {
        console.error(`${path.relative(repoRoot, mismatch.filePath)}: ${mismatch.currentVersion} -> ${rootVersion}`);
      }

      process.exitCode = 1;
      return;
    }

    console.log(`All workspace package versions match root version ${rootVersion}.`);
    return;
  }

  if (mismatches.length === 0) {
    console.log(`All workspace package versions already match root version ${rootVersion}.`);
    return;
  }

  for (const mismatch of mismatches) {
    console.log(`Updated ${path.relative(repoRoot, mismatch.filePath)}: ${mismatch.currentVersion} -> ${rootVersion}`);
  }
}

await main();
