import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPackagedWebUiServer } from "../apps/cli/src/web/dev-server.ts";

const tempRoots: string[] = [];
const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("packaged WebUI server", () => {
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("serves the WebUI bundle and proxies API requests with the daemon token", async () => {
    const staticRoot = await mkdtemp(path.join(os.tmpdir(), "oah-web-static-"));
    tempRoots.push(staticRoot);
    await mkdir(path.join(staticRoot, "assets"), { recursive: true });
    await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><main>OAH Web</main>", "utf8");
    await writeFile(path.join(staticRoot, "assets", "app.js"), "console.log('web');", "utf8");

    const backendRequests: Array<{ url: string; authorization?: string; body: string }> = [];
    const backendUrl = await listen(
      createServer(async (request, response) => {
        backendRequests.push({
          url: request.url ?? "",
          authorization: request.headers.authorization,
          body: await readRequestBody(request)
        });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true }));
      })
    );

    const webUrl = await listen(
      createPackagedWebUiServer({
        staticRoot,
        connection: {
          baseUrl: backendUrl,
          token: "local-token"
        },
        host: "127.0.0.1",
        port: 0
      })
    );

    const indexResponse = await fetch(`${webUrl}/`);
    const assetResponse = await fetch(`${webUrl}/assets/app.js`);
    const routeFallbackResponse = await fetch(`${webUrl}/workspace/demo`);
    const proxyResponse = await fetch(`${webUrl}/api/v1/workspaces`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ rootPath: "/tmp/demo" })
    });

    await expect(indexResponse.text()).resolves.toContain("OAH Web");
    await expect(assetResponse.text()).resolves.toContain("console.log");
    await expect(routeFallbackResponse.text()).resolves.toContain("OAH Web");
    await expect(proxyResponse.json()).resolves.toEqual({ ok: true });
    expect(backendRequests).toEqual([
      {
        url: "/api/v1/workspaces",
        authorization: "Bearer local-token",
        body: JSON.stringify({ rootPath: "/tmp/demo" })
      }
    ]);
  });

  it("keeps serving after an upstream streaming response is terminated", async () => {
    const staticRoot = await mkdtemp(path.join(os.tmpdir(), "oah-web-static-stream-"));
    tempRoots.push(staticRoot);
    await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><main>OAH Web</main>", "utf8");

    const backendUrl = await listen(
      createServer((request, response) => {
        if (request.url?.startsWith("/api/v1/sessions/")) {
          response.writeHead(200, {
            "content-type": "text/event-stream"
          });
          response.write("event: ping\ndata: {}\n\n");
          response.destroy(new Error("simulated upstream stream termination"));
          return;
        }

        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true }));
      })
    );

    const webUrl = await listen(
      createPackagedWebUiServer({
        staticRoot,
        connection: {
          baseUrl: backendUrl,
          token: "local-token"
        },
        host: "127.0.0.1",
        port: 0
      })
    );

    await fetch(`${webUrl}/api/v1/sessions/demo/events`).then((response) => response.text()).catch(() => "");
    const indexResponse = await fetch(`${webUrl}/`);

    await expect(indexResponse.text()).resolves.toContain("OAH Web");
  });
});
