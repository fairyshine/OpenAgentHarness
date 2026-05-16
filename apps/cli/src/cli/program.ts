import { Command } from "commander";

import { OAH_VERSION } from "../release/version.js";

type GlobalOptions = {
  baseUrl?: string;
  token?: string;
  home?: string;
};

type DaemonGlobalOptions = {
  home?: string;
};

type TuiOptions = {
  workspace?: string;
  runtime?: string;
  autoStart?: boolean;
  home?: string;
  newSession?: boolean;
  resumeLast?: boolean;
};

type WorkspaceListOptions = {
  missing?: boolean;
};

type WorkspaceRepairOptions = {
  workspace?: string;
  name?: string;
  autoStart?: boolean;
};

type WorkspaceMigrateHistoryOptions = {
  workspace?: string;
  dryRun?: boolean;
  overwrite?: boolean;
  backup?: boolean;
  autoStart?: boolean;
};

type WorkspaceCleanupOptions = {
  dryRun?: boolean;
  force?: boolean;
  includeHistory?: boolean;
  yes?: boolean;
};

type MemoryCommandOptions = {
  workspace?: string;
};

type MemorySearchOptions = MemoryCommandOptions & {
  corpus?: "all" | "index" | "topics" | "sessions" | "daily" | "dreams";
  maxResults?: number;
};

type MemoryGetOptions = MemoryCommandOptions & {
  from?: number;
  lines?: number;
};

type MemoryRejectProposalOptions = MemoryCommandOptions & {
  reason?: string;
};

type DaemonMaintenanceOptions = {
  dryRun?: boolean;
  force?: boolean;
  checkpoint?: boolean;
  vacuum?: boolean;
};

type UpdateOptions = {
  home?: string;
  installRoot?: string;
  repo?: string;
  apiBaseUrl?: string;
  releaseBaseUrl?: string;
  channel?: "latest" | "latest-prerelease";
  dryRun?: boolean;
  force?: boolean;
  verifyChecksum?: boolean;
};

type RollbackOptions = {
  home?: string;
  installRoot?: string;
};

