import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  daemonStatus,
  initDaemonHome,
  readDaemonLogs,
  readDaemonModelConfigWarning,
  resolveOahHome
} from "../apps/cli/src/daemon/lifecycle.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("OAP daemon lifecycle helpers", () => {
  it("keeps OAH_INSTALL_ROOT as a deprecated daemon home fallback when OAH_HOME is unset", async () => {
    const installRoot = await mkdtemp(path.join(os.tmpdir(), "oah-install-root-home-"));
    tempDirs.push(installRoot);
    const previousHome = process.env.OAH_HOME;
    const previousInstallRoot = process.env.OAH_INSTALL_ROOT;
    delete process.env.OAH_HOME;
    process.env.OAH_INSTALL_ROOT = installRoot;
    try {
      expect(resolveOahHome()).toBe(installRoot);
    } finally {
      if (previousHome === undefined) {
        delete process.env.OAH_HOME;
      } else {
        process.env.OAH_HOME = previousHome;
      }
      if (previousInstallRoot === undefined) {
        delete process.env.OAH_INSTALL_ROOT;
      } else {
        process.env.OAH_INSTALL_ROOT = previousInstallRoot;
      }
    }
  });

  it("initializes OAH_HOME from the deploy-root template without overwriting user config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "oah-daemon-home-"));
    tempDirs.push(home);

    const first = await initDaemonHome({ home });
    const initialToken = await readFile(first.tokenPath, "utf8");
    await writeFile(first.configPath, "server:\n  host: 127.0.0.1\n  port: 18788\n", "utf8");

    const second = await initDaemonHome({ home });

    expect(second.home).toBe(home);
    expect(await readFile(second.configPath, "utf8")).toBe("server:\n  host: 127.0.0.1\n  port: 18788\n");
    expect(await readFile(path.join(home, "models", "openai-default.yaml"), "utf8")).toContain("openai-default:");
    expect(await readFile(path.join(home, "runtimes", "vibe-coding", ".openharness", "settings.yaml"), "utf8")).toContain(
      "default_agent: build"
    );
    expect(await readFile(second.tokenPath, "utf8")).toBe(initialToken);
    expect(await readFile(path.join(home, ".oah-home-version"), "utf8")).toBe("1\n");
  });

  it("can initialize OAH_HOME from packaged deploy-root assets", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-daemon-packaged-"));
    tempDirs.push(tempDir);
    const templateRoot = path.join(tempDir, "deploy-root");
    const home = path.join(tempDir, "home");
    await mkdir(path.join(templateRoot, "config"), { recursive: true });
    await mkdir(path.join(templateRoot, "skills"), { recursive: true });
    await writeFile(path.join(templateRoot, "README.md"), "packaged template\n", "utf8");
    await writeFile(path.join(templateRoot, "skills", "README.md"), "skills template\n", "utf8");
    await writeFile(path.join(templateRoot, "config", "daemon.yaml"), "server:\n  host: 127.0.0.1\n  port: 18799\n", "utf8");

    const previousTemplate = process.env.OAH_DEPLOY_ROOT_TEMPLATE;
    process.env.OAH_DEPLOY_ROOT_TEMPLATE = templateRoot;
    try {
      await initDaemonHome({ home });
    } finally {
      if (previousTemplate === undefined) {
        delete process.env.OAH_DEPLOY_ROOT_TEMPLATE;
      } else {
        process.env.OAH_DEPLOY_ROOT_TEMPLATE = previousTemplate;
      }
    }

    await expect(access(path.join(home, "README.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(home, "skills", "README.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(home, "config", "daemon.yaml"), "utf8")).toContain("18799");
  });

  it("warns when the configured default model is missing", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "oah-daemon-model-warning-"));
    tempDirs.push(home);

    const paths = await initDaemonHome({ home });
    const config = await readFile(paths.configPath, "utf8");
    await writeFile(paths.configPath, config.replace("default_model: openai-default", "default_model: missing-model"), "utf8");

    await expect(readDaemonModelConfigWarning({ home })).resolves.toContain('Default model "missing-model" was not found');
  });

  it("warns when no platform models can be loaded", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "oah-daemon-no-models-"));
    tempDirs.push(home);

    const paths = await initDaemonHome({ home });
    const config = await readFile(paths.configPath, "utf8");
    await mkdir(path.join(home, "empty-models"), { recursive: true });
    await writeFile(paths.configPath, config.replace("model_dir: ../models", "model_dir: ../empty-models"), "utf8");

    await expect(readDaemonModelConfigWarning({ home })).resolves.toContain("No platform models were loaded");
  });

  it("removes previously copied template README files without deleting user README content", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oah-daemon-readmes-"));
    tempDirs.push(tempDir);
    const templateRoot = path.join(tempDir, "deploy-root");
    const home = path.join(tempDir, "home");
    await mkdir(path.join(templateRoot, "config"), { recursive: true });
    await mkdir(path.join(templateRoot, "tools"), { recursive: true });
    await mkdir(path.join(home, "tools"), { recursive: true });
    await mkdir(path.join(home, "skills"), { recursive: true });
    await writeFile(path.join(templateRoot, "README.md"), "root template\n", "utf8");
    await writeFile(path.join(templateRoot, "tools", "README.md"), "tools template\n", "utf8");
    await writeFile(path.join(templateRoot, "config", "daemon.yaml"), "server:\n  host: 127.0.0.1\n  port: 18799\n", "utf8");
    await writeFile(path.join(home, "README.md"), "root template\n", "utf8");
    await writeFile(path.join(home, "tools", "README.md"), "tools template\n", "utf8");
    await writeFile(path.join(home, "skills", "README.md"), "custom user notes\n", "utf8");

    const previousTemplate = process.env.OAH_DEPLOY_ROOT_TEMPLATE;
    process.env.OAH_DEPLOY_ROOT_TEMPLATE = templateRoot;
    try {
      await initDaemonHome({ home });
    } finally {
      if (previousTemplate === undefined) {
        delete process.env.OAH_DEPLOY_ROOT_TEMPLATE;
      } else {
        process.env.OAH_DEPLOY_ROOT_TEMPLATE = previousTemplate;
      }
    }

    await expect(access(path.join(home, "README.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(home, "tools", "README.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(home, "skills", "README.md"), "utf8")).toBe("custom user notes\n");
  });

  it("reports stale PID files without probing the server endpoint", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "oah-daemon-stale-"));
    tempDirs.push(home);
    await initDaemonHome({ home });
    await writeFile(path.join(home, "run", "daemon.pid"), "not-a-pid\n", "utf8");

    await expect(daemonStatus({ home })).resolves.toContain("stale PID file");
  });

  it("reads the requested tail of the daemon log", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "oah-daemon-logs-"));
    tempDirs.push(home);
    await initDaemonHome({ home });
    await mkdir(path.join(home, "logs"), { recursive: true });
    await writeFile(path.join(home, "logs", "daemon.log"), "one\ntwo\nthree\n", "utf8");

    await expect(readDaemonLogs({ home, lines: 2 })).resolves.toBe("three\n");
  });
});
