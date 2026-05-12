import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repoRoot, "docs", "schemas");
const targetRoot = path.join(repoRoot, "packages", "config", "dist", "schemas");

await rm(targetRoot, { recursive: true, force: true });
await mkdir(path.dirname(targetRoot), { recursive: true });
await cp(sourceRoot, targetRoot, { recursive: true });

console.log(`Copied config schemas to ${path.relative(repoRoot, targetRoot)}`);
