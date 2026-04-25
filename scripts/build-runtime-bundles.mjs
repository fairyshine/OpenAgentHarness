#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import esbuildPackage from "esbuild/package.json" with { type: "json" };

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outRootArg = process.argv[2];
const outRoot = path.resolve(repoRoot, outRootArg ?? ".oah-runtime-bundles");
const tsconfigPath = path.join(repoRoot, "tsconfig.base.json");
const esbuildBanner = 'import { createRequire as __oahCreateRequire } from "node:module"; const require = __oahCreateRequire(import.meta.url);';
const verbose = process.env.OAH_RUNTIME_BUNDLE_DIAGNOSTICS === "1";

function logDiagnostic(message, details) {
  if (!verbose) {
    return;
  }

  if (details === undefined) {
    console.error(`[runtime-bundles] ${message}`);
    return;
  }

  console.error(`[runtime-bundles] ${message}`, details);
}

async function buildRuntimeBundle(entryPoint, outdir, entryName) {
  logDiagnostic(`building ${entryPoint}`, {
    outdir: path.join(outRoot, outdir),
    entryName
  });
  await build({
    entryPoints: [path.join(repoRoot, entryPoint)],
    outdir: path.join(outRoot, outdir),
    entryNames: entryName,
    chunkNames: "chunk-[hash]",
    assetNames: "asset-[name]-[hash]",
    banner: {
      js: esbuildBanner
    },
    bundle: true,
    format: "esm",
    logLevel: "warning",
    packages: "bundle",
    platform: "node",
    sourcemap: false,
    splitting: true,
    target: "node24",
    tsconfig: tsconfigPath
  });
  logDiagnostic(`built ${entryPoint}`);
}

try {
  logDiagnostic("environment", {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    esbuild: esbuildPackage.version,
    repoRoot,
    outRoot,
    tsconfigPath
  });
  for (const bundle of [
    ["apps/server/src/index.ts", "api", "index"],
    ["apps/server/src/worker.ts", "worker", "worker"]
  ]) {
    await buildRuntimeBundle(...bundle);
  }
} catch (error) {
  console.error("[runtime-bundles] build failed");
  if (error && typeof error === "object" && "errors" in error) {
    console.error(JSON.stringify(error.errors, null, 2));
  }
  if (error && typeof error === "object" && "warnings" in error) {
    console.error(JSON.stringify(error.warnings, null, 2));
  }
  console.error(error);
  process.exitCode = 1;
}
