#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "../packages/config/node_modules/yaml/dist/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(repoRoot, "docker-compose.local.yml");
const deployTemplateRoot = path.join(repoRoot, "template", "deploy-root");
const mode = process.argv[2];
const composeProjectName =
  process.env.COMPOSE_PROJECT_NAME || path.basename(repoRoot).toLowerCase().replace(/[^a-z0-9]/g, "");
const readonlyObjectStorageVolumeKeys = ["oah-runtimes", "oah-models", "oah-tools", "oah-skills", "oah-archives"];

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

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  });

  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`${command} ${args.join(" ")} timed out`);
  }

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    throw new Error(stderr || `${command} failed`);
  }

  return (result.stdout || "").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryRunCapture(command, args, options = {}) {
  try {
    return runCapture(command, args, options);
  } catch {
    return undefined;
  }
}

async function waitForComposeServiceHealthy(service, label = service) {
  let containerId = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    containerId = tryRunCapture("docker", ["compose", "-f", composeFile, "ps", "-q", service]) || "";
    if (containerId) {
      break;
    }
    await sleep(1000);
  }

  if (!containerId) {
    throw new Error(`${label} container id not found.`);
  }

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const health = tryRunCapture("docker", ["inspect", "--format", "{{.State.Health.Status}}", containerId]);
    if (health === "healthy") {
      console.log(`${label} is healthy.`);
      return;
    }

    if (health === "unhealthy") {
      throw new Error(`${label} became unhealthy while waiting for startup.`);
    }

    await sleep(1000);
  }

  throw new Error(`Timed out waiting for ${label} to become healthy.`);
}

async function waitForCoreInfraHealthy() {
  await waitForComposeServiceHealthy("postgres", "Postgres");
  await waitForComposeServiceHealthy("redis", "Redis");
  await waitForComposeServiceHealthy("minio", "MinIO");
}

async function ensureComposeServiceRunning(service) {
  const containerId = tryRunCapture("docker", ["compose", "-f", composeFile, "ps", "-q", service]) || "";
  if (containerId) {
    const running = tryRunCapture("docker", ["inspect", "--format", "{{.State.Running}}", containerId]);
    if (running === "true") {
      return;
    }
  }

  run("docker", ["compose", "-f", composeFile, "up", "-d", service]);
}

async function resetLocalRedisCoordinationState() {
  await ensureComposeServiceRunning("redis");
  await waitForComposeServiceHealthy("redis", "Redis");

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const flush = runMaybe("docker", ["compose", "-f", composeFile, "exec", "-T", "redis", "redis-cli", "FLUSHALL"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (flush.status === 0) {
      const stdout = (flush.stdout || "").toString().trim();
      if (stdout) {
        console.log(stdout);
      }
      return;
    }

    const stderr = (flush.stderr || "").toString().trim();
    if (attempt === 4) {
      console.error(stderr || "Failed to reset local Redis coordination state.");
      process.exit(flush.status ?? 1);
    }

    console.warn(`Redis not ready for FLUSHALL yet; retrying (${attempt + 1}/5).`);
    await ensureComposeServiceRunning("redis");
    await sleep(1000);
  }
}

function ensureDeployRoot() {
  if (!process.env.OAH_DEPLOY_ROOT) {
    console.error("OAH_DEPLOY_ROOT is required. Example:");
    console.error("  export OAH_DEPLOY_ROOT=/absolute/path/to/oah-deploy-root");
    process.exit(1);
  }
}

function directoryHasSubdirectories(directoryPath) {
  if (!existsSync(directoryPath)) {
    return false;
  }

  return readdirSync(directoryPath, { withFileTypes: true }).some((entry) => entry.isDirectory());
}

function copyDirectoryChildren(sourceRoot, targetRoot) {
  mkdirSync(targetRoot, { recursive: true });
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    cpSync(path.join(sourceRoot, entry.name), path.join(targetRoot, entry.name), {
      recursive: true,
      force: false,
      errorOnExist: false
    });
  }
}

function seedDeployRootFromTemplate(deployRoot) {
  if (!existsSync(deployTemplateRoot)) {
    return false;
  }

  mkdirSync(deployRoot, { recursive: true });
  copyDirectoryChildren(deployTemplateRoot, deployRoot);
  console.log(`Seeded ${deployRoot} from ${deployTemplateRoot}.`);
  return true;
}

