import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  memoryApplyProposal,
  memoryGet,
  memoryIndex,
  memoryProposals,
  memoryRejectProposal,
  memorySearch,
  memoryStatus
} from "../apps/cli/src/cli/memory.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

describe("CLI memory commands", () => {
  it("reports, indexes, searches, and reads local workspace memory", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-cli-memory-"));
    tempDirs.push(workspaceRoot);

    await mkdir(path.join(workspaceRoot, ".openharness", "memory", "topics", "feedback"), { recursive: true });
    await mkdir(path.join(workspaceRoot, ".openharness", "memory", "daily"), { recursive: true });
    await mkdir(path.join(workspaceRoot, ".openharness", "memory", "proposals"), { recursive: true });
    await writeFile(
      path.join(workspaceRoot, ".openharness", "settings.yaml"),
      "engine:\n  workspace_memory:\n    enabled: true\n    write_policy: explicit-only\n",
      "utf8"
    );
    await writeFile(
      path.join(workspaceRoot, ".openharness", "memory", "MEMORY.md"),
      "- [Database testing](.openharness/memory/topics/feedback/database-testing.md) - use real DB tests\n",
      "utf8"
    );
    await writeFile(
      path.join(workspaceRoot, ".openharness", "memory", "topics", "feedback", "database-testing.md"),
      [
        "---",
        "name: Database testing",
        "description: Use real database integration tests.",
        "type: feedback",
        "---",
        "",
        "Prefer real database integration tests over mocks."
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(workspaceRoot, ".openharness", "memory", "proposals", "pending.md"),
      [
        "---",
        "status: \"pending\"",
        "tool: \"MemoryRemember\"",
        "target_path: \".openharness/memory/topics/project/project-decision.md\"",
        "created_at: \"2026-05-15T08:00:00.000Z\"",
        "---",
        "",
        "Pending proposal should not be indexed as confirmed memory."
      ].join("\n"),
      "utf8"
    );

    const status = await memoryStatus({ workspace: workspaceRoot });
    expect(status).toContain("workspace_memory_enabled: true");
    expect(status).toContain("write_policy: explicit-only");
    expect(status).toContain("files: 2");
    expect(status).toContain("topics: 1");
    expect(status).toContain("pending_proposals: 1");

    const index = await memoryIndex({ workspace: workspaceRoot });
    expect(index).toContain(".openharness/memory/topics/feedback/database-testing.md");
    expect(index).toContain("title: Database testing");
    expect(index).not.toContain(".openharness/memory/proposals/pending.md");

    const search = await memorySearch("database integration", { workspace: workspaceRoot, corpus: "topics" });
    expect(search).toContain(".openharness/memory/topics/feedback/database-testing.md");
    expect(search).toContain("Use real database integration tests.");

    const proposalSearch = await memorySearch("Pending proposal", { workspace: workspaceRoot });
    expect(proposalSearch).toBe("No matching memory files found.");

    const proposals = await memoryProposals({ workspace: workspaceRoot });
    expect(proposals).toContain(".openharness/memory/proposals/pending.md");
    expect(proposals).toContain("status: pending");
    expect(proposals).toContain("tool: MemoryRemember");
    expect(proposals).toContain("target: .openharness/memory/topics/project/project-decision.md");

    const content = await memoryGet(".openharness/memory/topics/feedback/database-testing.md", {
      workspace: workspaceRoot,
      from: 7,
      lines: 1
    });
    expect(content).toBe("7: Prefer real database integration tests over mocks.");
  });

  it("applies and rejects local workspace memory proposals", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-cli-memory-proposals-"));
    tempDirs.push(workspaceRoot);

    await mkdir(path.join(workspaceRoot, ".openharness", "memory", "proposals"), { recursive: true });
    await writeFile(
      path.join(workspaceRoot, ".openharness", "memory", "proposals", "remember.md"),
      [
        "---",
        "status: \"pending\"",
        "tool: \"MemoryRemember\"",
        "target_path: \".openharness/memory/topics/project/project-decision.md\"",
        "created_at: \"2026-05-15T08:00:00.000Z\"",
        "---",
        "",
        "# Memory Proposal remember",
        "",
        "```json",
        JSON.stringify(
          {
            type: "project",
            title: "Project decision",
            content: "Use the workspace memory proposal apply flow."
          },
          null,
          2
        ),
        "```",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(workspaceRoot, ".openharness", "memory", "proposals", "reject.md"),
      [
        "---",
        "status: \"pending\"",
        "tool: \"MemoryRemember\"",
        "target_path: \".openharness/memory/topics/project/rejected.md\"",
        "created_at: \"2026-05-15T09:00:00.000Z\"",
        "---",
        "",
        "# Memory Proposal reject",
        "",
        "```json",
        JSON.stringify(
          {
            type: "project",
            title: "Rejected",
            content: "Do not apply this."
          },
          null,
          2
        ),
        "```",
        ""
      ].join("\n"),
      "utf8"
    );

    const applyResult = await memoryApplyProposal(".openharness/memory/proposals/remember.md", { workspace: workspaceRoot });
    expect(applyResult).toContain("proposal_status: applied");
    await expect(
      memoryGet(".openharness/memory/topics/project/project-decision.md", {
        workspace: workspaceRoot,
        from: 7,
        lines: 1
      })
    ).resolves.toContain("Use the workspace memory proposal apply flow.");

    const rejectResult = await memoryRejectProposal(".openharness/memory/proposals/reject.md", {
      workspace: workspaceRoot,
      reason: "Not durable."
    });
    expect(rejectResult).toContain("proposal_status: rejected");
    await expect(memoryGet(".openharness/memory/topics/project/rejected.md", { workspace: workspaceRoot })).rejects.toThrow();

    const proposals = await memoryProposals({ workspace: workspaceRoot });
    expect(proposals).toBe("No pending memory proposals found.");
  });
});
