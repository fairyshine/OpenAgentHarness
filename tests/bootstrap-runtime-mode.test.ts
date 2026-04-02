import { describe, expect, it } from "vitest";

import { describeRuntimeProcess, parseSingleWorkspaceOptions, shouldStartEmbeddedWorker } from "../apps/server/src/bootstrap.ts";

describe("server runtime process modes", () => {
  it("defaults the api process to an embedded worker", () => {
    expect(shouldStartEmbeddedWorker([])).toBe(true);
    expect(
      describeRuntimeProcess({
        processKind: "api",
        startWorker: true,
        hasRedisRunQueue: true
      })
    ).toEqual({
      mode: "api_embedded_worker",
      label: "API + embedded worker",
      execution: "redis_queue"
    });
  });

  it("supports explicit api-only mode without an embedded worker", () => {
    expect(shouldStartEmbeddedWorker(["--api-only"])).toBe(false);
    expect(
      describeRuntimeProcess({
        processKind: "api",
        startWorker: false,
        hasRedisRunQueue: true
      })
    ).toEqual({
      mode: "api_only",
      label: "API only",
      execution: "redis_queue"
    });
  });

  it("keeps local inline execution when api-only runs without redis", () => {
    expect(
      describeRuntimeProcess({
        processKind: "api",
        startWorker: false,
        hasRedisRunQueue: false
      })
    ).toEqual({
      mode: "api_only",
      label: "API only",
      execution: "local_inline"
    });
  });

  it("reports the standalone worker process distinctly", () => {
    expect(
      describeRuntimeProcess({
        processKind: "worker",
        startWorker: true,
        hasRedisRunQueue: true
      })
    ).toEqual({
      mode: "standalone_worker",
      label: "standalone worker",
      execution: "redis_queue"
    });
  });

  it("parses single-workspace startup flags", () => {
    expect(
      parseSingleWorkspaceOptions([
        "--workspace",
        "./demo",
        "--workspace-kind",
        "chat",
        "--model-dir",
        "./models",
        "--default-model",
        "openai-default",
        "--tool-dir",
        "./tools",
        "--skill-dir",
        "./skills",
        "--host",
        "127.0.0.1",
        "--port",
        "8788"
      ])
    ).toMatchObject({
      rootPath: expect.stringMatching(/demo$/),
      kind: "chat",
      modelDir: expect.stringMatching(/models$/),
      defaultModel: "openai-default",
      toolDir: expect.stringMatching(/tools$/),
      skillDir: expect.stringMatching(/skills$/),
      host: "127.0.0.1",
      port: 8788
    });
  });
});
