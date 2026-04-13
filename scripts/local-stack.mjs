#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(repoRoot, "docker-compose.local.yml");
const mode = process.argv[2];

if (mode !== "up" && mode !== "down") {
  console.error("Usage: node ./scripts/local-stack.mjs <up|down>");
  process.exit(1);
}

function run(command, args, options = {}) {
  const printable = [command, ...args].join(" ");
  console.log(`$ ${printable}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    ...options
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runMaybe(command, args, options = {}) {
  const printable = [command, ...args].join(" ");
  console.log(`$ ${printable}`);
  return spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    ...options
  });
}

function runCapture(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    throw new Error(stderr || `${command} failed`);
  }

  return (result.stdout || "").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMinioHealthy() {
  const containerId = runCapture("docker", ["compose", "-f", composeFile, "ps", "-q", "minio"]);
  if (!containerId) {
    throw new Error("MinIO container id not found.");
  }

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const health = runCapture("docker", ["inspect", "--format", "{{.State.Health.Status}}", containerId]);
    if (health === "healthy") {
      console.log("MinIO is healthy.");
      return;
    }

    if (health === "unhealthy") {
      throw new Error("MinIO became unhealthy while waiting for startup.");
    }

    await sleep(1000);
  }

  throw new Error("Timed out waiting for MinIO to become healthy.");
}

function ensureTestRoot() {
  if (!process.env.OAH_TEST_ROOT) {
    console.error("OAH_TEST_ROOT is required. Example:");
    console.error("  export OAH_TEST_ROOT=/absolute/path/to/test_oah_server");
    process.exit(1);
  }
}

function ensureRclonePlugin() {
  const pluginList = runCapture("docker", ["plugin", "ls", "--format", "{{.Name}}"]);
  if (!pluginList.split("\n").some((name) => name.trim() === "rclone:latest")) {
    console.error("Docker rclone volume plugin is not installed.");
    console.error("Install it first:");
    console.error("  docker run --rm --privileged -v /var/lib/docker-plugins/rclone/config:/config -v /var/lib/docker-plugins/rclone/cache:/cache alpine:3.20 sh -lc 'mkdir -p /config /cache'");
    console.error("  docker plugin install rclone/docker-volume-rclone:arm64 --grant-all-permissions --alias rclone");
    process.exit(1);
  }
}

function hasLocalOahImage() {
  const result = spawnSync("docker", ["image", "inspect", "openagentharness-oah:latest"], {
    cwd: repoRoot,
    env: process.env,
    stdio: "ignore"
  });
  return result.status === 0;
}

async function up() {
  ensureTestRoot();
  ensureRclonePlugin();

  run("docker", ["compose", "-f", composeFile, "up", "-d", "postgres", "redis", "minio"]);
  await waitForMinioHealthy();
  run("pnpm", ["storage:sync"]);

  const buildResult = runMaybe("docker", ["compose", "-f", composeFile, "up", "-d", "--build", "oah"]);
  if (buildResult.status === 0) {
    return;
  }

  if (!hasLocalOahImage()) {
    process.exit(buildResult.status ?? 1);
  }

  console.warn("Build failed, but a local openagentharness-oah image exists. Falling back to --no-build.");
  run("docker", ["compose", "-f", composeFile, "up", "-d", "--no-build", "oah"]);
}

function down() {
  run("docker", ["compose", "-f", composeFile, "down"]);
}

if (mode === "up") {
  await up();
} else {
  down();
}
