import path from "node:path";

import type { ServerConfig } from "@oah/config";

export interface RuntimeProcessDescriptor {
  mode: "api_embedded_worker" | "api_only" | "standalone_worker";
  label: "API + embedded worker" | "API only" | "standalone worker";
  execution: "redis_queue" | "local_inline" | "none";
}

function readFlagValue(argv: string[], flag: string): string | undefined {
  const flagIndex = argv.findIndex((value) => value === flag);
  if (flagIndex < 0) {
    return undefined;
  }

  const value = argv[flagIndex + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }

  return value;
}

export interface SingleWorkspaceCliOptions {
  rootPath: string;
  kind: "project" | "chat";
  modelDir?: string | undefined;
  defaultModel?: string | undefined;
  toolDir?: string | undefined;
  skillDir?: string | undefined;
  host?: string | undefined;
  port?: number | undefined;
}

export function parseSingleWorkspaceOptions(argv: string[]): SingleWorkspaceCliOptions | undefined {
  const workspaceRoot = readFlagValue(argv, "--workspace");
  if (!workspaceRoot) {
    return undefined;
  }

  const workspaceKind = readFlagValue(argv, "--workspace-kind") ?? "project";
  if (workspaceKind !== "project" && workspaceKind !== "chat") {
    throw new Error(`Invalid value for --workspace-kind: ${workspaceKind}`);
  }

  const portValue = readFlagValue(argv, "--port");
  let port: number | undefined;
  if (portValue !== undefined) {
    const parsed = Number.parseInt(portValue, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error(`Invalid value for --port: ${portValue}`);
    }
    port = parsed;
  }

  return {
    rootPath: path.resolve(process.cwd(), workspaceRoot),
    kind: workspaceKind,
    ...(readFlagValue(argv, "--model-dir") ? { modelDir: path.resolve(process.cwd(), readFlagValue(argv, "--model-dir")!) } : {}),
    ...(readFlagValue(argv, "--default-model") ? { defaultModel: readFlagValue(argv, "--default-model") } : {}),
    ...(readFlagValue(argv, "--tool-dir") ? { toolDir: path.resolve(process.cwd(), readFlagValue(argv, "--tool-dir")!) } : {}),
    ...(readFlagValue(argv, "--skill-dir") ? { skillDir: path.resolve(process.cwd(), readFlagValue(argv, "--skill-dir")!) } : {}),
    ...(readFlagValue(argv, "--host") ? { host: readFlagValue(argv, "--host") } : {}),
    ...(port !== undefined ? { port } : {})
  };
}

export function buildSingleWorkspaceConfig(
  baseConfig: Awaited<ReturnType<() => Promise<ServerConfig>>> | ServerConfig | undefined,
  singleWorkspace: SingleWorkspaceCliOptions
): ServerConfig {
  const modelDir = singleWorkspace.modelDir ?? baseConfig?.paths.model_dir;
  const defaultModel = singleWorkspace.defaultModel ?? baseConfig?.llm.default_model;
  if (!modelDir) {
    throw new Error("Single-workspace mode requires --model-dir or config.paths.model_dir.");
  }
  if (!defaultModel) {
    throw new Error("Single-workspace mode requires --default-model or config.llm.default_model.");
  }

  return {
    server: {
      host: singleWorkspace.host ?? baseConfig?.server.host ?? "127.0.0.1",
      port: singleWorkspace.port ?? baseConfig?.server.port ?? 8787
    },
    storage: {
      ...(baseConfig?.storage ?? {})
    },
    paths: {
      workspace_dir: baseConfig?.paths.workspace_dir ?? path.dirname(singleWorkspace.rootPath),
      chat_dir: baseConfig?.paths.chat_dir ?? path.dirname(singleWorkspace.rootPath),
      template_dir: baseConfig?.paths.template_dir ?? path.join(singleWorkspace.rootPath, ".openharness", "__templates__"),
      model_dir: modelDir,
      tool_dir: singleWorkspace.toolDir ?? baseConfig?.paths.tool_dir ?? path.join(singleWorkspace.rootPath, ".openharness", "__platform_tools__"),
      skill_dir:
        singleWorkspace.skillDir ?? baseConfig?.paths.skill_dir ?? path.join(singleWorkspace.rootPath, ".openharness", "__platform_skills__"),
      archive_dir:
        baseConfig?.paths.archive_dir ??
        path.join(baseConfig?.paths.workspace_dir ?? path.dirname(singleWorkspace.rootPath), ".openharness", "archives")
    },
    llm: {
      default_model: defaultModel
    }
  };
}

export function parseConfigPath(argv: string[]): { path: string; explicit: boolean } {
  const configFlagIndex = argv.findIndex((value) => value === "--config");
  if (configFlagIndex >= 0) {
    const configPath = argv[configFlagIndex + 1];
    if (!configPath) {
      throw new Error("Missing value for --config.");
    }

    return {
      path: path.resolve(process.cwd(), configPath),
      explicit: true
    };
  }

  const envPath = process.env.OAH_CONFIG;
  if (envPath) {
    return {
      path: path.resolve(process.cwd(), envPath),
      explicit: true
    };
  }

  return {
    path: path.resolve(process.cwd(), "server.yaml"),
    explicit: false
  };
}

export function shouldStartEmbeddedWorker(argv: string[]): boolean {
  if (argv.includes("--api-only") || argv.includes("--no-worker")) {
    return false;
  }

  const inlineWorkerEnv = process.env.OAH_INLINE_WORKER;
  if (inlineWorkerEnv !== undefined) {
    return !["0", "false", "off"].includes(inlineWorkerEnv.toLowerCase());
  }

  return true;
}

export const shouldStartInlineWorker = shouldStartEmbeddedWorker;

export function describeRuntimeProcess(options: {
  processKind: "api" | "worker";
  startWorker: boolean;
  hasRedisRunQueue: boolean;
}): RuntimeProcessDescriptor {
  if (options.processKind === "worker") {
    return {
      mode: "standalone_worker",
      label: "standalone worker",
      execution: options.hasRedisRunQueue ? "redis_queue" : "none"
    };
  }

  if (options.startWorker) {
    return {
      mode: "api_embedded_worker",
      label: "API + embedded worker",
      execution: options.hasRedisRunQueue ? "redis_queue" : "local_inline"
    };
  }

  return {
    mode: "api_only",
    label: "API only",
    execution: options.hasRedisRunQueue ? "redis_queue" : "local_inline"
  };
}