export function resolveConnection(options: GlobalOptions) {
  return {
    baseUrl: options.baseUrl ?? process.env.OAH_BASE_URL ?? "http://127.0.0.1:8787",
    token: options.token ?? process.env.OAH_TOKEN ?? process.env.OAH_LOCAL_API_TOKEN ?? ""
  };
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("oah")
    .description("OpenAgentHarness terminal client")
    .version(OAH_VERSION)
    .option("--base-url <url>", "OpenAgentHarness server URL", process.env.OAH_BASE_URL)
    .option("--token <token>", "Bearer token for API requests", process.env.OAH_TOKEN)
    .option("--home <path>", "OAH home directory for local daemon defaults", process.env.OAH_HOME);

  program
    .command("version")
    .description("Show CLI and local installation version information")
    .option("--home <path>", "OAH home directory; defaults to OAH_HOME")
    .option("--install-root <path>", "Deprecated alias for --home")
    .action(async (options: { home?: string; installRoot?: string }) => {
      const { describeInstallation } = await import("../release/installation.js");
      console.log(
        await describeInstallation({
          home: options.home ?? program.opts<GlobalOptions>().home,
          installRoot: options.installRoot
        })
      );
    });

  program
    .command("update")
    .description("Download and switch to a GitHub Release build")
    .argument("[version]", "Release version or tag; defaults to the selected channel")
    .option("--home <path>", "OAH home directory; defaults to OAH_HOME")
    .option("--install-root <path>", "Deprecated alias for --home")
    .option("--repo <owner/repo>", "GitHub repository that publishes OAH releases")
    .option("--api-base-url <url>", "GitHub API base URL for release metadata")
    .option("--release-base-url <url>", "Release download base URL")
    .option("--channel <channel>", "Release channel: latest or latest-prerelease")
    .option("--dry-run", "Show the release and paths without downloading")
    .option("--force", "Reinstall even if the target version already exists")
    .option("--no-verify-checksum", "Skip .sha256 verification")
    .action(async (version: string | undefined, options: UpdateOptions) => {
      const { updateInstallation } = await import("../release/installation.js");
      console.log(
        await updateInstallation({
          home: options.home ?? program.opts<GlobalOptions>().home,
          installRoot: options.installRoot,
          repo: options.repo,
          apiBaseUrl: options.apiBaseUrl,
          releaseBaseUrl: options.releaseBaseUrl,
          version,
          channel: options.channel,
          dryRun: options.dryRun,
          force: options.force,
          verifyChecksum: options.verifyChecksum
        })
      );
    });

  program
    .command("rollback")
    .description("Switch current to a previously installed release")
    .argument("[version]", "Installed release version to switch to; defaults to the newest non-current version")
    .option("--home <path>", "OAH home directory; defaults to OAH_HOME")
    .option("--install-root <path>", "Deprecated alias for --home")
    .action(async (version: string | undefined, options: RollbackOptions) => {
      const { rollbackInstallation } = await import("../release/installation.js");
      console.log(
        await rollbackInstallation({
          home: options.home ?? program.opts<GlobalOptions>().home,
          installRoot: options.installRoot,
          version
        })
      );
    });

  const daemon = program.command("daemon").description("Manage the local OAP daemon").option("--home <path>", "OAH home directory");

  daemon
    .command("init")
    .description("Initialize OAH_HOME for the local OAP daemon")
    .action(async (_options: unknown, command: Command) => {
      const { initDaemonHome } = await import("../daemon/lifecycle.js");
      const paths = await initDaemonHome(resolveGroupedHomeOptions(command, daemon, program));
      console.log(`Initialized OAH_HOME at ${paths.home}`);
      console.log(`Daemon config: ${paths.configPath}`);
    });

  daemon
    .command("start")
    .description("Start the local OAP daemon")
    .option("--auth", "Require the local API bearer token for non-public routes")
    .option("--timeout-ms <ms>", "Startup health check timeout", parseIntegerOption)
    .action(async (options: { auth?: boolean; timeoutMs?: number }, command: Command) => {
      const { startDaemon } = await import("../daemon/lifecycle.js");
      console.log(await startDaemon({ ...resolveGroupedHomeOptions(command, daemon, program), ...options }));
    });

  daemon
    .command("status")
    .description("Show local OAP daemon status")
    .action(async (_options: unknown, command: Command) => {
      const { daemonStatus } = await import("../daemon/lifecycle.js");
      console.log(await daemonStatus(resolveGroupedHomeOptions(command, daemon, program)));
    });

  daemon
    .command("state")
    .description("Show OAP local state disk usage")
    .action(async (_options: unknown, command: Command) => {
      const { summarizeDaemonState } = await import("../daemon/state-maintenance.js");
      console.log(await summarizeDaemonState(resolveGroupedHomeOptions(command, daemon, program)));
    });

  daemon
    .command("maintenance")
    .description("Run local OAP state maintenance for shadow SQLite databases")
    .option("--dry-run", "Preview maintenance without opening or writing databases")
    .option("--force", "Run even if the local daemon process appears to be running")
    .option("--no-checkpoint", "Skip SQLite WAL checkpoint/truncate")
    .option("--no-vacuum", "Skip SQLite VACUUM")
    .action(async (options: DaemonMaintenanceOptions, command: Command) => {
      const { maintainDaemonState } = await import("../daemon/state-maintenance.js");
      console.log(await maintainDaemonState({ ...resolveGroupedHomeOptions(command, daemon, program), ...options }));
    });

  daemon
    .command("stop")
    .description("Stop the local OAP daemon")
    .action(async (_options: unknown, command: Command) => {
      const { stopDaemon } = await import("../daemon/lifecycle.js");
      console.log(await stopDaemon(resolveGroupedHomeOptions(command, daemon, program)));
    });

  daemon
    .command("restart")
    .description("Restart the local OAP daemon")
    .option("--timeout-ms <ms>", "Startup health check timeout", parseIntegerOption)
    .action(async (options: { timeoutMs?: number }, command: Command) => {
      const { restartDaemon } = await import("../daemon/lifecycle.js");
      console.log(await restartDaemon({ ...resolveGroupedHomeOptions(command, daemon, program), ...options }));
    });

  daemon
    .command("logs")
    .description("Show local OAP daemon logs")
    .option("-n, --lines <count>", "Number of lines to print", parseIntegerOption)
    .option("-f, --follow", "Follow daemon log output")
    .action(async (options: { lines?: number; follow?: boolean }, command: Command) => {
      const { followDaemonLogs, readDaemonLogs } = await import("../daemon/lifecycle.js");
      const input = { ...resolveGroupedHomeOptions(command, daemon, program), ...options };
      if (options.follow) {
        followDaemonLogs(input);
        return;
      }
      console.log(await readDaemonLogs(input));
    });

  const models = program.command("models").description("Manage OAP platform models").option("--home <path>", "OAH home directory");

  models
    .command("list")
    .description("List OAP platform models")
    .action(async (_options: unknown, command: Command) => {
      const { listModels } = await import("../daemon/assets.js");
      console.log(await listModels(resolveGroupedHomeOptions(command, models, program)));
    });

  models
    .command("add")
    .description("Add a model YAML file to OAH_HOME/models")
    .argument("<file>", "Model YAML file")
    .option("--overwrite", "Overwrite an existing model file or model id")
    .action(async (file: string, options: { overwrite?: boolean }, command: Command) => {
      const { addModel } = await import("../daemon/assets.js");
      console.log(await addModel(file, { ...resolveGroupedHomeOptions(command, models, program), ...options }));
    });

  models
    .command("default")
    .description("Set the default OAP model")
    .argument("<model>", "Model id")
    .action(async (model: string, _options: unknown, command: Command) => {
      const { setDefaultModel } = await import("../daemon/assets.js");
      console.log(await setDefaultModel(model, resolveGroupedHomeOptions(command, models, program)));
    });

  const runtimes = program.command("runtimes").description("Manage OAP workspace runtimes").option("--home <path>", "OAH home directory");

  runtimes
    .command("list")
    .description("List OAP workspace runtimes")
    .action(async (_options: unknown, command: Command) => {
      const { listRuntimes } = await import("../daemon/assets.js");
      console.log(await listRuntimes(resolveGroupedHomeOptions(command, runtimes, program)));
    });

  const tools = program.command("tools").description("Manage OAP platform tool catalog").option("--home <path>", "OAH home directory");

  tools
    .command("list")
    .description("List OAP platform tools")
    .action(async (_options: unknown, command: Command) => {
      const { listTools } = await import("../daemon/assets.js");
      console.log(await listTools(resolveGroupedHomeOptions(command, tools, program)));
    });

  tools
    .command("enable")
    .description("Enable a platform tool into a workspace .openharness/tools directory")
    .argument("<name>", "Platform tool name")
    .option("--workspace <path>", "Workspace path; defaults to the current directory")
    .option("--overwrite", "Replace an existing workspace tool definition and copied server directory")
    .option("--dry-run", "Preview the files that would be written")
    .action(
      async (
        name: string,
        options: { workspace?: string; overwrite?: boolean; dryRun?: boolean },
        command: Command
      ) => {
        const { enableTool } = await import("../daemon/assets.js");
        console.log(await enableTool(name, { ...resolveGroupedHomeOptions(command, tools, program), ...options }));
      }
    );

  const skills = program.command("skills").description("Manage OAP platform skill catalog").option("--home <path>", "OAH home directory");

  skills
    .command("list")
    .description("List OAP platform skills")
    .action(async (_options: unknown, command: Command) => {
      const { listSkills } = await import("../daemon/assets.js");
      console.log(await listSkills(resolveGroupedHomeOptions(command, skills, program)));
    });

  skills
    .command("enable")
    .description("Enable a platform skill into a workspace .openharness/skills directory")
    .argument("<name>", "Platform skill name")
    .option("--workspace <path>", "Workspace path; defaults to the current directory")
    .option("--overwrite", "Replace an existing workspace skill directory")
    .option("--dry-run", "Preview the files that would be written")
    .action(
      async (
        name: string,
        options: { workspace?: string; overwrite?: boolean; dryRun?: boolean },
        command: Command
      ) => {
        const { enableSkill } = await import("../daemon/assets.js");
        console.log(await enableSkill(name, { ...resolveGroupedHomeOptions(command, skills, program), ...options }));
      }
    );

  program
    .command("web")
    .description("Start the WebUI against an OAH-compatible API")
    .option("--host <host>", "WebUI server host", "127.0.0.1")
    .option("--port <port>", "WebUI server port", parseIntegerOption, 5173)
    .option("--open", "Open the browser after the WebUI starts")
    .option("--no-auto-start", "Do not auto-start the local OAP daemon when no --base-url is provided")
    .action(async (options: { host: string; port: number; open?: boolean; autoStart?: boolean }) => {
      const { launchWebUi } = await import("../web/dev-server.js");
      const { connection } = await resolveClientConnection(program.opts<GlobalOptions>(), {
        autoStartLocalDaemon: options.autoStart !== false,
        announceAutoStart: true
      });
      await launchWebUi({
        connection,
        host: options.host,
        port: options.port,
        open: Boolean(options.open)
      });
    });

  program
    .command("tui")
    .description("Open the interactive TUI")
    .option("--workspace <path>", "Register and open a local workspace path; defaults to the current directory for local OAP")
    .option("--runtime <name>", "Initialize the local workspace with a runtime before opening it")
    .option("--new-session", "Create a fresh session after opening the workspace")
    .option("--resume-last", "Resume the most recent session after opening the workspace")
    .option("--home <path>", "OAH home directory for local daemon defaults")
    .option("--no-auto-start", "Do not auto-start the local OAP daemon when no --base-url is provided")
    .action(async (options: TuiOptions) => {
      const { launchTui } = await import("../tui/launcher.js");
      if (options.newSession && options.resumeLast) {
        throw new Error("Use either --new-session or --resume-last, not both.");
      }
      const { connection, workspaceId } = await resolveTuiConnection(program.opts<GlobalOptions>(), options);
      await launchTui(connection, {
        ...(workspaceId ? { initialWorkspaceId: workspaceId } : {}),
        sessionStartupMode: options.newSession ? "new" : "resume"
      });
    });

  program
    .command("system:profile")
    .description("Show connected OAH-compatible server profile")
    .action(async () => {
      const { OahApiClient } = await import("../api/oah-api.js");
      const { connection } = await resolveClientConnection(program.opts<GlobalOptions>(), {});
      const client = new OahApiClient(connection);
      const profile = await client.getSystemProfile();
      console.log(JSON.stringify(profile, null, 2));
    });

  const memory = program.command("memory").description("Inspect local workspace memory files");

  memory
    .command("status")
    .description("Show local workspace memory status")
    .option("--workspace <path>", "Workspace path; defaults to the current directory")
    .action(async (options: MemoryCommandOptions) => {
      const { memoryStatus } = await import("./memory.js");
      console.log(await memoryStatus(options));
    });

  memory
    .command("index")
    .description("List local workspace memory files")
    .option("--workspace <path>", "Workspace path; defaults to the current directory")
    .action(async (options: MemoryCommandOptions) => {
      const { memoryIndex } = await import("./memory.js");
      console.log(await memoryIndex(options));
    });

  memory
    .command("search")
    .description("Search local workspace memory files")
    .argument("<query>", "Search query")
    .option("--workspace <path>", "Workspace path; defaults to the current directory")
    .option("--corpus <corpus>", "Corpus: all, index, topics, sessions, daily, dreams", parseMemoryCorpusOption)
    .option("--max-results <count>", "Maximum results to print", parseIntegerOption)
    .action(async (query: string, options: MemorySearchOptions) => {
      const { memorySearch } = await import("./memory.js");
      console.log(await memorySearch(query, options));
    });

  memory
    .command("get")
    .description("Read a local workspace memory file")
    .argument("<path>", "Memory file path")
    .option("--workspace <path>", "Workspace path; defaults to the current directory")
    .option("--from <line>", "Line number to start from", parseIntegerOption)
    .option("--lines <count>", "Number of lines to print", parseIntegerOption)
    .action(async (memoryPath: string, options: MemoryGetOptions) => {
      const { memoryGet } = await import("./memory.js");
      console.log(await memoryGet(memoryPath, options));
    });

  memory
    .command("proposals")
    .description("List pending local workspace memory proposals")
    .option("--workspace <path>", "Workspace path; defaults to the current directory")
    .action(async (options: MemoryCommandOptions) => {
      const { memoryProposals } = await import("./memory.js");
      console.log(await memoryProposals(options));
    });

  memory
    .command("apply-proposal")
    .description("Apply a pending local workspace memory proposal")
    .argument("<path>", "Proposal file path")
    .option("--workspace <path>", "Workspace path; defaults to the current directory")
    .action(async (proposalPath: string, options: MemoryCommandOptions) => {
      const { memoryApplyProposal } = await import("./memory.js");
      console.log(await memoryApplyProposal(proposalPath, options));
    });

  memory
    .command("reject-proposal")
    .description("Reject a pending local workspace memory proposal")
    .argument("<path>", "Proposal file path")
    .option("--workspace <path>", "Workspace path; defaults to the current directory")
    .option("--reason <text>", "Optional rejection reason")
    .action(async (proposalPath: string, options: MemoryRejectProposalOptions) => {
      const { memoryRejectProposal } = await import("./memory.js");
      console.log(await memoryRejectProposal(proposalPath, options));
    });

  const workspace = program.command("workspace").description("Manage visible workspaces");

  workspace
    .command("list")
    .description("List visible workspaces")
    .option("--missing", "Only show local workspace records whose root path no longer exists")
    .action(async (options: WorkspaceListOptions) => {
      await printWorkspaceList(program.opts<GlobalOptions>(), options);
    });

  workspace
    .command("repair")
    .description("Rebind an existing local workspace record to a new repo path")
    .argument("<workspace-id>", "Existing workspace id to repair")
    .option("--workspace <path>", "New workspace path; defaults to the current directory")
    .option("--name <name>", "Optional workspace display name")
    .option("--no-auto-start", "Do not auto-start the local OAP daemon when no --base-url is provided")
    .action(async (workspaceId: string, options: WorkspaceRepairOptions) => {
      await repairWorkspace(program.opts<GlobalOptions>(), workspaceId, options);
    });

  workspace
    .command("cleanup")
    .description("Remove local state for a workspace")
    .argument("<workspace-id>", "Existing workspace id to clean")
    .option("--dry-run", "Preview cleanup without deleting files")
    .option("--force", "Run even if the local daemon process appears to be running")
    .option("--include-history", "Also remove session/run/event history for this workspace")
    .option("--yes", "Confirm destructive history cleanup without prompting")
    .action(async (workspaceId: string, options: WorkspaceCleanupOptions) => {
      await cleanupWorkspaceCommand(program.opts<GlobalOptions>(), workspaceId, options);
    });

  workspace
    .command("migrate-history")
    .description("Copy repo-local .openharness/data/history.db into OAP shadow storage")
    .argument("[workspace-id]", "Existing workspace id; defaults to registering or reusing the selected local path")
    .option("--workspace <path>", "Workspace path containing .openharness/data/history.db; defaults to the current directory")
    .option("--dry-run", "Preview the migration without writing files")
    .option("--overwrite", "Replace an existing shadow history database")
    .option("--no-backup", "Do not backup an existing shadow history database before overwrite")
    .option("--no-auto-start", "Do not auto-start the local OAP daemon when no --base-url is provided")
    .action(async (workspaceId: string | undefined, options: WorkspaceMigrateHistoryOptions) => {
      await migrateWorkspaceHistoryCommand(program.opts<GlobalOptions>(), workspaceId, options);
    });

  program
    .command("workspace:list")
    .description("List visible workspaces")
    .option("--missing", "Only show local workspace records whose root path no longer exists")
    .action(async (options: WorkspaceListOptions) => {
      await printWorkspaceList(program.opts<GlobalOptions>(), options);
    });

  const workspaces = program
    .command("workspaces")
    .description("List or repair visible workspaces")
    .option("--missing", "Only show local workspace records whose root path no longer exists")
    .action(async (options: WorkspaceListOptions) => {
      await printWorkspaceList(program.opts<GlobalOptions>(), options);
    });

  workspaces
    .command("repair")
    .description("Rebind an existing local workspace record to a new repo path")
    .argument("<workspace-id>", "Existing workspace id to repair")
    .option("--workspace <path>", "New workspace path; defaults to the current directory")
    .option("--name <name>", "Optional workspace display name")
    .option("--no-auto-start", "Do not auto-start the local OAP daemon when no --base-url is provided")
    .action(async (workspaceId: string, options: WorkspaceRepairOptions) => {
      await repairWorkspace(program.opts<GlobalOptions>(), workspaceId, options);
    });

  workspaces
    .command("cleanup")
    .description("Remove local state for a workspace")
    .argument("<workspace-id>", "Existing workspace id to clean")
    .option("--dry-run", "Preview cleanup without deleting files")
    .option("--force", "Run even if the local daemon process appears to be running")
    .option("--include-history", "Also remove session/run/event history for this workspace")
    .option("--yes", "Confirm destructive history cleanup without prompting")
    .action(async (workspaceId: string, options: WorkspaceCleanupOptions) => {
      await cleanupWorkspaceCommand(program.opts<GlobalOptions>(), workspaceId, options);
    });

  workspaces
    .command("migrate-history")
    .description("Copy repo-local .openharness/data/history.db into OAP shadow storage")
    .argument("[workspace-id]", "Existing workspace id; defaults to registering or reusing the selected local path")
    .option("--workspace <path>", "Workspace path containing .openharness/data/history.db; defaults to the current directory")
    .option("--dry-run", "Preview the migration without writing files")
    .option("--overwrite", "Replace an existing shadow history database")
    .option("--no-backup", "Do not backup an existing shadow history database before overwrite")
    .option("--no-auto-start", "Do not auto-start the local OAP daemon when no --base-url is provided")
    .action(async (workspaceId: string | undefined, options: WorkspaceMigrateHistoryOptions) => {
      await migrateWorkspaceHistoryCommand(program.opts<GlobalOptions>(), workspaceId, options);
    });

  program
    .command("workspaces:repair")
    .description("Rebind an existing local workspace record to a new repo path")
    .argument("<workspace-id>", "Existing workspace id to repair")
    .option("--workspace <path>", "New workspace path; defaults to the current directory")
    .option("--name <name>", "Optional workspace display name")
    .option("--no-auto-start", "Do not auto-start the local OAP daemon when no --base-url is provided")
    .action(async (workspaceId: string, options: WorkspaceRepairOptions) => {
      await repairWorkspace(program.opts<GlobalOptions>(), workspaceId, options);
    });

  program
    .command("workspaces:cleanup")
    .description("Remove local state for a workspace")
    .argument("<workspace-id>", "Existing workspace id to clean")
    .option("--dry-run", "Preview cleanup without deleting files")
    .option("--force", "Run even if the local daemon process appears to be running")
    .option("--include-history", "Also remove session/run/event history for this workspace")
    .option("--yes", "Confirm destructive history cleanup without prompting")
    .action(async (workspaceId: string, options: WorkspaceCleanupOptions) => {
      await cleanupWorkspaceCommand(program.opts<GlobalOptions>(), workspaceId, options);
    });

  program
    .command("workspaces:migrate-history")
    .description("Copy repo-local .openharness/data/history.db into OAP shadow storage")
    .argument("[workspace-id]", "Existing workspace id; defaults to registering or reusing the selected local path")
    .option("--workspace <path>", "Workspace path containing .openharness/data/history.db; defaults to the current directory")
    .option("--dry-run", "Preview the migration without writing files")
    .option("--overwrite", "Replace an existing shadow history database")
    .option("--no-backup", "Do not backup an existing shadow history database before overwrite")
    .option("--no-auto-start", "Do not auto-start the local OAP daemon when no --base-url is provided")
    .action(async (workspaceId: string | undefined, options: WorkspaceMigrateHistoryOptions) => {
      await migrateWorkspaceHistoryCommand(program.opts<GlobalOptions>(), workspaceId, options);
    });

  program
    .command("catalog:show")
    .description("Show a workspace catalog as JSON")
    .requiredOption("-w, --workspace <id>", "Workspace id")
    .action(async (options: { workspace: string }) => {
      const { OahApiClient } = await import("../api/oah-api.js");
      const { connection } = await resolveClientConnection(program.opts<GlobalOptions>(), {});
      const client = new OahApiClient(connection);
      const catalog = await client.getWorkspaceCatalog(options.workspace);
      console.log(JSON.stringify(catalog, null, 2));
    });

  return program;
}

