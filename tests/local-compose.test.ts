import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("local docker compose stack", () => {
  it("does not persist workspaces on the API service", async () => {
    const compose = await readFile(new URL("../docker-compose.local.yml", import.meta.url), "utf8");
    const apiStart = compose.indexOf("  oah-api:");
    const nextServiceStart = compose.indexOf("\n  oah-controller:", apiStart);
    expect(apiStart).toBeGreaterThanOrEqual(0);
    expect(nextServiceStart).toBeGreaterThan(apiStart);

    const apiService = compose.slice(apiStart, nextServiceStart);
    expect(apiService).not.toContain("/data/workspaces");
    expect(compose).not.toContain("oah-api-workspaces");
  });

  it("passes compose interpolation inputs into the remote scaler", async () => {
    const compose = await readFile(new URL("../docker-compose.local.yml", import.meta.url), "utf8");
    const scalerStart = compose.indexOf("  oah-compose-scaler:");
    const nextServiceStart = compose.indexOf("\n  oah-sandbox:", scalerStart);
    expect(scalerStart).toBeGreaterThanOrEqual(0);
    expect(nextServiceStart).toBeGreaterThan(scalerStart);

    const scalerService = compose.slice(scalerStart, nextServiceStart);
    for (const expected of [
      "COMPOSE_PROJECT_NAME: ${COMPOSE_PROJECT_NAME}",
      "OAH_DOCKER_API_CONFIG: ${OAH_DOCKER_API_CONFIG:?set OAH_DOCKER_API_CONFIG}",
      "OAH_DOCKER_CONTROLLER_CONFIG: ${OAH_DOCKER_CONTROLLER_CONFIG:?set OAH_DOCKER_CONTROLLER_CONFIG}",
      "OAH_DOCKER_SANDBOX_CONFIG: ${OAH_DOCKER_SANDBOX_CONFIG:?set OAH_DOCKER_SANDBOX_CONFIG}",
      "OAH_LOCAL_COMPOSE_SCALER_AUTH_TOKEN: ${OAH_LOCAL_COMPOSE_SCALER_AUTH_TOKEN}",
      "OAH_LOCAL_DEPLOY_ROOT: ${OAH_LOCAL_DEPLOY_ROOT:?set OAH_LOCAL_DEPLOY_ROOT}",
      "OAH_LOCAL_REPO_ROOT: ${OAH_LOCAL_REPO_ROOT:?set OAH_LOCAL_REPO_ROOT}"
    ]) {
      expect(scalerService).toContain(expected);
    }
  });
});
