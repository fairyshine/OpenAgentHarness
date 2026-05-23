import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  WorkspaceForegroundCommandExecutionResult,
  WorkspaceRecord
} from "@oah/engine-core";

import {
  createE2BCompatibleSandboxHost,
  type E2BCompatibleSandboxLease
} from "../apps/server/src/bootstrap/e2b-compatible-sandbox-host.ts";
import {
  createMaterializationSandboxHost,
  type SandboxHost
} from "../apps/server/src/bootstrap/sandbox-host.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootPath) => rm(rootPath, { recursive: true, force: true })));
});

function createWorkspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    id: overrides.id ?? "ws_conformance",
    kind: "project",
    name: overrides.name ?? "Conformance",
    rootPath: overrides.rootPath ?? "/tmp/oah-conformance-source",
    readOnly: false,
    agents: {},
    models: {},
    actions: {},
    skills: {},
    toolServers: {},
    hooks: {},
    settings: {
      defaultAgent: "assistant",
      skillDirs: []
    },
    executionPolicy: "local",
    status: "active",
    createdAt: "2026-05-23T00:00:00.000Z",
    updatedAt: "2026-05-23T00:00:00.000Z",
    historyMirrorEnabled: false,
    ...overrides
  };
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function runLocalCommand(input: {
  command: string;
  cwd: string;
  env?: Record<string, string> | undefined;
  stdinText?: string | undefined;
}): Promise<WorkspaceForegroundCommandExecutionResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, {
      cwd: input.cwd,
      env: {
        ...process.env,
        ...(input.env ?? {})
      },
      shell: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 0
      });
    });
    if (input.stdinText !== undefined) {
      child.stdin?.write(input.stdinText);
    }
    child.stdin?.end();
  });
}

async function runLocalProcess(input: {
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string> | undefined;
  stdinText?: string | undefined;
}): Promise<WorkspaceForegroundCommandExecutionResult> {
  return runLocalCommand({
    command: [input.executable, ...input.args.map((arg) => JSON.stringify(arg))].join(" "),
    cwd: input.cwd,
    ...(input.env ? { env: input.env } : {}),
    ...(input.stdinText !== undefined ? { stdinText: input.stdinText } : {})
  });
}

function remoteToLocalPath(baseDir: string, remotePath: string): string {
  return path.join(baseDir, remotePath.replace(/^\/+/u, ""));
}