async function printWorkspaceList(globalOptions: GlobalOptions, options: WorkspaceListOptions) {
  const { OahApiClient, formatWorkspaceLine } = await import("../api/oah-api.js");
  const { connection } = await resolveClientConnection(globalOptions, {});
  const client = new OahApiClient(connection);
  let workspaces = await client.listAllWorkspaces();
  if (options.missing) {
    const profile = await client.getSystemProfile();
    if (!profile.capabilities.localWorkspacePaths) {
      throw new Error(`Connected server "${profile.displayName}" does not expose local workspace paths.`);
    }
    const missingFlags = await Promise.all(workspaces.map((workspace) => isMissingLocalPath(workspace.rootPath)));
    workspaces = workspaces.filter((_workspace, index) => missingFlags[index]);
  }

  if (workspaces.length === 0) {
    console.log(options.missing ? "No missing local workspace roots found." : "No workspaces found.");
    return;
  }
  for (const workspace of workspaces) {
    console.log(formatWorkspaceLine(workspace));
  }
}

async function repairWorkspace(globalOptions: GlobalOptions, workspaceId: string, options: WorkspaceRepairOptions) {
  const { OahApiClient } = await import("../api/oah-api.js");
  const workspacePath = options.workspace ?? process.cwd();
  const { connection } = await resolveClientConnection(globalOptions, {
    autoStartLocalDaemon: options.autoStart !== false,
    announceAutoStart: true
  });
  const client = new OahApiClient(connection);
  const profile = await client.getSystemProfile();
  if (!profile.capabilities.localWorkspacePaths || !profile.capabilities.workspaceRegistration) {
    throw new Error(
      `Connected server "${profile.displayName}" does not support local workspace repair. ` +
        "Use an OAP local daemon for path-based workspace repair."
    );
  }

  const repaired = await client.repairLocalWorkspace({
    workspaceId,
    rootPath: workspacePath,
    ...(options.name ? { name: options.name } : {})
  });
  console.log(`Repaired workspace ${repaired.name} (${repaired.id}) at ${repaired.rootPath}`);
}