function ensureLocalRuntimeSources(deployRoot) {
  const sourceRoot = path.join(deployRoot, "source");
  const runtimeSourceRoot = path.join(sourceRoot, "runtimes");
  if (directoryHasSubdirectories(runtimeSourceRoot)) {
    return;
  }

  mkdirSync(sourceRoot, { recursive: true });

  const legacyBlueprintRoot = path.join(sourceRoot, "blueprints");
  if (directoryHasSubdirectories(legacyBlueprintRoot)) {
    renameSync(legacyBlueprintRoot, runtimeSourceRoot);
    console.log(
      `Migrated legacy ${legacyBlueprintRoot} to ${runtimeSourceRoot} so /api/v1/runtimes uses the current runtime layout.`
    );
    return;
  }

  const bundledRuntimeRoot = path.join(deployTemplateRoot, "source", "runtimes");
  if (directoryHasSubdirectories(bundledRuntimeRoot)) {
    copyDirectoryChildren(bundledRuntimeRoot, runtimeSourceRoot);
    console.log(`Seeded ${runtimeSourceRoot} from bundled deploy template runtimes.`);
    return;
  }

  mkdirSync(runtimeSourceRoot, { recursive: true });
}

function prepareDockerServerConfigs() {
  const requestedDeployRoot = process.env.OAH_DEPLOY_ROOT;
  if (!requestedDeployRoot) {
    throw new Error("OAH_DEPLOY_ROOT is required.");
  }
  const deployRoot = path.resolve(requestedDeployRoot);
  process.env.OAH_DEPLOY_ROOT = deployRoot;

  const sourceConfigPath = path.join(deployRoot, "server.docker.yaml");
  if (!existsSync(sourceConfigPath)) {
    const seededFromTemplate = seedDeployRootFromTemplate(deployRoot);

    if (!existsSync(sourceConfigPath)) {
      const exampleConfigPath = path.join(repoRoot, "server.example.yaml");
      if (!existsSync(exampleConfigPath)) {
        console.error(
          `Missing ${sourceConfigPath} and no deploy template or server.example.yaml available to seed it from.`
        );
        process.exit(1);
      }

      mkdirSync(deployRoot, { recursive: true });
      copyFileSync(exampleConfigPath, sourceConfigPath);
      console.log(
        `Seeded ${sourceConfigPath} from server.example.yaml. Edit it to point at your Postgres/Redis/MinIO if the defaults do not fit.`
      );
    } else if (seededFromTemplate) {
      console.log(
        `Using bundled deploy template at ${sourceConfigPath}. Add your model YAML files under ${path.join(deployRoot, "source", "models")} before deploying.`
      );
    }
  }
  ensureLocalRuntimeSources(deployRoot);

  const generatedDir = path.join(deployRoot, ".oah-local");
  const generatedApiConfigPath = path.join(generatedDir, "api.generated.yaml");
  const generatedControllerConfigPath = path.join(generatedDir, "controller.generated.yaml");
  const generatedSandboxConfigPath = path.join(generatedDir, "sandbox.generated.yaml");
  const sourceConfig = YAML.parse(readFileSync(sourceConfigPath, "utf8")) ?? {};
  if (objectStorageBacksManagedWorkspaces(sourceConfig.object_storage)) {
    console.log(
      "Object storage workspace backing is enabled. Active workspace writes will flush on idle/drain, not via sync_on_change polling."
    );
  }

  const localSandboxEmbeddedWorkers =
    sourceConfig.workers?.embedded && typeof sourceConfig.workers.embedded === "object"
      ? sourceConfig.workers.embedded
      : {
          min_count: 1,
          max_count: 2,
          scale_interval_ms: 3000,
          scale_up_window: 2,
          scale_down_window: 3,
          cooldown_ms: 4000,
          reserved_capacity_for_subagent: 0
        };
  const configuredSandboxFleet = sourceConfig.sandbox?.fleet;
  const parsedReplicaOverride = Number.parseInt(process.env.OAH_LOCAL_SANDBOX_REPLICAS || "", 10);
  const sandboxReplicaCount = Number.isFinite(parsedReplicaOverride) && parsedReplicaOverride > 0
    ? parsedReplicaOverride
    : Math.max(1, configuredSandboxFleet?.max_count ?? 4);
  const localStandaloneMinReplicas = Math.max(
    0,
    apiInt(
      sourceConfig.workers?.standalone?.min_replicas,
      configuredSandboxFleet?.min_count,
      // Keep one warm sandbox locally unless the user explicitly opts into scale-to-zero.
      1
    )
  );
  const initialSandboxReplicaCount = localStandaloneMinReplicas;

  const apiServerConfig = {
    ...sourceConfig,
    server: {
      ...(sourceConfig.server ?? {}),
      host: "0.0.0.0",
      port: 8787
    },
    sandbox: {
      ...(sourceConfig.sandbox ?? {}),
      provider: "self_hosted",
      self_hosted: {
        ...(sourceConfig.sandbox?.self_hosted ?? {}),
        base_url: "http://oah-sandbox:8787/internal/v1"
      }
    }
  };

  const controllerConfig = {
    ...apiServerConfig,
    sandbox: {
      ...(apiServerConfig.sandbox ?? {}),
      fleet: {
        ...(apiServerConfig.sandbox?.fleet ?? {}),
        min_count: apiServerConfig.sandbox?.fleet?.min_count ?? localStandaloneMinReplicas,
        max_count: apiServerConfig.sandbox?.fleet?.max_count ?? sandboxReplicaCount
      }
    },
    workers: {
      ...(apiServerConfig.workers ?? {}),
      standalone: {
        ...(apiServerConfig.workers?.standalone ?? {}),
        min_replicas: apiServerConfig.workers?.standalone?.min_replicas ?? localStandaloneMinReplicas,
        max_replicas: apiServerConfig.workers?.standalone?.max_replicas ?? sandboxReplicaCount
      },
      controller: {
        ...(apiServerConfig.workers?.controller ?? {}),
        scale_target: {
          ...(apiServerConfig.workers?.controller?.scale_target ?? {}),
          type: "docker_compose",
          allow_scale_down: apiServerConfig.workers?.controller?.scale_target?.allow_scale_down ?? true,
          docker_compose: {
            ...(apiServerConfig.workers?.controller?.scale_target?.docker_compose ?? {}),
            compose_file: composeFile,
            project_name: composeProjectName,
            service: "oah-sandbox",
            command: "docker"
          }
        }
      }
    }
  };

  const sandboxServerConfig = {
    ...sourceConfig,
    server: {
      ...(sourceConfig.server ?? {}),
      host: "0.0.0.0",
      port: 8787
    },
    workers: {
      ...(sourceConfig.workers ?? {}),
      embedded: localSandboxEmbeddedWorkers
    },
    sandbox: {
      ...(sourceConfig.sandbox ?? {}),
      provider: "embedded"
    }
  };

  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(generatedApiConfigPath, YAML.stringify(apiServerConfig), "utf8");
  writeFileSync(generatedControllerConfigPath, YAML.stringify(controllerConfig), "utf8");
  writeFileSync(generatedSandboxConfigPath, YAML.stringify(sandboxServerConfig), "utf8");

  process.env.OAH_DOCKER_API_CONFIG = generatedApiConfigPath;
  process.env.OAH_DOCKER_CONTROLLER_CONFIG = generatedControllerConfigPath;
  process.env.OAH_DOCKER_SANDBOX_CONFIG = generatedSandboxConfigPath;
  process.env.OAH_LOCAL_SANDBOX_REPLICA_COUNT = String(sandboxReplicaCount);
  process.env.OAH_LOCAL_SANDBOX_INITIAL_REPLICA_COUNT = String(initialSandboxReplicaCount);
  process.env.OAH_LOCAL_REPO_ROOT = repoRoot;
  process.env.OAH_LOCAL_DEPLOY_ROOT = deployRoot;
  process.env.COMPOSE_PROJECT_NAME = composeProjectName;
}

