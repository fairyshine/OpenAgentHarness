import type {
  ActionRunAccepted,
  Message,
  MessageAccepted,
  MessagePage,
  Run,
  RunPage,
  RunStep,
  RunStepPage,
  Session,
  SessionEventContract,
  SessionPage,
  Workspace,
  WorkspaceCatalog,
  WorkspacePage
} from "@oah/api-contracts";

export type OahConnection = {
  baseUrl: string;
  token?: string;
};

export type SseFrame = {
  event: string;
  data: Record<string, unknown>;
  cursor?: string;
  createdAt?: string;
};

type RequestOptions = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
};

function joinUrl(baseUrl: string, path: string) {
  const trimmedBase = baseUrl.replace(/\/+$/u, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${normalizedPath}`;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
      detail = parsed.error?.message ?? parsed.message ?? text;
    } catch {
      // Keep the original response text.
    }
    throw new Error(`${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`);
  }

  if (!text.trim()) {
    return undefined as T;
  }

  return JSON.parse(text) as T;
}

export class OahApiClient {
  readonly #connection: OahConnection;

  constructor(connection: OahConnection) {
    const token = connection.token?.trim();
    this.#connection = token ? { baseUrl: connection.baseUrl, token } : { baseUrl: connection.baseUrl };
  }

  get baseUrl() {
    return this.#connection.baseUrl;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      ...options.headers
    };
    if (this.#connection.token) {
      headers.authorization = `Bearer ${this.#connection.token}`;
    }

    const response = await fetch(joinUrl(this.#connection.baseUrl, path), {
      ...options,
      headers
    });

    return readJsonResponse<T>(response);
  }

  async listAllWorkspaces(): Promise<Workspace[]> {
    const items: Workspace[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ pageSize: "200" });
      if (cursor) {
        query.set("cursor", cursor);
      }
      const page = await this.request<WorkspacePage>(`/api/v1/workspaces?${query.toString()}`);
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  }

  async createWorkspace(input: { name: string; runtime?: string; rootPath?: string }): Promise<Workspace> {
    return this.request<Workspace>("/api/v1/workspaces", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name: input.name,
        runtime: input.runtime ?? "local",
        ...(input.rootPath ? { rootPath: input.rootPath } : {})
      })
    });
  }

  async getWorkspaceCatalog(workspaceId: string): Promise<WorkspaceCatalog> {
    return this.request<WorkspaceCatalog>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/catalog`);
  }

  async listWorkspaceSessions(workspaceId: string): Promise<Session[]> {
    const page = await this.request<SessionPage>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/sessions?pageSize=40`);
    return page.items;
  }

  async createSession(workspaceId: string, input: { title?: string; agentName?: string; modelRef?: string }): Promise<Session> {
    return this.request<Session>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(input)
    });
  }

  async listSessionMessages(sessionId: string): Promise<Message[]> {
    const page = await this.request<MessagePage>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages?pageSize=80&direction=backward`
    );
    return page.items;
  }

  async listSessionRuns(sessionId: string): Promise<Run[]> {
    const page = await this.request<RunPage>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/runs?pageSize=80`);
    return page.items;
  }

  async listRunSteps(runId: string): Promise<RunStep[]> {
    const page = await this.request<RunStepPage>(`/api/v1/runs/${encodeURIComponent(runId)}/steps?pageSize=120`);
    return page.items;
  }

  async sendMessage(sessionId: string, content: string, runningRunBehavior: "queue" | "interrupt" = "queue"): Promise<MessageAccepted> {
    return this.request<MessageAccepted>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        content,
        runningRunBehavior
      })
    });
  }

  async runAction(workspaceId: string, actionName: string, input: unknown, sessionId?: string): Promise<ActionRunAccepted> {
    return this.request<ActionRunAccepted>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/actions/${encodeURIComponent(actionName)}/runs`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input,
          ...(sessionId ? { sessionId } : {}),
          triggerSource: "user"
        })
      }
    );
  }

  async streamSessionEvents(
    sessionId: string,
    options: {
      cursor?: string;
      signal: AbortSignal;
      onEvent: (event: SessionEventContract) => void;
    }
  ): Promise<void> {
    const query = new URLSearchParams();
    if (options.cursor) {
      query.set("cursor", options.cursor);
    }

    const headers: Record<string, string> = {};
    if (this.#connection.token) {
      headers.authorization = `Bearer ${this.#connection.token}`;
    }

    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const response = await fetch(joinUrl(this.#connection.baseUrl, `/api/v1/sessions/${encodeURIComponent(sessionId)}/events${suffix}`), {
      headers,
      signal: options.signal
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    await consumeSse(response, (frame) => {
      const event = {
        id: `${sessionId}:${frame.cursor ?? Date.now()}`,
        cursor: frame.cursor ?? "",
        sessionId,
        event: frame.event,
        data: frame.data,
        createdAt: frame.createdAt ?? new Date().toISOString(),
        ...(typeof frame.data.runId === "string" ? { runId: frame.data.runId } : {})
      } as SessionEventContract;
      options.onEvent(event);
    }, options.signal);
  }
}

export async function consumeSse(response: Response, onFrame: (frame: SseFrame) => void, signal: AbortSignal): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("SSE response body is not readable.");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      const lines = chunk.split("\n");
      let event = "message";
      let cursor: string | undefined;
      let createdAt: string | undefined;
      const dataLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
          continue;
        }
        if (line.startsWith("id:")) {
          cursor = line.slice(3).trim();
          continue;
        }
        if (line.startsWith("createdAt:")) {
          createdAt = line.slice("createdAt:".length).trim();
          continue;
        }
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        }
      }

      if (dataLines.length === 0) {
        continue;
      }

      onFrame({
        event,
        data: JSON.parse(dataLines.join("\n")) as Record<string, unknown>,
        ...(cursor ? { cursor } : {}),
        ...(createdAt ? { createdAt } : {})
      });
    }
  }
}

export function formatWorkspaceLine(workspace: Workspace): string {
  const readonly = workspace.readOnly ? "ro" : "rw";
  const runtime = workspace.runtime ? ` ${workspace.runtime}` : "";
  return `${workspace.id}\t${workspace.name}\t${workspace.kind}/${workspace.executionPolicy}/${readonly}${runtime}\t${workspace.rootPath}`;
}