async function migrateWorkspaceHistoryCommand(
  globalOptions: GlobalOptions,
  workspaceId: string | undefined,
  options: WorkspaceMigrateHistoryOptions
) {
  const { OahApiClient } = await import("../api/oah-api.js");
  const { migrateWorkspaceHistory } = await import("../daemon/history-migration.js");
  const workspacePath = options.workspace ?? process.cwd();
  const { connection, source } = await resolveClientConnection(globalOptions, {
    autoStartLocalDaemon: options.autoStart !== false,
    announceAutoStart: true
  });
  if (source !== "local-daemon" && !globalOptions.home && !process.env.OAH_HOME) {
    throw new Error("History migration writes OAP shadow storage and requires a local OAH_HOME. Pass --home when using --base-url.");
  }

  const client = new OahApiClient(connection);
  const profile = await client.getSystemProfile();
  if (!profile.capabilities.localWorkspacePaths || !profile.capabilities.workspaceRegistration) {
    throw new Error(
      `Connected server "${profile.displayName}" does not support local workspace history migration. ` +
        "Use an OAP local daemon."
    );
  }

  const workspace = workspaceId
    ? await client.getWorkspace(workspaceId)
    : await client.registerLocalWorkspace({ rootPath: workspacePath });
  const message = await migrateWorkspaceHistory({
    home: globalOptions.home,
    workspaceId: workspace.id,
    workspaceRoot: workspacePath,
    dryRun: options.dryRun,
    overwrite: options.overwrite,
    backup: options.backup
  });
  console.log(message);
}

