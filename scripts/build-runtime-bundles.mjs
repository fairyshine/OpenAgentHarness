#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outRootArg = process.argv[2];
const outRoot = path.resolve(repoRoot, outRootArg ?? ".oah-runtime-bundles");
const tsconfigPath = path.join(repoRoot, "tsconfig.base.json");
const esbuildBanner = 'import { createRequire as __oahCreateRequire } from "node:module"; const require = __oahCreateRequire(import.meta.url);';

async function buildRuntimeBundle(entryPoint, outdir, entryName) {
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
}

await Promise.all([
  buildRuntimeBundle("apps/server/src/index.ts", "api", "index"),
  buildRuntimeBundle("apps/server/src/worker.ts", "worker", "worker")
]);
