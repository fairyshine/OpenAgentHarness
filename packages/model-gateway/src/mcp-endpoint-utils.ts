import { existsSync } from "node:fs";

const DEFAULT_DOCKER_HOST_ALIAS = "host.docker.internal";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function readDockerHostAlias(): string | undefined {
  const value = process.env.OAH_DOCKER_HOST_ALIAS?.trim();
  return value && value.length > 0 ? value : undefined;
}

function shouldRewriteLoopbackHostForContainer(): boolean {
  if (readDockerHostAlias()) {
    return true;
  }

  const runningInDocker = process.env.OAH_RUNNING_IN_DOCKER?.trim().toLowerCase();
  if (runningInDocker === "1" || runningInDocker === "true" || runningInDocker === "yes") {
    return true;
  }

  return existsSync("/.dockerenv");
}

export function resolveContainerHostAlias(): string {
  return readDockerHostAlias() ?? DEFAULT_DOCKER_HOST_ALIAS;
}

export function normalizeRemoteMcpUrl(rawUrl: string): string {
  if (!shouldRewriteLoopbackHostForContainer()) {
    return rawUrl;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !LOOPBACK_HOSTS.has(parsed.hostname)) {
    return rawUrl;
  }

  parsed.hostname = resolveContainerHostAlias();
  return parsed.toString();
}