async function cleanupWorkspaceCommand(globalOptions: GlobalOptions, workspaceId: string, options: WorkspaceCleanupOptions) {
  if (globalOptions.baseUrl ?? process.env.OAH_BASE_URL) {
    throw new Error("Workspace cleanup operates on local OAP state. Omit --base-url and use a local OAH_HOME.");
  }
  let confirmHistoryDeletion = options.yes === true;
  if (options.includeHistory && !options.dryRun && !confirmHistoryDeletion) {
    confirmHistoryDeletion = await confirmWorkspaceHistoryCleanup(workspaceId);
    if (!confirmHistoryDeletion) {
      console.log("Workspace history cleanup aborted.");
      return;
    }
  }
  const { cleanupWorkspaceState } = await import("../daemon/state-maintenance.js");
  console.log(
    await cleanupWorkspaceState({
      home: globalOptions.home,
      workspaceId,
      dryRun: options.dryRun,
      force: options.force,
      includeHistory: options.includeHistory,
      confirmHistoryDeletion
    })
  );
}

async function confirmWorkspaceHistoryCleanup(workspaceId: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error("Destructive workspace history cleanup requires an interactive terminal or --yes.");
  }
  const { createInterface } = await import("node:readline/promises");
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(`This will delete session/run/event history for workspace "${workspaceId}".\n`);
    const answer = await readline.question(`Type the workspace id to confirm: `);
    return answer === workspaceId;
  } finally {
    readline.close();
  }
}

