#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";

const managedPathDirNames = {
  workspace_dir: "workspaces",
  blueprint_dir: "blueprints",
  model_dir: "models",
  tool_dir: "tools",
  skill_dir: "skills",
  archive_dir: "archives"
};

const remotePrefixByPathKey = {
  workspace_dir: "workspace",
  blueprint_dir: "blueprint",
  model_dir: "model",
  tool_dir: "tool",
  skill_dir: "skill",
  archive_dir: "archive"
};

function parseArgs(argv) {
  const options = {
    root: process.env.OAH_TEST_ROOT,
    bucket: "test-oah-server",
    awsEndpointUrl: process.env.MINIO_AWS_ENDPOINT_URL || "http://host.docker.internal:9000",
    accessKey: process.env.MINIO_ROOT_USER || "oahadmin",
    secretKey: process.env.MINIO_ROOT_PASSWORD || "oahadmin123",
    region: process.env.AWS_REGION || "us-east-1",
    sourceRoot: null,
    delete: false,
    dryRun: false,
    includeWorkspaces: false,
    deleteWorkspaces: false,
    retries: 2
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--") {
      continue;
    }

    if (argument === "--root") {
      options.root = argv[++index];
      continue;
    }
    if (argument === "--bucket") {
      options.bucket = argv[++index];
      continue;
    }
    if (argument === "--aws-endpoint-url") {
      options.awsEndpointUrl = argv[++index];
      continue;
    }
    if (argument === "--access-key") {
      options.accessKey = argv[++index];
      continue;
    }
    if (argument === "--secret-key") {
      options.secretKey = argv[++index];
      continue;
    }
    if (argument === "--region") {
      options.region = argv[++index];
      continue;
    }
    if (argument === "--source-root") {
      options.sourceRoot = argv[++index];
      continue;
    }
    if (argument === "--delete") {
      options.delete = true;
      continue;
    }
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (argument === "--include-workspaces") {
      options.includeWorkspaces = true;
      continue;
    }
    if (argument === "--delete-workspaces") {
      options.deleteWorkspaces = true;
      continue;
    }
    if (argument === "--retries") {
      options.retries = Number.parseInt(argv[++index] || "", 10);
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      printUsage();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!Number.isInteger(options.retries) || options.retries < 0) {
    throw new Error(`Invalid --retries value: ${String(options.retries)}`);
  }

  if (options.deleteWorkspaces && !options.includeWorkspaces) {
    throw new Error("--delete-workspaces requires --include-workspaces");
  }

  return options;
}

