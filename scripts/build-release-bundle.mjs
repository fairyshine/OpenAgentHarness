import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const version = process.env.OAH_RELEASE_VERSION ?? packageJson.version;
const outDir = path.resolve(repoRoot, process.env.OAH_RELEASE_DIST_DIR ?? "release");
const asset = process.env.OAH_RELEASE_ASSET ?? detectAsset();
const archiveName = `oah-v${version}-${asset}.tar.gz`;
const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-release-bundle-"));

try {
  const deployRoot = path.join(tempDir, "deploy");
  const packageRoot = path.join(tempDir, "package");
  await run("pnpm", ["build"]);
  await run("pnpm", ["--filter", "@oah/cli", "deploy", "--prod", "--legacy", deployRoot], {
    npm_config_loglevel: "error"
  });

  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  await mkdir(path.join(packageRoot, "lib", "node_modules", "@oah"), { recursive: true });
  await cp(deployRoot, path.join(packageRoot, "lib", "node_modules", "@oah", "cli"), {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true
  });
  await writeVersionLauncher(packageRoot);
  await writeFile(path.join(packageRoot, "VERSION"), `${version}\n`, "utf8");

  await copyIfExists(path.join(repoRoot, "README.md"), path.join(packageRoot, "README.md"));
  await copyIfExists(path.join(repoRoot, "scripts", "install.sh"), path.join(packageRoot, "install.sh"));
  await copyNativeBinaries(packageRoot);
  if (process.env.OAH_INCLUDE_NODE === "1" || process.env.OAH_INCLUDE_NODE === "true") {
    await copyBundledNode(packageRoot);
  }

  await mkdir(outDir, { recursive: true });
  const archivePath = path.join(outDir, archiveName);
  await rm(archivePath, { force: true });
  await run("tar", ["-C", packageRoot, "-czf", archivePath, "."]);
  const checksum = await sha256File(archivePath);
  await writeFile(`${archivePath}.sha256`, `${checksum}  ${archiveName}\n`, "utf8");

  console.log(`Built ${archivePath}`);
  console.log(`Built ${archivePath}.sha256`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function detectAsset() {
  const arch = os.arch() === "x64" ? "x86_64" : os.arch() === "arm64" ? "aarch64" : os.arch();
  if (process.platform === "darwin") {
    return `macos-${arch}`;
  }
  if (process.platform === "linux") {
    return `linux-${arch}`;
  }
  if (process.platform === "win32") {
    return `windows-${arch}`;
  }
  throw new Error(`Unsupported platform: ${process.platform} ${os.arch()}`);
}

async function writeVersionLauncher(packageRoot) {
  if (process.platform === "win32") {
    const launcher = path.join(packageRoot, "bin", "oah.cmd");
    await writeFile(
      launcher,
      [
        "@echo off",
        "setlocal",
        "set OAH_VERSION_ROOT=%~dp0..",
        "if exist \"%OAH_VERSION_ROOT%\\node\\node.exe\" (",
        "  set OAH_NODE=%OAH_VERSION_ROOT%\\node\\node.exe",
        ") else (",
        "  set OAH_NODE=node",
        ")",
        "if exist \"%OAH_VERSION_ROOT%\\native\\bin\\oah-workspace-sync.exe\" set OAH_NATIVE_WORKSPACE_SYNC_BINARY=%OAH_VERSION_ROOT%\\native\\bin\\oah-workspace-sync.exe",
        "if exist \"%OAH_VERSION_ROOT%\\native\\bin\\oah-archive-export.exe\" set OAH_NATIVE_ARCHIVE_EXPORT_BINARY=%OAH_VERSION_ROOT%\\native\\bin\\oah-archive-export.exe",
        "\"%OAH_NODE%\" \"%OAH_VERSION_ROOT%\\lib\\node_modules\\@oah\\cli\\dist\\index.js\" %*",
        ""
      ].join("\r\n"),
      "utf8"
    );
    return;
  }

  const launcher = path.join(packageRoot, "bin", "oah");
  await writeFile(
    launcher,
    [
      "#!/usr/bin/env sh",
      "set -eu",
      "VERSION_ROOT=\"$(CDPATH= cd -- \"$(dirname -- \"$0\")/..\" && pwd)\"",
      "if [ -x \"$VERSION_ROOT/node/bin/node\" ]; then",
      "  NODE=\"$VERSION_ROOT/node/bin/node\"",
      "else",
      "  NODE=\"${OAH_NODE:-node}\"",
      "fi",
      "if [ -x \"$VERSION_ROOT/native/bin/oah-workspace-sync\" ]; then",
      "  export OAH_NATIVE_WORKSPACE_SYNC_BINARY=\"$VERSION_ROOT/native/bin/oah-workspace-sync\"",
      "fi",
      "if [ -x \"$VERSION_ROOT/native/bin/oah-archive-export\" ]; then",
      "  export OAH_NATIVE_ARCHIVE_EXPORT_BINARY=\"$VERSION_ROOT/native/bin/oah-archive-export\"",
      "fi",
      "exec \"$NODE\" \"$VERSION_ROOT/lib/node_modules/@oah/cli/dist/index.js\" \"$@\"",
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(launcher, 0o755);
}

async function copyNativeBinaries(packageRoot) {
  const nativeBin = path.join(repoRoot, "native", "bin");
  if (!(await exists(nativeBin))) {
    return;
  }
  await mkdir(path.join(packageRoot, "native", "bin"), { recursive: true });
  await cp(nativeBin, path.join(packageRoot, "native", "bin"), {
    recursive: true,
    preserveTimestamps: true
  });
}

async function copyBundledNode(packageRoot) {
  const nodeVersion = process.env.OAH_BUNDLED_NODE_VERSION ?? process.version;
  const nodeAsset = nodeDistributionAsset();
  const url = `https://nodejs.org/dist/${nodeVersion}/node-${nodeVersion}-${nodeAsset}.tar.gz`;
  const nodeArchive = path.join(tempDir, `node-${nodeVersion}-${nodeAsset}.tar.gz`);
  const nodeExtract = path.join(tempDir, "node");
  await run("curl", ["-fsSL", url, "-o", nodeArchive]);
  await mkdir(nodeExtract, { recursive: true });
  await run("tar", ["-xzf", nodeArchive, "-C", nodeExtract, "--strip-components", "1"]);
  await cp(nodeExtract, path.join(packageRoot, "node"), { recursive: true, preserveTimestamps: true });
}

function nodeDistributionAsset() {
  if (asset === "macos-aarch64") {
    return "darwin-arm64";
  }
  if (asset === "macos-x86_64") {
    return "darwin-x64";
  }
  if (asset === "linux-aarch64") {
    return "linux-arm64";
  }
  if (asset === "linux-x86_64") {
    return "linux-x64";
  }
  throw new Error(`Bundled Node is not configured for ${asset}`);
}

async function copyIfExists(source, target) {
  if (await exists(source)) {
    await cp(source, target, { preserveTimestamps: true });
  }
}

async function exists(filePath) {
  return stat(filePath).then(
    () => true,
    () => false
  );
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function run(command, args, envOverrides = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      ...envOverrides
    }
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
  }
}