async function isMissingLocalPath(rootPath: string): Promise<boolean> {
  if (!pathLooksLocal(rootPath)) {
    return false;
  }
  const { stat } = await import("node:fs/promises");
  return !(await stat(rootPath).then((value) => value.isDirectory(), () => false));
}

function pathLooksLocal(rootPath: string): boolean {
  return rootPath.startsWith("/") || /^[a-zA-Z]:[\\/]/u.test(rootPath);
}

async function resolveTuiConnection(globalOptions: GlobalOptions, tuiOptions: TuiOptions) {
  const { OahApiClient } = await import("../api/oah-api.js");
  const localDefaultWorkspace = !globalOptions.baseUrl && !process.env.OAH_BASE_URL;
  const workspacePath = tuiOptions.workspace ?? (localDefaultWorkspace || tuiOptions.runtime ? process.cwd() : undefined);
  const { connection } = await resolveClientConnection(
    { ...globalOptions, ...(tuiOptions.home ? { home: tuiOptions.home } : {}) },
    {
      autoStartLocalDaemon: tuiOptions.autoStart !== false,
      announceAutoStart: true
    }
  );
  if (!workspacePath) {
    return { connection };
  }

  const client = new OahApiClient(connection);
  let profile;
  try {
    profile = await client.getSystemProfile();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read server profile before local workspace registration: ${message}`);
  }
  if (!profile.capabilities.localWorkspacePaths || !profile.capabilities.workspaceRegistration) {
    throw new Error(
      `Connected server "${profile.displayName}" does not support local workspace path registration. ` +
        "Use an OAP local daemon or omit --workspace when connecting to OAH enterprise."
    );
  }
  let workspace;
  try {
    workspace = await client.registerLocalWorkspace({
      rootPath: workspacePath,
      ...(tuiOptions.runtime ? { runtime: tuiOptions.runtime } : {})
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to register local workspace "${workspacePath}": ${message}\n` +
        "Check that the path exists and is readable. If you passed --runtime, it only bootstraps directories that do not already have .openharness. If this is a remote OAH server, omit --workspace/--runtime or connect to an OAP local daemon."
    );
  }
  console.log(`Registered workspace ${workspace.name} (${workspace.id}) at ${workspace.rootPath}`);
  return { connection, workspaceId: workspace.id };
}

