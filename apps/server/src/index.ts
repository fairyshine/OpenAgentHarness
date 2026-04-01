import path from "node:path";

import {
  discoverWorkspace,
  discoverWorkspaces,
  initializeWorkspaceFromTemplate,
  listWorkspaceTemplates,
  loadPlatformModels,
  loadServerConfig,
  resolveWorkspaceCreationRoot
} from "@oah/config";
import { RuntimeService } from "@oah/runtime-core";
import { AiSdkModelGateway } from "@oah/model-gateway";
import { createMemoryRuntimePersistence } from "@oah/storage-memory";

import { createApp } from "./app.js";

function parseConfigPath(argv: string[]): string {
  const configFlagIndex = argv.findIndex((value) => value === "--config");
  if (configFlagIndex >= 0) {
    const configPath = argv[configFlagIndex + 1];
    if (!configPath) {
      throw new Error("Missing value for --config.");
    }

    return path.resolve(process.cwd(), configPath);
  }

  const envPath = process.env.OAH_CONFIG;
  if (envPath) {
    return path.resolve(process.cwd(), envPath);
  }

  return path.resolve(process.cwd(), "server.yaml");
}

async function main() {
  const configPath = parseConfigPath(process.argv.slice(2));
  const config = await loadServerConfig(configPath);
  const models = await loadPlatformModels(config.paths.models_dir);
  const discoveredWorkspaces = await discoverWorkspaces({
    paths: config.paths,
    platformModels: models
  });

  const modelGateway = new AiSdkModelGateway({
    defaultModelName: config.llm.default_model,
    models
  });

  const persistence = createMemoryRuntimePersistence();
  await Promise.all(discoveredWorkspaces.map((workspace) => persistence.workspaceRepository.upsert(workspace)));
  const runtimeService = new RuntimeService({
    defaultModel: config.llm.default_model,
    modelGateway,
    platformModels: models,
    ...persistence,
    workspaceInitializer: {
      async initialize(input) {
        const workspaceRoot = resolveWorkspaceCreationRoot({
          workspaceDir: config.paths.workspace_dir,
          name: input.name,
          rootPath: input.rootPath
        });

        await initializeWorkspaceFromTemplate({
          templateDir: config.paths.template_dir,
          templateName: input.template,
          rootPath: workspaceRoot,
          agentsMd: input.agentsMd,
          mcpServers: input.mcpServers,
          skills: input.skills
        });

        return discoverWorkspace(workspaceRoot, "project", {
          platformModels: models,
          platformSkillDir: config.paths.skill_dir,
          platformMcpDir: config.paths.mcp_dir
        });
      }
    }
  });

  const app = createApp({
    runtimeService,
    modelGateway,
    defaultModel: config.llm.default_model,
    listWorkspaceTemplates: () => listWorkspaceTemplates(config.paths.template_dir)
  });

  await app.listen({
    host: config.server.host,
    port: config.server.port
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
