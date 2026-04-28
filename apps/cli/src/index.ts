#!/usr/bin/env node
import { Command } from "commander";

type GlobalOptions = {
  baseUrl?: string;
  token?: string;
};

function resolveConnection(options: GlobalOptions) {
  return {
    baseUrl: options.baseUrl ?? process.env.OAH_BASE_URL ?? "http://localhost:3000",
    token: options.token ?? process.env.OAH_TOKEN ?? ""
  };
}

const program = new Command();

program
  .name("oah")
  .description("OpenAgentHarness debug CLI")
  .version("0.1.0")
  .option("--base-url <url>", "OpenAgentHarness server URL", process.env.OAH_BASE_URL ?? "http://localhost:3000")
  .option("--token <token>", "Bearer token for API requests", process.env.OAH_TOKEN);

program
  .command("tui")
  .description("Open the interactive debug TUI")
  .action(async () => {
    const { launchTui } = await import("./tui-launcher.js");
    await launchTui(resolveConnection(program.opts<GlobalOptions>()));
  });

program
  .command("workspace:list")
  .alias("workspaces")
  .description("List visible workspaces")
  .action(async () => {
    const { OahApiClient, formatWorkspaceLine } = await import("./oah-api.js");
    const client = new OahApiClient(resolveConnection(program.opts<GlobalOptions>()));
    const workspaces = await client.listAllWorkspaces();
    if (workspaces.length === 0) {
      console.log("No workspaces found.");
      return;
    }
    for (const workspace of workspaces) {
      console.log(formatWorkspaceLine(workspace));
    }
  });

program
  .command("catalog:show")
  .description("Show a workspace catalog as JSON")
  .requiredOption("-w, --workspace <id>", "Workspace id")
  .action(async (options: { workspace: string }) => {
    const { OahApiClient } = await import("./oah-api.js");
    const client = new OahApiClient(resolveConnection(program.opts<GlobalOptions>()));
    const catalog = await client.getWorkspaceCatalog(options.workspace);
    console.log(JSON.stringify(catalog, null, 2));
  });

const argv = process.argv.filter((arg, index) => index < 2 || arg !== "--");

program.parseAsync(argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`oah: ${message}`);
  process.exitCode = 1;
});