async function resolveClientConnection(
  globalOptions: GlobalOptions,
  options: { autoStartLocalDaemon?: boolean; announceAutoStart?: boolean }
) {
  const explicitBaseUrl = globalOptions.baseUrl ?? process.env.OAH_BASE_URL;
  if (explicitBaseUrl) {
    return {
      connection: {
        baseUrl: explicitBaseUrl,
        token: globalOptions.token ?? process.env.OAH_TOKEN ?? process.env.OAH_LOCAL_API_TOKEN ?? ""
      },
      source: "explicit" as const
    };
  }

  const { resolveDaemonApiConnection, startDaemon } = await import("../daemon/lifecycle.js");
  if (options.autoStartLocalDaemon) {
    const message = await startDaemon({ home: globalOptions.home });
    if (options.announceAutoStart) {
      console.error(message);
    }
  }

  const daemonConnection = await resolveDaemonApiConnection({ home: globalOptions.home });
  return {
    connection: {
      baseUrl: daemonConnection.baseUrl,
      token: globalOptions.token ?? process.env.OAH_TOKEN ?? process.env.OAH_LOCAL_API_TOKEN ?? daemonConnection.token ?? ""
    },
    source: "local-daemon" as const
  };
}

function parseIntegerOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid positive integer: ${value}`);
  }
  return parsed;
}

function parseMemoryCorpusOption(value: string): MemorySearchOptions["corpus"] {
  if (value === "all" || value === "index" || value === "topics" || value === "sessions" || value === "daily" || value === "dreams") {
    return value;
  }
  throw new Error(`Invalid memory corpus: ${value}`);
}

function resolveGroupedHomeOptions(command: Command | undefined, group: Command, program: Command): DaemonGlobalOptions {
  const home =
    command?.parent?.opts<DaemonGlobalOptions>().home ?? group.opts<DaemonGlobalOptions>().home ?? program.opts<DaemonGlobalOptions>().home;
  return home ? { home } : {};
}

export async function runCli(argv = process.argv): Promise<void> {
  const normalizedArgv = argv.filter((arg, index) => index < 2 || arg !== "--");
  await createProgram().parseAsync(normalizedArgv);
}
