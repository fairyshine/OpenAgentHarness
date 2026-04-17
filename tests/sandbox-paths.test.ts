import { describe, expect, it } from "vitest";

import {
  SANDBOX_ROOT_PATH,
  buildSandboxApiPath,
  joinWorkspaceRelativePath,
  normalizeSandboxPath,
  normalizeWorkspaceRelativePath,
  parentWorkspaceRelativePath,
  sandboxPathToWorkspaceRelativePath,
  workspaceRelativePathToSandboxPath
} from "@oah/api-contracts";

describe("sandbox path helpers", () => {
  it("normalizes workspace-relative paths", () => {
    expect(normalizeWorkspaceRelativePath("./notes//hello.txt")).toBe("notes/hello.txt");
    expect(joinWorkspaceRelativePath("notes", "../todo.md")).toBe("todo.md");
    expect(parentWorkspaceRelativePath("notes/hello.txt")).toBe("notes");
    expect(parentWorkspaceRelativePath(".")).toBe(".");
  });

  it("maps workspace-relative paths into sandbox paths", () => {
    expect(workspaceRelativePathToSandboxPath(".")).toBe(SANDBOX_ROOT_PATH);
    expect(workspaceRelativePathToSandboxPath("notes/hello.txt")).toBe("/workspace/notes/hello.txt");
    expect(sandboxPathToWorkspaceRelativePath("/workspace")).toBe(".");
    expect(sandboxPathToWorkspaceRelativePath("/workspace/notes/hello.txt")).toBe("notes/hello.txt");
  });

  it("rejects sandbox paths outside the root", () => {
    expect(() => normalizeSandboxPath("/workspace/../secret.txt")).toThrow(/outside sandbox root/);
    expect(() => normalizeSandboxPath("../secret.txt")).toThrow(/outside sandbox root/);
  });

  it("builds sandbox api paths with encoding", () => {
    expect(buildSandboxApiPath("ws_test")).toBe("/api/v1/sandboxes/ws_test");
    expect(buildSandboxApiPath("ws/test", "/files/content")).toBe("/api/v1/sandboxes/ws%2Ftest/files/content");
  });
});
