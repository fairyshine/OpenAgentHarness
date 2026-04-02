import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { AppError } from "./errors.js";
import type { ActionRetryPolicy, RuntimeToolSet } from "./types.js";

export const NATIVE_TOOL_NAMES = ["shell.exec", "file.read", "file.write", "file.list"] as const;
export const NATIVE_TOOL_RETRY_POLICY: Record<(typeof NATIVE_TOOL_NAMES)[number], ActionRetryPolicy> = {
  "shell.exec": "manual",
  "file.read": "safe",
  "file.write": "manual",
  "file.list": "safe"
};

export function getNativeToolRetryPolicy(toolName: (typeof NATIVE_TOOL_NAMES)[number]): ActionRetryPolicy {
  return NATIVE_TOOL_RETRY_POLICY[toolName];
}

function describeRetryPolicy(retryPolicy: ActionRetryPolicy): string {
  return retryPolicy === "safe"
    ? "Retry policy: safe for future automatic recovery."
    : "Retry policy: manual only; do not assume automatic retry is safe.";
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function resolveWorkspacePath(workspaceRoot: string, targetPath: string): { absolutePath: string; relativePath: string } {
  const absolutePath = path.resolve(workspaceRoot, targetPath);
  const relativePath = path.relative(workspaceRoot, absolutePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new AppError(403, "native_tool_path_not_allowed", `Path ${targetPath} is outside the workspace root.`);
  }

  return {
    absolutePath,
    relativePath: relativePath.length > 0 ? relativePath.split(path.sep).join("/") : "."
  };
}

async function runShellCommand(
  workspaceRoot: string,
  input: {
    command: string;
    cwd?: string | undefined;
    timeoutSeconds?: number | undefined;
  },
  signal?: AbortSignal | undefined
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cwd = input.cwd ? resolveWorkspacePath(workspaceRoot, input.cwd).absolutePath : workspaceRoot;
  const child = spawn(input.command, {
    cwd,
    env: {
      ...process.env,
      OPENHARNESS_WORKSPACE_ROOT: workspaceRoot
    },
    shell: true,
    ...(signal ? { signal } : {})
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const timeout =
    typeof input.timeoutSeconds === "number" && Number.isFinite(input.timeoutSeconds) && input.timeoutSeconds > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, input.timeoutSeconds * 1000)
      : undefined;

  child.stdout.on("data", (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });

  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      resolve(code ?? 0);
    });
  }).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });

  if (timedOut) {
    throw new AppError(408, "native_tool_timeout", `shell.exec exceeded ${input.timeoutSeconds} seconds.`);
  }

  if (signal?.aborted) {
    throw new AppError(499, "native_tool_cancelled", "shell.exec was cancelled.");
  }

  return {
    stdout,
    stderr,
    exitCode
  };
}