function apiInt(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.trunc(value);
    }
  }

  return 0;
}

function objectStorageBacksManagedWorkspaces(objectStorage) {
  if (!objectStorage) {
    return false;
  }

  if (objectStorage.workspace_backing_store) {
    return objectStorage.workspace_backing_store.enabled ?? true;
  }

  if (Array.isArray(objectStorage.managed_paths)) {
    return objectStorage.managed_paths.includes("workspace");
  }

  if (objectStorage.mirrors) {
    return false;
  }

  return true;
}

function ensureRclonePlugin() {
  const pluginList = runCapture("docker", ["plugin", "ls", "--format", "{{.Name}}\t{{.Enabled}}"]);
  const pluginLine = pluginList
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("rclone:latest\t"));

  if (!pluginLine) {
    console.error("Docker rclone volume plugin is not installed.");
    console.error("Install it first:");
    console.error("  docker run --rm --privileged -v /var/lib/docker-plugins/rclone/config:/config -v /var/lib/docker-plugins/rclone/cache:/cache alpine:3.20 sh -lc 'mkdir -p /config /cache'");
    console.error("  docker plugin install rclone/docker-volume-rclone:arm64 --grant-all-permissions --alias rclone");
    process.exit(1);
  }

  const enabled = pluginLine.split("\t")[1] === "true";
  if (!enabled) {
    console.error("Docker rclone volume plugin is installed but disabled.");
    console.error("Enable it first:");
    console.error("  docker plugin enable rclone:latest");
    process.exit(1);
  }
}

