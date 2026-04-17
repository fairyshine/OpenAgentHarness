import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type APIRequestContext } from "@playwright/test";

const API_BASE_URL = "http://127.0.0.1:8797";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANAGED_WORKSPACE_ROOT = path.resolve(__dirname, "..", ".runtime", "workspaces");

async function createSmokeSession(request: APIRequestContext) {
  const suffix = Date.now().toString(36);
  await mkdir(MANAGED_WORKSPACE_ROOT, { recursive: true });
  const rootPath = await mkdtemp(path.join(MANAGED_WORKSPACE_ROOT, `smoke-${suffix}-`));
  const workspaceResponse = await request.post(`${API_BASE_URL}/api/v1/workspaces/import`, {
    data: {
      name: `smoke-workspace-${suffix}`,
      rootPath
    }
  });
  expect(workspaceResponse.ok()).toBeTruthy();
  const workspace = (await workspaceResponse.json()) as { id: string; name: string };

  const sessionResponse = await request.post(`${API_BASE_URL}/api/v1/workspaces/${workspace.id}/sessions`, {
    data: {
      title: `Smoke Session ${suffix}`
    }
  });
  expect(sessionResponse.ok()).toBeTruthy();
  const session = (await sessionResponse.json()) as { id: string; title?: string };

  return { workspace, session };
}

test.describe("web app smoke", () => {
  test("app shell renders without crashing", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Open Agent Harness").first()).toBeVisible();
    await expect(page.getByRole("tab", { name: "Runtime" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Provider" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Storage" })).toBeVisible();
  });

  test("pinging health through the vite proxy reaches the backend", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("tab", { name: "Provider" }).click();

    const baseUrlInput = page.getByPlaceholder("Base URL");
    await expect(baseUrlInput).toBeVisible();
    await baseUrlInput.fill("");

    const healthRequest = page.waitForResponse(
      (response) => response.url().endsWith("/healthz") && response.status() === 200
    );
    await page.getByRole("main").getByRole("button", { name: "Health" }).click();
    await healthRequest;

    await expect(page.getByText(/health ok/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test("streaming chat roundtrip works with the mock local model", async ({ page, request }) => {
    const { workspace, session } = await createSmokeSession(request);
    const prompt = `playwright smoke ${Date.now().toString(36)}`;

    await page.goto("/");
    await expect(page.getByText(workspace.name).first()).toBeVisible({ timeout: 10_000 });
    await page.getByText(workspace.name).first().click();
    await expect(page.getByText(session.title ?? "Untitled session").first()).toBeVisible({ timeout: 10_000 });
    await page.getByText(session.title ?? "Untitled session").first().click();

    const composer = page.locator("textarea").last();
    await expect(composer).toBeVisible();
    await composer.fill(prompt);
    await page.getByTitle("Send message").click();

    await expect(page.getByText(`Mock reply: ${prompt}`).first()).toBeVisible({ timeout: 15_000 });
  });
});
