import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createNativeToolSet } from "../packages/engine-core/src/native-tools.ts";
import { createLocalWorkspaceFileSystem } from "../packages/engine-core/src/workspace/workspace-file-system.ts";
import type { WorkspaceCommandExecutor, WorkspaceFileAccessProvider, WorkspaceFileSystem, WorkspaceRecord } from "../packages/engine-core/src/types.ts";
import type { ChatMessage } from "@oah/api-contracts";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    })
  );
});

describe("native tools", () => {
  it("uses workspace file access leases for file tools", async () => {
    const staleRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-stale-root-"));
    const liveRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-live-root-"));
    tempDirs.push(staleRoot, liveRoot);

    await writeFile(path.join(liveRoot, "spec.json"), "{\"ok\":true}\n", "utf8");

    const workspace = {
      id: "ws_file_lease",
      kind: "project",
      name: "file lease workspace",
      rootPath: staleRoot,
      readOnly: false,
      historyMirrorEnabled: false,
      settings: {},
      workspaceModels: {},
      agents: {},
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "ws_file_lease",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      },
      executionPolicy: "local",
      status: "active",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    } satisfies WorkspaceRecord;
    const acquire = vi.fn(async () => ({
      workspace: {
        ...workspace,
        rootPath: liveRoot
      },
      release: vi.fn()
    }));
    const workspaceFileAccessProvider = { acquire } satisfies WorkspaceFileAccessProvider;

    const tools = createNativeToolSet(staleRoot, () => ["Read", "Write"], {
      sessionId: "session-file-lease",
      workspace,
      workspaceFileAccessProvider
    });

    const readResult = String(await tools.Read.execute({ file_path: "spec.json" }, {}));
    expect(readResult).toContain("file_path: spec.json");
    expect(readResult).toContain("1: {\"ok\":true}");

    await tools.Write.execute({ file_path: "generated.txt", content: "from live lease\n" }, {});
    await expect(readFile(path.join(staleRoot, "generated.txt"), "utf8")).rejects.toThrow();
    expect(await readFile(path.join(liveRoot, "generated.txt"), "utf8")).toBe("from live lease\n");
    expect(acquire).toHaveBeenCalledWith({ workspace, access: "read", path: "spec.json" });
    expect(acquire).toHaveBeenCalledWith({ workspace, access: "write", path: "generated.txt" });
  });

  it("executes Title Case workspace tools", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-title-case-"));
    tempDirs.push(workspaceRoot);

    await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const answer = 41;\n", "utf8");

    const injectedModelContextMessages: ChatMessage[] = [];

    const tools = createNativeToolSet(
      workspaceRoot,
      () => ["AskUserQuestion", "Bash", "LS", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "ViewImage", "TodoWrite"],
      {
        sessionId: "session-title-case",
        injectModelContextMessage: (message) => {
          injectedModelContextMessages.push(message);
        }
      }
    );

    const askUserQuestionResult = await tools.AskUserQuestion.execute(
      {
        context: "Choosing a persistence strategy changes the implementation.",
        questions: [
          {
            question: "Which persistence strategy should we use?",
            header: "Persistence",
            options: [
              { label: "SQLite", description: "Use a local SQLite database." },
              { label: "Postgres", description: "Use the existing Postgres deployment." }
            ]
          }
        ]
      },
      {}
    );
    expect(askUserQuestionResult).toMatchObject({
      type: "json",
      value: {
        status: "awaiting_user",
        context: "Choosing a persistence strategy changes the implementation.",
        questions: [
          {
            question: "Which persistence strategy should we use?",
            header: "Persistence",
            options: [
              { label: "SQLite", description: "Use a local SQLite database." },
              { label: "Postgres", description: "Use the existing Postgres deployment." }
            ],
            multiSelect: false,
            freeText: true
          }
        ]
      }
    });

    const lsResult = await tools.LS.execute({ path: "." }, {});
    expect(String(lsResult)).toContain("contents:");
    expect(String(lsResult)).toContain("directory  src/");

    const writeResult = await tools.Write.execute({
      file_path: "notes/summary.txt",
      content: "line one\nline two"
    }, {});
    expect(String(writeResult)).toContain("file_path: notes/summary.txt");
    expect(String(writeResult)).toContain("bytes_written:");

    const readResult = await tools.Read.execute({ file_path: "notes/summary.txt" }, {});
    expect(String(readResult)).toContain("file_path: notes/summary.txt");
    expect(String(readResult)).toContain("content:");
    expect(String(readResult)).toContain("1: line one");
    expect(String(readResult)).toContain("2: line two");

    await tools.Read.execute({ file_path: "src/app.ts" }, {});
    const editResult = await tools.Edit.execute(
      {
        file_path: "src/app.ts",
        old_string: "41",
        new_string: "42"
      },
      {}
    );
    expect(String(editResult)).toContain("file_path: src/app.ts");
    expect(String(editResult)).toContain("occurrences: 1");
    expect(await readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8")).toContain("42");

    const multiEditResult = await tools.MultiEdit.execute(
      {
        file_path: "src/app.ts",
        edits: [
          {
            old_string: "answer",
            new_string: "ultimateAnswer"
          },
          {
            old_string: "42",
            new_string: "43"
          }
        ]
      },
      {}
    );
    expect(String(multiEditResult)).toContain("file_path: src/app.ts");
    expect(String(multiEditResult)).toContain("edits: 2");
    expect(await readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8")).toContain("ultimateAnswer = 43");

    const globResult = await tools.Glob.execute({ pattern: "**/*.ts" }, {});
    expect(String(globResult)).toContain("files:");
    expect(String(globResult)).toContain("src/app.ts");

    const grepResult = await tools.Grep.execute({ pattern: "ultimateAnswer", path: "src", output_mode: "content" }, {});
    expect(String(grepResult)).toContain('src/app.ts:1:export const ultimateAnswer = 43;');

    const pixelBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      "base64"
    );
    await mkdir(path.join(workspaceRoot, "assets"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "assets", "pixel.png"), pixelBytes);

    const imageGlobResult = await tools.Glob.execute({ pattern: "**/*.{png,jpg,jpeg,gif,bmp,webp,svg}" }, {});
    expect(String(imageGlobResult)).toContain("files:");
    expect(String(imageGlobResult)).toContain("assets/pixel.png");

    const leadingDotGlobResult = await tools.Glob.execute({ pattern: "./**/*.{png,jpg}" }, {});
    expect(String(leadingDotGlobResult)).toContain("assets/pixel.png");

    const windowsSeparatorGlobResult = await tools.Glob.execute({ pattern: "assets\\*.png" }, {});
    expect(String(windowsSeparatorGlobResult)).toContain("assets/pixel.png");

    const characterClassGlobResult = await tools.Glob.execute({ pattern: "assets/pixel.[pj][np]g" }, {});
    expect(String(characterClassGlobResult)).toContain("assets/pixel.png");

    const negatedClassGlobResult = await tools.Glob.execute({ pattern: "assets/pixel.[!j]ng" }, {});
    expect(String(negatedClassGlobResult)).toContain("assets/pixel.png");

    const readDirectoryResult = await tools.Read.execute({ file_path: "assets" }, {});
    expect(String(readDirectoryResult)).toContain("kind: directory");
    expect(String(readDirectoryResult)).toContain("file  pixel.png");

    const readImageResult = await tools.Read.execute({ file_path: path.join(workspaceRoot, "assets", "pixel.png") }, {});
    expect(String(readImageResult)).toContain("file_path: assets/pixel.png");
    expect(String(readImageResult)).toContain("media_type: image/png");
    expect(String(readImageResult)).toContain("kind: image");
    expect(String(readImageResult)).toContain("context_injected: true");
    expect(String(readImageResult)).toContain("context:");
    expect(String(readImageResult)).toContain("Image content was injected into the current model context");
    expect(String(readImageResult)).not.toContain(pixelBytes.toString("base64"));
    expect(injectedModelContextMessages).toHaveLength(1);
    const readImageContextContent = injectedModelContextMessages[0]?.content;
    expect(Array.isArray(readImageContextContent)).toBe(true);
    expect(readImageContextContent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "image",
          image: pixelBytes.toString("base64"),
          mediaType: "image/png"
        })
      ])
    );

    const imageResult = await tools.ViewImage.execute(
      {
        path: path.join(workspaceRoot, "assets", "pixel.png"),
        prompt: "What is the primary visual content?"
      },
      {}
    );
    expect(String(imageResult)).toContain("file_path: assets/pixel.png");
    expect(String(imageResult)).toContain("media_type: image/png");
    expect(String(imageResult)).toContain("kind: image");
    expect(String(imageResult)).toContain("prompt: What is the primary visual content?");
    expect(String(imageResult)).toContain("context_injected: true");
    expect(String(imageResult)).toContain("context:");
    expect(String(imageResult)).toContain("Image content was injected into the current model context");
    expect(String(imageResult)).not.toContain(pixelBytes.toString("base64"));
    expect(injectedModelContextMessages).toHaveLength(2);
    const viewImageContent = injectedModelContextMessages[1]?.content;
    expect(Array.isArray(viewImageContent)).toBe(true);
    expect(viewImageContent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("What is the primary visual content?")
        }),
        expect.objectContaining({
          type: "image",
          image: pixelBytes.toString("base64"),
          mediaType: "image/png"
        })
      ])
    );

    const bashResult = await tools.Bash.execute({ command: "printf bash-ok" }, {});
    expect(String(bashResult)).toContain("exit_code: 0");
    expect(String(bashResult)).toContain("stdout:");
    expect(String(bashResult)).toContain("bash-ok");

    const todoResult = await tools.TodoWrite.execute(
      {
        todos: [
          { content: "Inspect files", activeForm: "Inspecting files", status: "completed" },
          { content: "Ship fix", activeForm: "Shipping fix", status: "in_progress" }
        ]
      },
      {}
    );
    expect(String(todoResult)).toContain("todo_path: .openharness/state/todos/session-title-case.json");
    expect(String(todoResult)).toContain("remaining: 1");
    expect(String(todoResult)).toContain("in_progress: Ship fix");

    const todoFile = await readFile(
      path.join(workspaceRoot, ".openharness", "state", "todos", "session-title-case.json"),
      "utf8"
    );
    expect(JSON.parse(todoFile)).toEqual([
      { content: "Inspect files", activeForm: "Inspecting files", status: "completed" },
      { content: "Ship fix", activeForm: "Shipping fix", status: "in_progress" }
    ]);
  });

  it("validates AskUserQuestion structure", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-ask-user-question-"));
    tempDirs.push(workspaceRoot);

    const tools = createNativeToolSet(workspaceRoot, () => ["AskUserQuestion"], {
      sessionId: "session-ask-user-question"
    });

    await expect(
      tools.AskUserQuestion.execute(
        {
          questions: [
            {
              question: "Which option should we use?",
              options: [
                { label: "Same", description: "First option." },
                { label: "Same", description: "Second option." }
              ]
            }
          ]
        },
        {}
      )
    ).rejects.toThrow(/option labels must be unique/i);

    await expect(
      tools.AskUserQuestion.execute(
        {
          questions: [
            { question: "One?" },
            { question: "Two?" },
            { question: "Three?" },
            { question: "Four?" },
            { question: "Five?" }
          ]
        },
        {}
      )
    ).rejects.toThrow();
  });

  it("requires existing files to be read before Write or Edit", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-read-before-write-"));
    tempDirs.push(workspaceRoot);

    await writeFile(path.join(workspaceRoot, "existing.txt"), "hello\n", "utf8");

    const tools = createNativeToolSet(workspaceRoot, () => ["Read", "Write", "Edit"], {
      sessionId: "session-read-before-write"
    });

    await expect(
      tools.Write.execute(
        {
          file_path: "existing.txt",
          content: "updated\n"
        },
        {}
      )
    ).rejects.toThrow(/read first/i);

    await tools.Read.execute({ file_path: "existing.txt" }, {});

    await expect(
      tools.Write.execute(
        {
          file_path: "existing.txt",
          content: "updated\n"
        },
        {}
      )
    ).resolves.toContain("file_path: existing.txt");

    await expect(
      tools.Edit.execute(
        {
          file_path: "existing.txt",
          old_string: "updated",
          new_string: "done"
        },
        {}
      )
    ).resolves.toContain("file_path: existing.txt");
  });

  it("does not write partial MultiEdit changes when a later edit fails", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-multi-edit-atomic-"));
    tempDirs.push(workspaceRoot);

    await writeFile(path.join(workspaceRoot, "existing.txt"), "alpha\nbeta\n", "utf8");

    const tools = createNativeToolSet(workspaceRoot, () => ["Read", "MultiEdit"], {
      sessionId: "session-multi-edit-atomic"
    });

    await tools.Read.execute({ file_path: "existing.txt" }, {});
    await expect(
      tools.MultiEdit.execute(
        {
          file_path: "existing.txt",
          edits: [
            {
              old_string: "alpha",
              new_string: "ALPHA"
            },
            {
              old_string: "missing",
              new_string: "MISSING"
            }
          ]
        },
        {}
      )
    ).rejects.toThrow(/not found/i);

    expect(await readFile(path.join(workspaceRoot, "existing.txt"), "utf8")).toBe("alpha\nbeta\n");
  });

  it("supports Bash run_in_background with a readable output file", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-background-"));
    tempDirs.push(workspaceRoot);

    const tools = createNativeToolSet(workspaceRoot, () => ["Bash", "Read", "TerminalOutput"], {
      sessionId: "session-background"
    });

    const backgroundResult = String(
      await tools.Bash.execute(
        {
          command: "printf background-ok",
          run_in_background: true,
          description: "Print background output"
        },
        {}
      )
    );

    expect(backgroundResult).toContain("started: true");
    const outputPathMatch = backgroundResult.match(/output_path: (.+)/);
    expect(outputPathMatch?.[1]).toBeTruthy();

    const outputPath = outputPathMatch?.[1] ?? "";
    let output = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      output = await readFile(path.join(workspaceRoot, outputPath), "utf8").catch(() => "");
      if (output.includes("background-ok")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(output).toContain("background-ok");

    const taskIdMatch = backgroundResult.match(/terminal_id: (.+)/);
    expect(taskIdMatch?.[1]).toBeTruthy();
    const taskOutput = String(await tools.TerminalOutput.execute({ terminal_id: taskIdMatch?.[1] ?? "" }, {}));
    expect(taskOutput).toContain("terminal_id:");
    expect(taskOutput).toContain("status:");
    expect(taskOutput).toContain("output_path:");
    expect(taskOutput).toContain("background-ok");
  });

  it("can send input to a running Bash background task", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-background-input-"));
    tempDirs.push(workspaceRoot);

    const tools = createNativeToolSet(workspaceRoot, () => ["Bash", "TerminalInput", "TerminalOutput", "TerminalStop"], {
      sessionId: "session-background-input"
    });

    const backgroundResult = String(
      await tools.Bash.execute(
        {
          command: "cat",
          run_in_background: true,
          description: "Echo stdin"
        },
        {}
      )
    );
    const taskId = backgroundResult.match(/terminal_id: (.+)/)?.[1] ?? "";
    expect(taskId).toBeTruthy();

    try {
      const inputResult = String(await tools.TerminalInput.execute({ terminal_id: taskId, input: "hello-background-stdin" }, {}));
      expect(inputResult).toContain("terminal_id:");
      expect(inputResult).toContain("input_written: true");

      let taskOutput = "";
      for (let attempt = 0; attempt < 20; attempt += 1) {
        taskOutput = String(await tools.TerminalOutput.execute({ terminal_id: taskId }, {}));
        if (taskOutput.includes("hello-background-stdin")) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(taskOutput).toContain("input_writable: true");
      expect(taskOutput).toContain("hello-background-stdin");
    } finally {
      await tools.TerminalStop.execute({ terminal_id: taskId }, {}).catch(() => undefined);
    }
  });

  it("runs Bash background tasks inside a PTY when available", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-background-pty-"));
    tempDirs.push(workspaceRoot);

    const tools = createNativeToolSet(workspaceRoot, () => ["Bash", "TerminalOutput"], {
      sessionId: "session-background-pty"
    });

    const backgroundResult = String(
      await tools.Bash.execute(
        {
          command: "if [ -t 0 ]; then printf tty-yes; else printf tty-no; fi",
          run_in_background: true,
          description: "Check terminal mode"
        },
        {}
      )
    );
    const taskId = backgroundResult.match(/terminal_id: (.+)/)?.[1] ?? "";
    expect(taskId).toBeTruthy();

    let taskOutput = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      taskOutput = String(await tools.TerminalOutput.execute({ terminal_id: taskId }, {}));
      if (taskOutput.includes("tty-yes") || taskOutput.includes("tty-no")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(taskOutput).toContain("terminal_kind: pty");
    expect(taskOutput).toContain("tty-yes");
  });

  it("can stop a Bash background task", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-background-stop-"));
    tempDirs.push(workspaceRoot);

    const tools = createNativeToolSet(workspaceRoot, () => ["Bash", "TerminalOutput", "TerminalStop"], {
      sessionId: "session-background-stop"
    });

    const backgroundResult = String(
      await tools.Bash.execute(
        {
          command: "while true; do printf tick; sleep 1; done",
          run_in_background: true,
          description: "Loop until stopped"
        },
        {}
      )
    );
    const taskId = backgroundResult.match(/terminal_id: (.+)/)?.[1] ?? "";
    expect(taskId).toBeTruthy();

    const stopResult = String(await tools.TerminalStop.execute({ terminal_id: taskId }, {}));
    expect(stopResult).toContain("terminal_id:");
    expect(stopResult).toContain("status: stopped");

    const taskOutput = String(await tools.TerminalOutput.execute({ terminal_id: taskId }, {}));
    expect(taskOutput).toContain("status: stopped");
  });

  it("supports Bash persistent terminal sessions", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-persistent-bash-"));
    tempDirs.push(workspaceRoot);
    await mkdir(path.join(workspaceRoot, "subdir"), { recursive: true });

    const tools = createNativeToolSet(workspaceRoot, () => ["Bash"], {
      sessionId: "session-persistent-bash"
    });

    const exportResult = String(
      await tools.Bash.execute(
        {
          command: "export OAH_PERSISTENT_VALUE=kept",
          persistent_session_id: "shell-a",
          timeout: 2_000
        },
        {}
      )
    );
    expect(exportResult).toContain("persistent_session_id: shell-a");
    expect(exportResult).toContain("status: completed");

    const envResult = String(
      await tools.Bash.execute(
        {
          command: "printf \"$OAH_PERSISTENT_VALUE\"",
          persistent_session_id: "shell-a",
          timeout: 2_000
        },
        {}
      )
    );
    expect(envResult).toContain("kept");

    await tools.Bash.execute(
      {
        command: "cd subdir",
        persistent_session_id: "shell-a",
        timeout: 2_000
      },
      {}
    );
    const pwdResult = String(
      await tools.Bash.execute(
        {
          command: "pwd",
          persistent_session_id: "shell-a",
          timeout: 2_000
        },
        {}
      )
    );
    expect(pwdResult).toContain(path.join(workspaceRoot, "subdir"));

    const isolatedResult = String(
      await tools.Bash.execute(
        {
          command: "printf \"${OAH_PERSISTENT_VALUE:-missing}\"",
          persistent_session_id: "shell-b",
          timeout: 2_000
        },
        {}
      )
    );
    expect(isolatedResult).toContain("missing");

    await tools.Bash.execute({ persistent_session_id: "shell-a", close_persistent_session: true }, {});
    await tools.Bash.execute({ persistent_session_id: "shell-b", close_persistent_session: true }, {});
  });

  it("supports Bash persistent input mode for interactive processes", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-persistent-input-"));
    tempDirs.push(workspaceRoot);

    const tools = createNativeToolSet(workspaceRoot, () => ["Bash"], {
      sessionId: "session-persistent-input"
    });

    const catStart = String(
      await tools.Bash.execute(
        {
          command: "cat",
          persistent_session_id: "interactive",
          persistent_mode: "input",
          timeout: 200
        },
        {}
      )
    );
    expect(catStart).toContain("persistent_session_id: interactive");

    const inputResult = String(
      await tools.Bash.execute(
        {
          command: "hello-through-stdin",
          persistent_session_id: "interactive",
          persistent_mode: "input",
          timeout: 200
        },
        {}
      )
    );
    expect(inputResult).toContain("hello-through-stdin");

    const closeResult = String(
      await tools.Bash.execute(
        {
          persistent_session_id: "interactive",
          close_persistent_session: true
        },
        {}
      )
    );
    expect(closeResult).toContain("persistent_session_id: interactive");
    expect(closeResult).toContain("status: exited");
  });

  it("rejects unsupported persistent Bash executors", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-persistent-unsupported-"));
    tempDirs.push(workspaceRoot);

    const commandExecutor: WorkspaceCommandExecutor = {
      runForeground: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
      runProcess: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
      runBackground: vi.fn(async () => ({ outputPath: "/tmp/task.log", taskId: "task-1", pid: 1 }))
    };
    const tools = createNativeToolSet(workspaceRoot, () => ["Bash"], {
      sessionId: "session-persistent-unsupported",
      commandExecutor
    });

    await expect(
      tools.Bash.execute(
        {
          command: "printf no",
          persistent_session_id: "unsupported"
        },
        {}
      )
    ).rejects.toThrow(/Persistent Bash terminals are not supported/);
  });

  it("routes Bash through the injected workspace command executor", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-command-executor-"));
    tempDirs.push(workspaceRoot);

    const commandExecutor: WorkspaceCommandExecutor = {
      runForeground: vi.fn(async () => ({
        stdout: "executor-ok",
        stderr: "",
        exitCode: 0
      })),
      runProcess: vi.fn(async () => ({
        stdout: `${path.join(workspaceRoot, "src", "app.ts")}:1:export const value = 1;`,
        stderr: "",
        exitCode: 0
      })),
      runBackground: vi.fn(async () => ({
        outputPath: path.join(workspaceRoot, ".openharness", "state", "background", "session-executor", "task.log"),
        taskId: "task-executor",
        pid: 1234
      })),
      getBackgroundTask: vi.fn(async () => null),
      stopBackgroundTask: vi.fn(async () => null),
      writeBackgroundTaskInput: vi.fn(async (input) => ({
        taskId: input.taskId,
        outputPath: ".openharness/state/background/session-executor/task.log",
        status: "running",
        pid: 1234,
        inputWritable: true
      })),
      runPersistentTerminal: vi.fn(async (input) => ({
        terminalId: input.terminalId,
        output: "persistent-ok",
        status: "completed",
        pid: 4321,
        exitCode: 0
      })),
      stopPersistentTerminal: vi.fn(async (input) => ({
        terminalId: input.terminalId,
        output: "closed-ok",
        status: "exited",
        pid: 4321,
        exitCode: 0
      }))
    };

    await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const value = 1;\n", "utf8");

    const tools = createNativeToolSet(workspaceRoot, () => ["Bash", "Grep", "TerminalInput"], {
      sessionId: "session-executor",
      commandExecutor
    });

    const foreground = String(await tools.Bash.execute({ command: "printf ignored" }, {}));
    expect(foreground).toContain("executor-ok");
    expect(commandExecutor.runForeground).toHaveBeenCalledTimes(1);

    const background = String(
      await tools.Bash.execute({ command: "printf ignored", run_in_background: true }, {})
    );
    expect(background).toContain("terminal_id: task-executor");
    expect(commandExecutor.runBackground).toHaveBeenCalledTimes(1);

    const taskInput = String(await tools.TerminalInput.execute({ terminal_id: "task-executor", input: "ignored" }, {}));
    expect(taskInput).toContain("input_written: true");
    expect(commandExecutor.writeBackgroundTaskInput).toHaveBeenCalledTimes(1);
    expect(commandExecutor.writeBackgroundTaskInput).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-executor",
        sessionId: "session-executor",
        inputText: "ignored"
      })
    );

    const persistent = String(
      await tools.Bash.execute({ command: "printf ignored", persistent_session_id: "executor-shell" }, {})
    );
    expect(persistent).toContain("persistent-ok");
    expect(commandExecutor.runPersistentTerminal).toHaveBeenCalledTimes(1);
    expect(commandExecutor.runPersistentTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalId: "executor-shell",
        sessionId: "session-executor",
        command: "printf ignored",
        mode: "command"
      })
    );
    const closePersistent = String(
      await tools.Bash.execute({ persistent_session_id: "executor-shell", close_persistent_session: true }, {})
    );
    expect(closePersistent).toContain("closed-ok");
    expect(commandExecutor.stopPersistentTerminal).toHaveBeenCalledTimes(1);

    const grep = String(await tools.Grep.execute({ pattern: "value", path: "src", output_mode: "content" }, {}));
    expect(grep).toContain("src/app.ts:1:export const value = 1;");
    expect(commandExecutor.runProcess).toHaveBeenCalledTimes(1);
    expect(commandExecutor.runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: "rg",
        args: expect.arrayContaining(["value", "src"]),
        cwd: workspaceRoot
      })
    );
    expect(commandExecutor.runProcess).not.toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining([path.join(workspaceRoot, "src")])
      })
    );
  });

  it("routes native tool file access through the injected workspace file system", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-filesystem-"));
    tempDirs.push(workspaceRoot);

    const localFileSystem = createLocalWorkspaceFileSystem();
    const statCalls: string[] = [];
    const readCalls: string[] = [];
    const readdirCalls: string[] = [];
    const writeCalls: string[] = [];
    const fileSystem: WorkspaceFileSystem = {
      ...localFileSystem,
      async stat(targetPath) {
        statCalls.push(targetPath);
        return localFileSystem.stat(targetPath);
      },
      async readFile(targetPath) {
        readCalls.push(targetPath);
        return localFileSystem.readFile(targetPath);
      },
      async readdir(targetPath) {
        readdirCalls.push(targetPath);
        return localFileSystem.readdir(targetPath);
      },
      async writeFile(targetPath, data) {
        writeCalls.push(targetPath);
        await localFileSystem.writeFile(targetPath, data);
      }
    };

    const tools = createNativeToolSet(workspaceRoot, () => ["Read", "Write", "Edit", "TodoWrite", "Glob"], {
      sessionId: "session-fs",
      fileSystem
    });

    await tools.Write.execute({ file_path: "notes.txt", content: "one\n" }, {});
    await tools.Read.execute({ file_path: "notes.txt" }, {});
    await tools.Edit.execute(
      { file_path: "notes.txt", old_string: "one", new_string: "two" },
      {}
    );
    await tools.Glob.execute({ pattern: "**/*.txt" }, {});
    await tools.TodoWrite.execute(
      {
        todos: [{ content: "Ship", activeForm: "Shipping", status: "in_progress" }]
      },
      {}
    );

    expect(writeCalls).toContain(path.join(workspaceRoot, "notes.txt"));
    expect(writeCalls).toContain(
      path.join(workspaceRoot, ".openharness", "state", "todos", "session-fs.json")
    );
    expect(readCalls).toContain(path.join(workspaceRoot, "notes.txt"));
    expect(statCalls).toContain(path.join(workspaceRoot, "notes.txt"));
    expect(readdirCalls).toContain(workspaceRoot);
    expect(await readFile(path.join(workspaceRoot, "notes.txt"), "utf8")).toBe("two\n");
  });

  it("searches and reads workspace memory with native tools", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-memory-"));
    tempDirs.push(workspaceRoot);

    await mkdir(path.join(workspaceRoot, ".openharness", "memory", "topics"), { recursive: true });
    await mkdir(path.join(workspaceRoot, ".openharness", "memory", "sessions"), { recursive: true });
    await writeFile(
      path.join(workspaceRoot, ".openharness", "memory", "MEMORY.md"),
      "- [Database testing](topics/feedback.md)\n",
      "utf8"
    );
    await writeFile(
      path.join(workspaceRoot, ".openharness", "memory", "topics", "feedback.md"),
      [
        "---",
        "name: Database testing",
        "description: User prefers real database integration tests in this workspace.",
        "type: feedback",
        "---",
        "",
        "Do not mock database tests in this repo.",
        "Why: The user wants coverage through the real storage layer."
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(workspaceRoot, ".openharness", "memory", "sessions", "2026-05-15-api-debugging.md"),
      "Investigated API debugging flow and noted database integration constraints.\n",
      "utf8"
    );

    const tools = createNativeToolSet(workspaceRoot, () => ["MemorySearch", "MemoryRead"], {
      sessionId: "session-memory-tools"
    });

    const searchResult = String(
      await tools.MemorySearch.execute(
        {
          query: "database tests",
          corpus: "topics"
        },
        {}
      )
    );
    expect(searchResult).toContain("path=.openharness/memory/topics/feedback.md");
    expect(searchResult).toContain("type=feedback");
    expect(searchResult).toContain("Database testing");

    const readResult = String(
      await tools.MemoryRead.execute(
        {
          path: ".openharness/memory/topics/feedback.md",
          from: 7,
          lines: 2
        },
        {}
      )
    );
    expect(readResult).toContain("path: .openharness/memory/topics/feedback.md");
    expect(readResult).toContain("7: Do not mock database tests in this repo.");
    expect(readResult).toContain("8: Why: The user wants coverage through the real storage layer.");

    await expect(
      tools.MemoryRead.execute(
        {
          path: "README.md"
        },
        {}
      )
    ).rejects.toMatchObject({ code: "native_tool_memory_path_not_allowed" });
  });

  it("writes, updates, and forgets workspace memory with native tools", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-memory-write-"));
    tempDirs.push(workspaceRoot);

    const workspace = {
      id: "ws_memory_write",
      kind: "project",
      name: "memory write workspace",
      rootPath: workspaceRoot,
      readOnly: false,
      historyMirrorEnabled: false,
      settings: {
        engine: {
          workspaceMemory: {
            enabled: true,
            writePolicy: "explicit-only"
          }
        }
      },
      workspaceModels: {},
      agents: {},
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "ws_memory_write",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      },
      executionPolicy: "local",
      status: "active",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    } satisfies WorkspaceRecord;

    const tools = createNativeToolSet(
      workspaceRoot,
      () => ["MemoryRemember", "MemoryUpdate", "MemoryForget", "MemorySearch", "MemoryRead"],
      {
        sessionId: "session-memory-write",
        workspace
      }
    );

    const rememberResult = String(
      await tools.MemoryRemember.execute(
        {
          type: "feedback",
          title: "Database testing",
          description: "Use real database integration tests.",
          content: "Do not mock database tests in this repo."
        },
        {}
      )
    );
    expect(rememberResult).toContain("path: .openharness/memory/topics/feedback/database-testing.md");
    expect(rememberResult).toContain("index_updated: true");

    const topicPath = path.join(workspaceRoot, ".openharness", "memory", "topics", "feedback", "database-testing.md");
    await expect(readFile(topicPath, "utf8")).resolves.toContain("Do not mock database tests in this repo.");
    await expect(readFile(path.join(workspaceRoot, ".openharness", "memory", "MEMORY.md"), "utf8")).resolves.toContain(
      ".openharness/memory/topics/feedback/database-testing.md"
    );

    const updateResult = String(
      await tools.MemoryUpdate.execute(
        {
          path: ".openharness/memory/topics/feedback/database-testing.md",
          oldText: "Do not mock database tests",
          newText: "Prefer real database integration tests"
        },
        {}
      )
    );
    expect(updateResult).toContain("replacements: 1");
    await expect(readFile(topicPath, "utf8")).resolves.toContain("Prefer real database integration tests in this repo.");

    const candidateResult = String(
      await tools.MemoryForget.execute(
        {
          query: "database"
        },
        {}
      )
    );
    expect(candidateResult).toContain("forgotten: false");
    expect(candidateResult).toContain("path=.openharness/memory/topics/feedback/database-testing.md");

    const forgetResult = String(
      await tools.MemoryForget.execute(
        {
          path: ".openharness/memory/topics/feedback/database-testing.md"
        },
        {}
      )
    );
    expect(forgetResult).toContain("forgotten: true");
    await expect(readFile(topicPath, "utf8")).rejects.toThrow();
  });

  it("returns a pending proposal before writing suggested workspace memory", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-memory-policy-"));
    tempDirs.push(workspaceRoot);

    const workspace = {
      id: "ws_memory_policy",
      kind: "project",
      name: "memory policy workspace",
      rootPath: workspaceRoot,
      readOnly: false,
      historyMirrorEnabled: false,
      settings: {
        engine: {
          workspaceMemory: {
            enabled: true,
            writePolicy: "confirm-suggested"
          }
        }
      },
      workspaceModels: {},
      agents: {},
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "ws_memory_policy",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      },
      executionPolicy: "local",
      status: "active",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    } satisfies WorkspaceRecord;

    const tools = createNativeToolSet(workspaceRoot, () => ["MemoryRemember", "MemorySearch", "MemoryApplyProposal"], {
      sessionId: "session-memory-policy",
      workspace
    });

    const result = String(
      await tools.MemoryRemember.execute(
        {
          type: "project",
          title: "Project decision",
          content: "Durable fact."
        },
        {}
      )
    );
    expect(result).toContain("pending: true");
    expect(result).toContain("requires_confirmation: true");
    expect(result).toContain("tool: MemoryRemember");
    expect(result).toContain("target_path: .openharness/memory/topics/project/project-decision.md");
    expect(result).toContain("proposal_id:");
    expect(result).toContain("proposal_path: .openharness/memory/proposals/");
    const proposalPath = result.match(/proposal_path: (.+)/)?.[1]?.trim();
    expect(proposalPath).toBeTruthy();

    const proposalContent = await readFile(path.join(workspaceRoot, proposalPath ?? ""), "utf8");
    expect(proposalContent).toContain('status: "pending"');
    expect(proposalContent).toContain('tool: "MemoryRemember"');
    expect(proposalContent).toContain('target_path: ".openharness/memory/topics/project/project-decision.md"');
    expect(proposalContent).toContain('"title": "Project decision"');
    expect(proposalContent).toContain('"content": "Durable fact."');

    await expect(
      readFile(path.join(workspaceRoot, ".openharness", "memory", "topics", "project", "project-decision.md"), "utf8")
    ).rejects.toThrow();

    const searchResult = String(
      await tools.MemorySearch.execute(
        {
          query: "Durable fact"
        },
        {}
      )
    );
    expect(searchResult).toContain("matches: 0");
    expect(searchResult).not.toContain(".openharness/memory/proposals/");

    const applyResult = String(
      await tools.MemoryApplyProposal.execute(
        {
          path: proposalPath
        },
        {}
      )
    );
    expect(applyResult).toContain("proposal_status: applied");
    expect(applyResult).toContain("tool: MemoryRemember");
    expect(applyResult).toContain("path: .openharness/memory/topics/project/project-decision.md");
    await expect(
      readFile(path.join(workspaceRoot, ".openharness", "memory", "topics", "project", "project-decision.md"), "utf8")
    ).resolves.toContain("Durable fact.");

    const appliedProposalContent = await readFile(path.join(workspaceRoot, proposalPath ?? ""), "utf8");
    expect(appliedProposalContent).toContain('status: "applied"');
    expect(appliedProposalContent).toContain("applied_at:");

    await expect(
      tools.MemoryApplyProposal.execute(
        {
          path: proposalPath
        },
        {}
      )
    ).rejects.toMatchObject({ code: "native_tool_memory_proposal_not_pending" });
  });

  it("rejects pending workspace memory proposals without applying them", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-memory-reject-policy-"));
    tempDirs.push(workspaceRoot);

    const workspace = {
      id: "ws_memory_reject_policy",
      kind: "project",
      name: "memory reject policy workspace",
      rootPath: workspaceRoot,
      readOnly: false,
      historyMirrorEnabled: false,
      settings: {
        engine: {
          workspaceMemory: {
            enabled: true,
            writePolicy: "confirm-suggested"
          }
        }
      },
      workspaceModels: {},
      agents: {},
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "ws_memory_reject_policy",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      },
      executionPolicy: "local",
      status: "active",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    } satisfies WorkspaceRecord;

    const tools = createNativeToolSet(workspaceRoot, () => ["MemoryRemember", "MemoryRejectProposal"], {
      sessionId: "session-memory-reject-policy",
      workspace
    });

    const result = String(
      await tools.MemoryRemember.execute(
        {
          type: "project",
          title: "Rejected decision",
          content: "Do not save this."
        },
        {}
      )
    );
    const proposalPath = result.match(/proposal_path: (.+)/)?.[1]?.trim();
    expect(proposalPath).toBeTruthy();

    const rejectResult = String(
      await tools.MemoryRejectProposal.execute(
        {
          path: proposalPath,
          reason: "User declined."
        },
        {}
      )
    );
    expect(rejectResult).toContain("proposal_status: rejected");
    expect(rejectResult).toContain("reason: User declined.");
    await expect(
      readFile(path.join(workspaceRoot, ".openharness", "memory", "topics", "project", "rejected-decision.md"), "utf8")
    ).rejects.toThrow();

    const rejectedProposalContent = await readFile(path.join(workspaceRoot, proposalPath ?? ""), "utf8");
    expect(rejectedProposalContent).toContain('status: "rejected"');
    expect(rejectedProposalContent).toContain("rejected_at:");
    expect(rejectedProposalContent).toContain('rejection_reason: "User declined."');
  });

  it("uses agent-level workspace memory write policy overrides", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-memory-agent-policy-"));
    tempDirs.push(workspaceRoot);

    const workspace = {
      id: "ws_memory_agent_policy",
      kind: "project",
      name: "memory agent policy workspace",
      rootPath: workspaceRoot,
      readOnly: false,
      historyMirrorEnabled: false,
      settings: {
        engine: {
          workspaceMemory: {
            enabled: true,
            writePolicy: "explicit-only"
          }
        }
      },
      workspaceModels: {},
      agents: {
        careful: {
          name: "careful",
          mode: "primary",
          prompt: "Careful memory writer.",
          tools: {
            native: ["MemoryRemember"],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: [],
          policy: {
            workspaceMemory: {
              writePolicy: "confirm-suggested"
            }
          }
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "ws_memory_agent_policy",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      },
      executionPolicy: "local",
      status: "active",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    } satisfies WorkspaceRecord;

    const tools = createNativeToolSet(workspaceRoot, () => ["MemoryRemember"], {
      sessionId: "session-memory-agent-policy",
      workspace,
      getActiveAgentName: () => "careful"
    });

    const result = String(
      await tools.MemoryRemember.execute(
        {
          type: "project",
          title: "Agent policy",
          content: "Agent override should require confirmation."
        },
        {}
      )
    );
    expect(result).toContain("pending: true");
    expect(result).toContain("write_policy: confirm-suggested");
    await expect(
      readFile(path.join(workspaceRoot, ".openharness", "memory", "topics", "project", "agent-policy.md"), "utf8")
    ).rejects.toThrow();
  });

  it("uses session and run workspace memory write policy overrides before agent policy", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-memory-run-policy-"));
    tempDirs.push(workspaceRoot);

    const workspace = {
      id: "ws_memory_run_policy",
      kind: "project",
      name: "memory run policy workspace",
      rootPath: workspaceRoot,
      readOnly: false,
      historyMirrorEnabled: false,
      settings: {
        engine: {
          workspaceMemory: {
            enabled: true,
            writePolicy: "explicit-only"
          }
        }
      },
      workspaceModels: {},
      agents: {
        careful: {
          name: "careful",
          mode: "primary",
          prompt: "Careful memory writer.",
          tools: {
            native: ["MemoryRemember"],
            actions: [],
            skills: [],
            external: []
          },
          switch: [],
          subagents: [],
          policy: {
            workspaceMemory: {
              writePolicy: "auto-extract"
            }
          }
        }
      },
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "ws_memory_run_policy",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      },
      executionPolicy: "local",
      status: "active",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    } satisfies WorkspaceRecord;

    const session = {
      id: "session-memory-run-policy",
      workspaceId: workspace.id,
      subjectRef: "dev:test",
      activeAgentName: "careful",
      workspaceMemory: {
        writePolicy: "confirm-suggested"
      },
      status: "active",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    } satisfies import("@oah/api-contracts").Session;
    const run = {
      id: "run-memory-run-policy",
      workspaceId: workspace.id,
      sessionId: session.id,
      triggerType: "message",
      effectiveAgentName: "careful",
      status: "queued",
      switchCount: 0,
      createdAt: new Date(0).toISOString(),
      metadata: {
        workspaceMemory: {
          writePolicy: "explicit-only"
        }
      }
    } satisfies import("@oah/api-contracts").Run;

    const tools = createNativeToolSet(workspaceRoot, () => ["MemoryRemember"], {
      sessionId: session.id,
      workspace,
      session,
      run,
      getActiveAgentName: () => "careful"
    });

    const result = String(
      await tools.MemoryRemember.execute(
        {
          type: "project",
          title: "Run policy",
          content: "Run override should write directly."
        },
        {}
      )
    );
    expect(result).toContain("write_policy: explicit-only");
    expect(result).not.toContain("pending: true");
    await expect(
      readFile(path.join(workspaceRoot, ".openharness", "memory", "topics", "project", "run-policy.md"), "utf8")
    ).resolves.toContain("Run override should write directly.");

    const sessionOnlyRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-memory-session-policy-"));
    tempDirs.push(sessionOnlyRoot);
    const sessionOnlyWorkspace = {
      ...workspace,
      rootPath: sessionOnlyRoot
    } satisfies WorkspaceRecord;
    const sessionOnlyTools = createNativeToolSet(sessionOnlyRoot, () => ["MemoryRemember"], {
      sessionId: session.id,
      workspace: sessionOnlyWorkspace,
      session,
      getActiveAgentName: () => "careful"
    });

    const sessionOnlyResult = String(
      await sessionOnlyTools.MemoryRemember.execute(
        {
          type: "project",
          title: "Session policy",
          content: "Session override should require confirmation."
        },
        {}
      )
    );
    expect(sessionOnlyResult).toContain("pending: true");
    expect(sessionOnlyResult).toContain("write_policy: confirm-suggested");
  });

  it("captures session summaries under workspace memory sessions", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-memory-session-"));
    tempDirs.push(workspaceRoot);

    const tools = createNativeToolSet(workspaceRoot, () => ["MemoryCaptureSession"], {
      sessionId: "session-memory-capture"
    });

    const captureResult = String(
      await tools.MemoryCaptureSession.execute(
        {
          title: "API debugging",
          summary: "- Goal: debug API flow\n- Finding: storage layer needs real integration coverage",
          sessionId: "ses_123",
          runId: "run_456",
          reason: "Before compaction",
          path: "api-debugging.md"
        },
        {}
      )
    );
    expect(captureResult).toContain("path: .openharness/memory/sessions/api-debugging.md");
    expect(captureResult).toContain("session_id: ses_123");
    const capturePath = path.join(workspaceRoot, ".openharness", "memory", "sessions", "api-debugging.md");
    await expect(readFile(capturePath, "utf8")).resolves.toContain("storage layer needs real integration coverage");

    await expect(
      tools.MemoryCaptureSession.execute(
        {
          title: "Bad capture",
          summary: "Should not write outside sessions.",
          path: "../topics/bad.md"
        },
        {}
      )
    ).rejects.toMatchObject({ code: "native_tool_memory_path_not_allowed" });
  });

  it("appends low-weight daily workspace memory logs", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-memory-daily-"));
    tempDirs.push(workspaceRoot);

    const tools = createNativeToolSet(workspaceRoot, () => ["MemoryAppendDaily", "MemorySearch"], {
      sessionId: "session-memory-daily"
    });

    const firstResult = String(
      await tools.MemoryAppendDaily.execute(
        {
          date: "2026-05-15",
          title: "Memory implementation",
          content: "Implemented native memory tools and workspace policy parsing."
        },
        {}
      )
    );
    expect(firstResult).toContain("path: .openharness/memory/daily/2026-05-15.md");
    expect(firstResult).toContain("created: true");

    const secondResult = String(
      await tools.MemoryAppendDaily.execute(
        {
          date: "2026-05-15",
          content: "Verified daily memory search coverage."
        },
        {}
      )
    );
    expect(secondResult).toContain("updated: true");

    const dailyPath = path.join(workspaceRoot, ".openharness", "memory", "daily", "2026-05-15.md");
    const dailyContent = await readFile(dailyPath, "utf8");
    expect(dailyContent).toContain("type: daily");
    expect(dailyContent).toContain("Implemented native memory tools");
    expect(dailyContent).toContain("Verified daily memory search coverage");

    const searchResult = String(
      await tools.MemorySearch.execute(
        {
          query: "daily memory search",
          corpus: "daily"
        },
        {}
      )
    );
    expect(searchResult).toContain("path=.openharness/memory/daily/2026-05-15.md");
  });

  it("records memory dreams review notes", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-memory-dreams-"));
    tempDirs.push(workspaceRoot);

    const tools = createNativeToolSet(workspaceRoot, () => ["MemoryRecordDream", "MemorySearch"], {
      sessionId: "session-memory-dreams"
    });

    const dreamResult = String(
      await tools.MemoryRecordDream.execute(
        {
          title: "Promote testing preference",
          recommendation: "Promote repeated database testing preference into topics/feedback.",
          sourcePaths: [".openharness/memory/sessions/2026-05-15-api-debugging.md"],
          targetPath: ".openharness/memory/topics/feedback/database-testing.md"
        },
        {}
      )
    );
    expect(dreamResult).toContain("path: .openharness/memory/dreams/DREAMS.md");
    expect(dreamResult).toContain("created: true");

    const dreamsPath = path.join(workspaceRoot, ".openharness", "memory", "dreams", "DREAMS.md");
    const dreamsContent = await readFile(dreamsPath, "utf8");
    expect(dreamsContent).toContain("type: dreams");
    expect(dreamsContent).toContain("Promote repeated database testing preference");
    expect(dreamsContent).toContain(".openharness/memory/topics/feedback/database-testing.md");

    const searchResult = String(
      await tools.MemorySearch.execute(
        {
          query: "database testing preference",
          corpus: "dreams"
        },
        {}
      )
    );
    expect(searchResult).toContain("path=.openharness/memory/dreams/DREAMS.md");
  });

  it("refuses to write obvious secrets into workspace memory", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-memory-secret-"));
    tempDirs.push(workspaceRoot);

    const tools = createNativeToolSet(workspaceRoot, () => ["MemoryRemember"], {
      sessionId: "session-memory-secret"
    });

    await expect(
      tools.MemoryRemember.execute(
        {
          type: "reference",
          title: "Bad secret",
          content: "api_key = \"1234567890abcdef1234567890abcdef\""
        },
        {}
      )
    ).rejects.toMatchObject({ code: "native_tool_memory_secret_detected" });
  });

  it("accepts todos when no item is marked in progress", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-todo-no-progress-"));
    tempDirs.push(workspaceRoot);

    const tools = createNativeToolSet(workspaceRoot, () => ["TodoWrite"], {
      sessionId: "session-todo-no-progress"
    });

    const result = String(
      await tools.TodoWrite.execute(
        {
          todos: [
            { content: "Inspect files", activeForm: "Inspecting files", status: "completed" },
            { content: "Ship fix", activeForm: "Shipping fix", status: "pending" },
            { content: "Write tests", activeForm: "Writing tests", status: "pending" }
          ]
        },
        {}
      )
    );

    expect(result).toContain("remaining: 2");
    expect(result).toContain("pending: Ship fix");
    expect(result).toContain("pending: Write tests");

    const todoFile = await readFile(
      path.join(workspaceRoot, ".openharness", "state", "todos", "session-todo-no-progress.json"),
      "utf8"
    );
    expect(JSON.parse(todoFile)).toEqual([
      { content: "Inspect files", activeForm: "Inspecting files", status: "completed" },
      { content: "Ship fix", activeForm: "Shipping fix", status: "pending" },
      { content: "Write tests", activeForm: "Writing tests", status: "pending" }
    ]);
  });

  it("accepts multiple in-progress todos without failing", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-todo-multi-progress-"));
    tempDirs.push(workspaceRoot);

    const tools = createNativeToolSet(workspaceRoot, () => ["TodoWrite"], {
      sessionId: "session-todo-multi-progress"
    });

    const result = String(
      await tools.TodoWrite.execute(
        {
          todos: [
            { content: "Inspect files", activeForm: "Inspecting files", status: "in_progress" },
            { content: "Ship fix", activeForm: "Shipping fix", status: "in_progress" },
            { content: "Write tests", activeForm: "Writing tests", status: "pending" }
          ]
        },
        {}
      )
    );

    expect(result).toContain("remaining: 3");
    expect(result).toContain("in_progress: Inspect files");
    expect(result).toContain("in_progress: Ship fix");
    expect(result).toContain("pending: Write tests");

    const todoFile = await readFile(
      path.join(workspaceRoot, ".openharness", "state", "todos", "session-todo-multi-progress.json"),
      "utf8"
    );
    expect(JSON.parse(todoFile)).toEqual([
      { content: "Inspect files", activeForm: "Inspecting files", status: "in_progress" },
      { content: "Ship fix", activeForm: "Shipping fix", status: "in_progress" },
      { content: "Write tests", activeForm: "Writing tests", status: "pending" }
    ]);
  });

  it("fetches and searches the web with Title Case tools", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-web-"));
    tempDirs.push(workspaceRoot);

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("<html><body><h1>Demo Page</h1><p>Hello web fetch.</p></body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" }
        })
      );

    const tools = createNativeToolSet(workspaceRoot, () => ["WebFetch"]);

    const fetchResult = await tools.WebFetch.execute(
      {
        url: "https://example.com/page",
        prompt: "Summarize the page"
      },
      {}
    );
    expect(String(fetchResult)).toContain("url: https://example.com/page");
    expect(String(fetchResult)).toContain("status_code: 200");
    expect(String(fetchResult)).toContain("result:");
    expect(String(fetchResult)).toContain("Prompt execution fallback:");
    expect(String(fetchResult)).toContain("Summarize the page");
    expect(String(fetchResult)).toContain("Demo Page");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports cross-host redirects instead of following them", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-web-redirect-"));
    tempDirs.push(workspaceRoot);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        statusText: "Found",
        headers: { location: "https://other.example/new-page" }
      })
    );

    const tools = createNativeToolSet(workspaceRoot, () => ["WebFetch"]);
    const result = String(
      await tools.WebFetch.execute(
        {
          url: "https://redirect.example.com/page",
          prompt: "Summarize the page"
        },
        {}
      )
    );

    expect(result).toContain("status_code: 302");
    expect(result).toContain("redirect_url: https://other.example/new-page");
    expect(result).toContain("The URL redirected to a different host");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows same-domain redirects including www host changes", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-web-same-domain-"));
    tempDirs.push(workspaceRoot);

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          statusText: "Moved Permanently",
          headers: { location: "https://www.example.com/page" }
        })
      )
      .mockResolvedValueOnce(
        new Response("<html><body><h1>Moved Page</h1></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" }
        })
      );

    const tools = createNativeToolSet(workspaceRoot, () => ["WebFetch"]);
    const result = String(
      await tools.WebFetch.execute(
        {
          url: "https://example.com/start",
          prompt: "Summarize the page"
        },
        {}
      )
    );

    expect(result).toContain("status_code: 200");
    expect(result).toContain("Moved Page");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]![0])).toBe("https://www.example.com/page");
  });

  it("rejects overly large web fetch responses", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-web-large-"));
    tempDirs.push(workspaceRoot);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("x".repeat(10 * 1024 * 1024 + 1), {
        status: 200,
        headers: { "content-type": "text/plain" }
      })
    );

    const tools = createNativeToolSet(workspaceRoot, () => ["WebFetch"]);
    await expect(
      tools.WebFetch.execute(
        {
          url: "https://example.com/huge",
          prompt: "Summarize the page"
        },
        {}
      )
    ).rejects.toMatchObject({ code: "native_tool_web_fetch_too_large" });
  });
});