function ensureRcloneVolumeDriverResponsive() {
  try {
    runCapture("docker", ["volume", "ls", "--format", "{{.Name}}"], { timeout: 5000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Docker volume APIs are not responding. The rclone volume plugin is likely stuck.");
    console.error("Try one of these fixes, then rerun `pnpm local:up`:");
    console.error("  1. docker plugin disable -f rclone:latest && docker plugin enable rclone:latest");
    console.error("  2. Restart Docker Desktop if the disable/enable command hangs or the error persists");
    console.error("  3. Reinstall the plugin if needed:");
    console.error("     docker plugin rm -f rclone:latest");
    console.error("     docker run --rm --privileged -v /var/lib/docker-plugins/rclone/config:/config -v /var/lib/docker-plugins/rclone/cache:/cache alpine:3.20 sh -lc 'mkdir -p /config /cache'");
    console.error("     docker plugin install rclone/docker-volume-rclone:arm64 --grant-all-permissions --alias rclone");
    console.error(`Underlying error: ${message}`);
    process.exit(1);
  }
}

function composeVolumeName(volumeKey) {
  return `${composeProjectName}_${volumeKey}`;
}

function recreateReadonlyObjectStorageVolumes() {
  console.log(
    "Recreating readonly object-storage volumes to avoid rclone plugin path restore drift after docker/plugin restarts."
  );

  runMaybe("docker", ["compose", "-f", composeFile, "rm", "-sf", "oah-sandbox", "oah-controller", "oah-api"]);

  for (const volumeKey of readonlyObjectStorageVolumeKeys) {
    const volumeName = composeVolumeName(volumeKey);
    const removal = runMaybe("docker", ["volume", "rm", volumeName], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    if (removal.status === 0) {
      console.log(`Removed volume ${volumeName}`);
      continue;
    }

    const stderr = (removal.stderr || "").toString().trim();
    if (
      stderr.includes("No such volume") ||
      stderr.includes("no such volume")
    ) {
      console.log(`Volume ${volumeName} does not exist yet; skipping removal.`);
      continue;
    }

    console.error(stderr || `Failed to remove volume ${volumeName}.`);
    process.exit(removal.status ?? 1);
  }
}

function dockerImageExists(imageName) {
  const result = spawnSync("docker", ["image", "inspect", imageName], {
    cwd: repoRoot,
    env: process.env,
    stdio: "ignore"
  });
  return result.status === 0;
}

const legacyLocalImageNames = ["openagentharness-oah:latest"];
const serviceLocalImageNames = {
  "oah-api": ["openagentharness-oah-api:latest"],
  "oah-controller": ["openagentharness-oah-controller:latest"],
  "oah-sandbox": ["openagentharness-oah-sandbox:latest"]
};

function ensureDockerBuildBaseImages() {
  if (process.env.OAH_DOCKER_BUILD_BASE_IMAGE && process.env.OAH_DOCKER_RUNTIME_BASE_IMAGE) {
    console.log(
      `Using preconfigured Docker base images: build=${process.env.OAH_DOCKER_BUILD_BASE_IMAGE} runtime=${process.env.OAH_DOCKER_RUNTIME_BASE_IMAGE}`
    );
    return;
  }

  const candidatePairs = [
    {
      build: "mirror.gcr.io/library/node:24-bookworm",
      runtime: "mirror.gcr.io/library/node:24-bookworm",
      description: "mirror.gcr.io Node 24 bookworm"
    },
    {
      build: "node:24-bookworm",
      runtime: "node:24-bookworm-slim",
      description: "Docker Hub official Node 24 images"
    }
  ];

  for (const candidate of candidatePairs) {
    const buildReady =
      dockerImageExists(candidate.build) ||
      runMaybe("docker", ["pull", candidate.build], { stdio: ["ignore", "inherit", "inherit"] }).status === 0;
    if (!buildReady) {
      continue;
    }

    const runtimeReady =
      candidate.runtime === candidate.build
        ? true
        : dockerImageExists(candidate.runtime) ||
          runMaybe("docker", ["pull", candidate.runtime], { stdio: ["ignore", "inherit", "inherit"] }).status === 0;
    if (!runtimeReady) {
      continue;
    }

    process.env.OAH_DOCKER_BUILD_BASE_IMAGE = candidate.build;
    process.env.OAH_DOCKER_RUNTIME_BASE_IMAGE = candidate.runtime;
    console.log(`Using Docker base image source: ${candidate.description}`);
    return;
  }

  console.warn(
    "Could not prefetch a preferred Node base image pair. Docker build will fall back to the compose defaults and may still need Docker Hub access."
  );
}

function hasLocalOahImage(services = []) {
  if (legacyLocalImageNames.some((imageName) => dockerImageExists(imageName))) {
    return true;
  }

  return services.every((service) => {
    const candidateImages = [
      ...(serviceLocalImageNames[service] ?? []),
      `${composeProjectName}-${service}:latest`
    ];
    return candidateImages.some((imageName) => dockerImageExists(imageName));
  });
}

async function up() {
  ensureDeployRoot();
  prepareDockerServerConfigs();
  ensureDockerBuildBaseImages();
  ensureRclonePlugin();
  ensureRcloneVolumeDriverResponsive();

  run("docker", ["compose", "-f", composeFile, "up", "-d", "postgres", "redis", "minio"]);
  await waitForCoreInfraHealthy();
  recreateReadonlyObjectStorageVolumes();
  await resetLocalRedisCoordinationState();
  run("pnpm", ["storage:sync"]);

  const initialSandboxReplicaCount = Math.max(
    0,
    Number.parseInt(process.env.OAH_LOCAL_SANDBOX_INITIAL_REPLICA_COUNT || "", 10) || 0
  );
  const sandboxScaleArgs = initialSandboxReplicaCount > 0 ? ["--scale", `oah-sandbox=${initialSandboxReplicaCount}`] : [];
  const appServices =
    initialSandboxReplicaCount > 0 ? ["oah-sandbox", "oah-controller", "oah-api"] : ["oah-controller", "oah-api"];

  if (["1", "true", "yes"].includes((process.env.OAH_SKIP_BUILD || "").toLowerCase())) {
    console.warn("OAH_SKIP_BUILD is set. Starting OAH with --no-build.");
    run("docker", [
      "compose",
      "-f",
      composeFile,
      "up",
      "-d",
      "--no-build",
      ...sandboxScaleArgs,
      ...appServices
    ]);
    return;
  }

  const buildResult = runMaybe("docker", [
    "compose",
    "-f",
    composeFile,
    "up",
    "-d",
    "--build",
    ...sandboxScaleArgs,
    ...appServices
  ]);
  if (buildResult.status === 0) {
    return;
  }

  if (!hasLocalOahImage(appServices)) {
    console.error("Build failed and no reusable local OAH image was found.");
    console.error("If this is only a Docker Hub connectivity issue, try one of these:");
    console.error("  1. Re-run after Docker Desktop networking/DNS recovers");
    console.error("  2. If you already built the image before, run with OAH_SKIP_BUILD=1");
    process.exit(buildResult.status ?? 1);
  }

  console.warn("Build failed, but reusable local OAH image(s) exist. Falling back to --no-build.");
  run("docker", [
    "compose",
    "-f",
    composeFile,
    "up",
    "-d",
    "--no-build",
    ...sandboxScaleArgs,
    ...appServices
  ]);
}

function down() {
  ensureDeployRoot();
  prepareDockerServerConfigs();
  run("docker", ["compose", "-f", composeFile, "down"]);
}

if (mode === "up") {
  await up();
} else {
  down();
}
