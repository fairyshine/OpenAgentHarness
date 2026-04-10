import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createNativeToolSet } from "../packages/runtime-core/src/native-tools.ts";

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
  it("executes Title Case workspace tools", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-title-case-"));
    tempDirs.push(workspaceRoot);

    await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const answer = 41;\n", "utf8");

    const tools = createNativeToolSet(
      workspaceRoot,
      () => ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "TodoWrite"],
      { sessionId: "session-title-case" }
    );

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

    const globResult = await tools.Glob.execute({ pattern: "**/*.ts" }, {});
    expect(String(globResult)).toContain("files:");
    expect(String(globResult)).toContain("src/app.ts");

    const grepResult = await tools.Grep.execute({ pattern: "answer", path: "src", output_mode: "content" }, {});
    expect(String(grepResult)).toContain('src/app.ts:1:export const answer = 42;');

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

  it("supports Bash run_in_background with a readable output file", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-background-"));
    tempDirs.push(workspaceRoot);

    const tools = createNativeToolSet(workspaceRoot, () => ["Bash", "Read"], {
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
    for (let attempt = 0; attempt < 20; attempt += 1) {
      output = await readFile(path.join(workspaceRoot, outputPath), "utf8").catch(() => "");
      if (output.includes("background-ok")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(output).toContain("background-ok");
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
});