export function createNativeToolSet(
  workspaceRoot: string,
  getVisibleToolNames: () => string[]
): RuntimeToolSet {
  const assertVisible = (toolName: (typeof NATIVE_TOOL_NAMES)[number]) => {
    if (!getVisibleToolNames().includes(toolName)) {
      throw new AppError(403, "native_tool_not_allowed", `Native tool ${toolName} is not allowed for the active agent.`);
    }
  };

  return {
    "shell.exec": {
      description: `Run a shell command inside the current workspace. ${describeRetryPolicy(getNativeToolRetryPolicy("shell.exec"))}`,
      retryPolicy: getNativeToolRetryPolicy("shell.exec"),
      inputSchema: z.object({
        command: z.string().min(1).describe("Shell command to execute."),
        cwd: z.string().min(1).optional().describe("Optional working directory relative to the workspace root."),
        timeoutSeconds: z.number().positive().optional().describe("Optional command timeout in seconds.")
      }),
      async execute(rawInput, context) {
        assertVisible("shell.exec");
        const input = z
          .object({
            command: z.string().min(1),
            cwd: z.string().min(1).optional(),
            timeoutSeconds: z.number().positive().optional()
          })
          .parse(rawInput);
        const result = await runShellCommand(workspaceRoot, input, context.abortSignal);

        return [
          `<shell_exec exit_code="${result.exitCode}">`,
          ...(result.stdout.length > 0 ? ["<stdout>", result.stdout, "</stdout>"] : []),
          ...(result.stderr.length > 0 ? ["<stderr>", result.stderr, "</stderr>"] : []),
          "</shell_exec>"
        ].join("\n");
      }
    },
    "file.read": {
      description: `Read a file from the current workspace. ${describeRetryPolicy(getNativeToolRetryPolicy("file.read"))}`,
      retryPolicy: getNativeToolRetryPolicy("file.read"),
      inputSchema: z.object({
        path: z.string().min(1).describe("File path relative to the workspace root.")
      }),
      async execute(rawInput) {
        assertVisible("file.read");
        const input = z.object({ path: z.string().min(1) }).parse(rawInput);
        const resolved = resolveWorkspacePath(workspaceRoot, input.path);
        const entry = await stat(resolved.absolutePath).catch(() => null);
        if (!entry?.isFile()) {
          throw new AppError(404, "native_tool_file_not_found", `File ${input.path} was not found.`);
        }

        const content = await readFile(resolved.absolutePath, "utf8");
        return [`<file_read path="${escapeXml(resolved.relativePath)}">`, content, "</file_read>"].join("\n");
      }
    },
    "file.write": {
      description: `Write or append text content to a file inside the current workspace. ${describeRetryPolicy(
        getNativeToolRetryPolicy("file.write")
      )}`,
      retryPolicy: getNativeToolRetryPolicy("file.write"),
      inputSchema: z.object({
        path: z.string().min(1).describe("File path relative to the workspace root."),
        content: z.string().describe("Text content to write."),
        mode: z.enum(["overwrite", "append"]).optional().describe("Whether to overwrite or append. Defaults to overwrite.")
      }),
      async execute(rawInput) {
        assertVisible("file.write");
        const input = z
          .object({
            path: z.string().min(1),
            content: z.string(),
            mode: z.enum(["overwrite", "append"]).optional()
          })
          .parse(rawInput);
        const resolved = resolveWorkspacePath(workspaceRoot, input.path);
        await mkdir(path.dirname(resolved.absolutePath), { recursive: true });
        const existing = input.mode === "append" ? await readFile(resolved.absolutePath, "utf8").catch(() => "") : "";
        const nextContent = input.mode === "append" ? `${existing}${input.content}` : input.content;
        await writeFile(resolved.absolutePath, nextContent, "utf8");

        return `<file_write path="${escapeXml(resolved.relativePath)}" mode="${escapeXml(input.mode ?? "overwrite")}" bytes="${Buffer.byteLength(
          input.content,
          "utf8"
        )}" />`;
      }
    },
    "file.list": {
      description: `List files and directories inside the current workspace. ${describeRetryPolicy(
        getNativeToolRetryPolicy("file.list")
      )}`,
      retryPolicy: getNativeToolRetryPolicy("file.list"),
      inputSchema: z.object({
        path: z.string().min(1).optional().describe("Directory path relative to the workspace root. Defaults to '.'."),
        recursive: z.boolean().optional().describe("Whether to recurse into nested directories.")
      }),
      async execute(rawInput) {
        assertVisible("file.list");
        const input = z
          .object({
            path: z.string().min(1).optional(),
            recursive: z.boolean().optional()
          })
          .parse(rawInput);
        const resolved = resolveWorkspacePath(workspaceRoot, input.path ?? ".");
        const entry = await stat(resolved.absolutePath).catch(() => null);
        if (!entry?.isDirectory()) {
          throw new AppError(404, "native_tool_directory_not_found", `Directory ${input.path ?? "."} was not found.`);
        }

        const directories = [resolved.absolutePath];
        const renderedEntries: string[] = [];

        while (directories.length > 0) {
          const currentDirectory = directories.shift();
          if (!currentDirectory) {
            continue;
          }

          const items = await readdir(currentDirectory, { withFileTypes: true });
          items.sort((left, right) => left.name.localeCompare(right.name));

          for (const item of items) {
            const absoluteItemPath = path.join(currentDirectory, item.name);
            const itemResolved = resolveWorkspacePath(workspaceRoot, absoluteItemPath);
            if (item.isDirectory()) {
              renderedEntries.push(`  <directory path="${escapeXml(itemResolved.relativePath)}" />`);
              if (input.recursive) {
                directories.push(absoluteItemPath);
              }
            } else if (item.isFile()) {
              renderedEntries.push(`  <file path="${escapeXml(itemResolved.relativePath)}" />`);
            }
          }
        }

        return [
          `<file_list path="${escapeXml(resolved.relativePath)}" recursive="${input.recursive === true ? "true" : "false"}">`,
          ...renderedEntries,
          "</file_list>"
        ].join("\n");
      }
    }
  };
}