async function createFilesystemBackedRemoteHost(providerKind: "self_hosted" | "e2b"): Promise<{
  host: SandboxHost;
  workspace: WorkspaceRecord;
  releaseCalls: Array<{ dirty: boolean }>;
}> {
  const sandboxRoot = await createTempRoot(`oah-sandbox-conformance-${providerKind}-`);
  const workspace = createWorkspace({
    id: `ws_conformance_${providerKind}`,
    rootPath: "/workspace"
  });
  const releaseCalls: Array<{ dirty: boolean }> = [];

  const acquire = async (): Promise<E2BCompatibleSandboxLease> => {
    await mkdir(remoteToLocalPath(sandboxRoot, "/workspace"), { recursive: true });
    return {
      sandboxId: "sandbox-conformance",
      rootPath: "/workspace",
      async release(options) {
        releaseCalls.push({ dirty: options?.dirty ?? false });
      }
    };
  };

  return {
    workspace,
    releaseCalls,
    host: createE2BCompatibleSandboxHost({
      providerKind,
      diagnostics: {
        provider: providerKind,
        transport: "filesystem-test"
      },
      service: {
        acquireExecution: acquire,
        acquireFileAccess: acquire,
        async runCommand(input) {
          return runLocalCommand({
            command: input.command,
            cwd: remoteToLocalPath(sandboxRoot, input.cwd ?? input.rootPath),
            ...(input.env ? { env: input.env } : {}),
            ...(input.stdinText !== undefined ? { stdinText: input.stdinText } : {})
          });
        },
        async runProcess(input) {
          return runLocalProcess({
            executable: input.executable,
            args: input.args,
            cwd: remoteToLocalPath(sandboxRoot, input.cwd ?? input.rootPath),
            ...(input.env ? { env: input.env } : {}),
            ...(input.stdinText !== undefined ? { stdinText: input.stdinText } : {})
          });
        },
        async runBackground(input) {
          const outputPath = path.posix.join(input.rootPath, ".openharness", "state", "background", input.sessionId, "task.log");
          await mkdir(path.dirname(remoteToLocalPath(sandboxRoot, outputPath)), { recursive: true });
          await writeFile(remoteToLocalPath(sandboxRoot, outputPath), "", "utf8");
          return {
            outputPath,
            taskId: "task-conformance",
            pid: 1
          };
        },
        async stat(input) {
          const entry = await stat(remoteToLocalPath(sandboxRoot, input.path));
          return {
            kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
            size: entry.size,
            mtimeMs: entry.mtimeMs,
            birthtimeMs: entry.birthtimeMs
          };
        },
        async readFile(input) {
          return readFile(remoteToLocalPath(sandboxRoot, input.path));
        },
        async readdir(input) {
          const entries = await readdir(remoteToLocalPath(sandboxRoot, input.path), { withFileTypes: true });
          return entries.map((entry) => ({
            name: entry.name,
            kind: entry.isDirectory() ? ("directory" as const) : entry.isFile() ? ("file" as const) : ("other" as const)
          }));
        },
        async mkdir(input) {
          await mkdir(remoteToLocalPath(sandboxRoot, input.path), { recursive: input.recursive ?? false });
        },
        async writeFile(input) {
          await mkdir(path.dirname(remoteToLocalPath(sandboxRoot, input.path)), { recursive: true });
          await writeFile(remoteToLocalPath(sandboxRoot, input.path), input.data);
        },
        async rm(input) {
          await rm(remoteToLocalPath(sandboxRoot, input.path), {
            recursive: input.recursive ?? false,
            force: input.force ?? false
          });
        },
        async rename(input) {
          const targetPath = remoteToLocalPath(sandboxRoot, input.targetPath);
          await mkdir(path.dirname(targetPath), { recursive: true });
          await rename(remoteToLocalPath(sandboxRoot, input.sourcePath), targetPath);
        },
        async realpath(input) {
          await realpath(remoteToLocalPath(sandboxRoot, input.path));
          return input.path;
        },
        async close() {}
      }
    })
  };
}

async function createMaterializedHost(): Promise<{
  host: SandboxHost;
  workspace: WorkspaceRecord;
  releaseCalls: Array<{ dirty: boolean }>;
}> {
  const materializedRoot = await createTempRoot("oah-sandbox-conformance-local-");
  const workspace = createWorkspace({
    id: "ws_conformance_local",
    rootPath: path.join(os.tmpdir(), "oah-conformance-source")
  });
  const releaseCalls: Array<{ dirty: boolean }> = [];
  return {
    workspace,
    releaseCalls,
    host: createMaterializationSandboxHost({
      materializationManager: {
        acquireWorkspace: vi.fn(async () => ({
          workspaceId: workspace.id,
          version: "live",
          ownerWorkerId: "worker-conformance",
          localPath: materializedRoot,
          sourceKind: "local",
          markDirty: vi.fn(),
          touch: vi.fn(),
          async release(options?: { dirty?: boolean | undefined }) {
            releaseCalls.push({ dirty: options?.dirty ?? false });
          }
        })),
        diagnostics: vi.fn(() => ({
          draining: false,
          cachedCopies: 1,
          objectStoreCopies: 0,
          dirtyCopies: 0,
          busyCopies: 0,
          idleCopies: 1,
          failureCount: 0,
          blockerCount: 0,
          failures: []
        })),
        refreshLeases: vi.fn(async () => undefined),
        flushIdleCopies: vi.fn(async () => []),
        evictIdleCopies: vi.fn(async () => []),
        beginDrain: vi.fn(async () => ({
          drainStartedAt: "2026-05-23T00:00:00.000Z",
          flushed: [],
          evicted: []
        })),
        close: vi.fn(async () => undefined)
      } as never
    })
  };
}

const providers = [
  {
    name: "embedded materialization",
    create: createMaterializedHost
  },
  {
    name: "self-hosted filesystem",
    create: () => createFilesystemBackedRemoteHost("self_hosted")
  },
  {
    name: "e2b-compatible filesystem",
    create: () => createFilesystemBackedRemoteHost("e2b")
  }
];