function printUsage() {
  console.log("Usage: node ./scripts/storage-sync.mjs [options]");
  console.log("");
  console.log("Options:");
  console.log("  --root <path>                Test root. Defaults to $OAH_TEST_ROOT.");
  console.log("  --source-root <path>         Source directory root. Defaults to <root>/source.");
  console.log("  --bucket <name>              Bucket name. Defaults to test-oah-server.");
  console.log("  --aws-endpoint-url <url>     Docker-reachable MinIO endpoint.");
  console.log("  --access-key <key>           MinIO access key.");
  console.log("  --secret-key <key>           MinIO secret key.");
  console.log("  --region <region>            AWS region. Defaults to us-east-1.");
  console.log("  --delete                     Delete remote objects missing locally for readonly prefixes.");
  console.log("  --include-workspaces         Also sync source/workspaces -> s3://.../workspace/.");
  console.log("  --delete-workspaces          Allow --delete on workspace prefix too.");
  console.log("  --dry-run                    Print commands without running them.");
  console.log("  --retries <n>                Retry count for transient docker/aws failures. Defaults to 2.");
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function shellQuote(value) {
  if (value === "") {
    return "''";
  }
  if (/^[A-Za-z0-9_/:=.,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function buildAwsDockerCommand(awsArgs, options, mountDir = null) {
  const command = [
    "docker",
    "run",
    "--rm",
    "-e",
    `AWS_ACCESS_KEY_ID=${options.accessKey}`,
    "-e",
    `AWS_SECRET_ACCESS_KEY=${options.secretKey}`,
    "-e",
    `AWS_DEFAULT_REGION=${options.region}`
  ];

  if (mountDir) {
    command.push("-v", `${mountDir}:/sync-source:ro`);
  }

  command.push("amazon/aws-cli:latest", "--endpoint-url", options.awsEndpointUrl, ...awsArgs);
  return command;
}

function runCommand(command, options, contextLabel) {
  const printable = command.map(shellQuote).join(" ");

  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    console.log(`$ ${printable}`);
    if (options.dryRun) {
      return;
    }

    const result = spawnSync(command[0], command.slice(1), {
      stdio: "inherit",
      env: process.env
    });

    if (result.status === 0) {
      return;
    }

    if (attempt === options.retries) {
      process.exit(result.status ?? 1);
    }

    const waitMs = 1000 * (attempt + 1);
    console.warn(
      `${contextLabel} failed (attempt ${attempt + 1}/${options.retries + 1}). Retrying in ${waitMs}ms...`
    );
    sleep(waitMs);
  }
}

function ensureBucket(options) {
  const headCommand = buildAwsDockerCommand(["s3api", "head-bucket", "--bucket", options.bucket], options);

  if (options.dryRun) {
    console.log(`Would ensure bucket exists: ${options.bucket}`);
    return;
  }

  const headResult = spawnSync(headCommand[0], headCommand.slice(1), {
    stdio: "ignore",
    env: process.env
  });

  if (headResult.status === 0) {
    console.log(`Bucket already exists: ${options.bucket}`);
    return;
  }

  const createCommand = buildAwsDockerCommand(["s3api", "create-bucket", "--bucket", options.bucket], options);
  runCommand(createCommand, options, "create-bucket");
}

function loadPublishPaths(root, sourceRoot) {
  const resolvedSourceRoot = path.resolve(sourceRoot || path.join(root, "source"));
  return Object.fromEntries(
    Object.entries(managedPathDirNames).map(([pathKey, directoryName]) => [
      pathKey,
      path.resolve(resolvedSourceRoot, directoryName)
    ])
  );
}

function syncDirectory(pathKey, directory, options) {
  const remotePrefix = remotePrefixByPathKey[pathKey];

  if (pathKey === "workspace_dir" && !options.includeWorkspaces) {
    console.log(`Skipping ${directory} -> s3://${options.bucket}/${remotePrefix}/ (workspace sync is opt-in).`);
    return;
  }

  const existsCommand = spawnSync("test", ["-d", directory], { stdio: "ignore" });
  if (existsCommand.status !== 0) {
    console.warn(`Skipping missing directory for ${pathKey}: ${directory}`);
    return;
  }

  const syncArgs = [
    "s3",
    "sync",
    "/sync-source",
    `s3://${options.bucket}/${remotePrefix}/`,
    "--exclude",
    ".DS_Store",
    "--exclude",
    "*/.DS_Store",
    "--exclude",
    "__pycache__/*",
    "--exclude",
    "*/__pycache__/*",
    "--exclude",
    "*.pyc",
    "--exclude",
    "*.db-shm",
    "--exclude",
    "*.db-wal"
  ];

  const allowDelete = options.delete && (pathKey !== "workspace_dir" || options.deleteWorkspaces);
  if (allowDelete) {
    syncArgs.push("--delete");
  }

  if (pathKey === "workspace_dir" && options.delete && !options.deleteWorkspaces) {
    console.log("Workspace sync requested without --delete-workspaces; preserving remote workspace objects.");
  }

  const command = buildAwsDockerCommand(syncArgs, options, directory);
  runCommand(command, options, `sync ${remotePrefix}`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.root) {
    throw new Error("Test root not provided. Pass --root or set OAH_TEST_ROOT.");
  }

  const root = path.resolve(options.root);
  const sourceRoot = path.resolve(options.sourceRoot || path.join(root, "source"));
  const pathMap = loadPublishPaths(root, sourceRoot);

  console.log(`Test root: ${root}`);
  console.log(`Docker aws-cli endpoint: ${options.awsEndpointUrl}`);
  console.log(`Target bucket: ${options.bucket}`);
  console.log(`Source root: ${sourceRoot}`);
  console.log(`Include workspace sync: ${options.includeWorkspaces ? "yes" : "no"}`);

  ensureBucket(options);

  for (const [pathKey, directory] of Object.entries(pathMap)) {
    syncDirectory(pathKey, directory, options);
  }

  console.log("Sync complete.");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