describe.each(providers)("sandbox host conformance: $name", ({ create }) => {
  it("provides consistent file access lease and filesystem semantics", async () => {
    const { host, workspace, releaseCalls } = await create();
    const lease = await host.workspaceFileAccessProvider.acquire({
      workspace,
      access: "write"
    });
    const rootPath = lease.workspace.rootPath;

    await host.workspaceFileSystem.mkdir(path.join(rootPath, "nested"), { recursive: true });
    await host.workspaceFileSystem.writeFile(path.join(rootPath, "nested", "hello.txt"), Buffer.from("hello"), {
      mtimeMs: new Date("2026-05-23T00:00:00.000Z").getTime()
    });

    await expect(host.workspaceFileSystem.readFile(path.join(rootPath, "nested", "hello.txt"))).resolves.toEqual(Buffer.from("hello"));
    await expect(host.workspaceFileSystem.stat(path.join(rootPath, "nested"))).resolves.toMatchObject({ kind: "directory" });
    await expect(host.workspaceFileSystem.stat(path.join(rootPath, "nested", "hello.txt"))).resolves.toMatchObject({
      kind: "file",
      size: 5
    });
    await expect(host.workspaceFileSystem.readdir(path.join(rootPath, "nested"))).resolves.toEqual([
      expect.objectContaining({ name: "hello.txt", kind: "file" })
    ]);

    await host.workspaceFileSystem.rename(path.join(rootPath, "nested", "hello.txt"), path.join(rootPath, "nested", "renamed.txt"));
    await expect(host.workspaceFileSystem.readFile(path.join(rootPath, "nested", "renamed.txt"))).resolves.toEqual(Buffer.from("hello"));
    await host.workspaceFileSystem.rm(path.join(rootPath, "nested"), { recursive: true, force: true });
    await expect(host.workspaceFileSystem.stat(path.join(rootPath, "nested"))).rejects.toBeInstanceOf(Error);

    await lease.release({ dirty: true });
    expect(releaseCalls).toContainEqual({ dirty: true });
    await host.close();
  });

  it("provides consistent foreground and process execution semantics", async () => {
    const { host, workspace } = await create();
    const lease = await host.workspaceExecutionProvider.acquire({
      workspace,
      run: {
        id: "run_conformance",
        sessionId: "ses_conformance",
        workspaceId: workspace.id,
        status: "queued",
        triggerType: "message",
        effectiveAgentName: "assistant",
        createdAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:00:00.000Z"
      }
    });

    const foreground = await host.workspaceCommandExecutor.runForeground({
      workspace: lease.workspace,
      command: "printf '%s:%s' \"$OAH_CONFORMANCE\" \"$OPENHARNESS_WORKSPACE_ROOT\"",
      env: {
        OAH_CONFORMANCE: "ok"
      }
    });
    expect(foreground.exitCode).toBe(0);
    expect(foreground.stdout).toBe(`ok:${lease.workspace.rootPath}`);

    const processResult = await host.workspaceCommandExecutor.runProcess({
      workspace: lease.workspace,
      executable: process.execPath,
      args: ["-e", "require('node:fs').writeFileSync('process-cwd.txt', 'cwd-ok'); process.stdout.write('done')"]
    });
    expect(processResult.exitCode).toBe(0);
    expect(processResult.stdout).toBe("done");
    await expect(host.workspaceFileSystem.readFile(path.join(lease.workspace.rootPath, "process-cwd.txt"))).resolves.toEqual(
      Buffer.from("cwd-ok")
    );

    await lease.release();
    await host.close();
  });

  it("reports diagnostics and supports maintenance lifecycle hooks", async () => {
    const { host } = await create();

    expect(host.diagnostics()).toEqual(expect.objectContaining({
      executionModel: expect.any(String),
      workerPlacement: expect.any(String)
    }));
    await expect(host.maintain({ idleBefore: "2026-05-23T00:00:00.000Z" })).resolves.toBeUndefined();
    await expect(host.beginDrain()).resolves.toBeUndefined();
    await expect(host.close()).resolves.toBeUndefined();
  });
});
