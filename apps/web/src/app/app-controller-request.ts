import type { Message, MessagePage } from "@oah/api-contracts";

import {
  buildUrl,
  createHttpRequestError,
  mergeSessionMessages,
  readJsonResponse,
  type ConnectionSettings
} from "./support";
import { buildMessagePagePath } from "./app-controller-utils";

export async function appControllerRequest<T>(
  connection: ConnectionSettings,
  requestPath: string,
  init?: RequestInit,
  options?: { auth?: boolean }
) {
  const headers = new Headers(init?.headers);
  const authRequired = options?.auth ?? true;
  const token = connection.token.trim();

  if (authRequired && token) {
    headers.set("authorization", `Bearer ${token}`);
  }

  const response = await fetch(buildUrl(connection.baseUrl, requestPath), {
    ...init,
    headers
  });

  if (!response.ok) {
    throw await createHttpRequestError(response);
  }

  return readJsonResponse<T>(response);
}

export async function listAllSessionMessages(input: {
  request: <T>(path: string, init?: RequestInit, options?: { auth?: boolean }) => Promise<T>;
  sessionId: string;
}): Promise<Message[]> {
  let cursor: string | undefined;
  let allMessages: Message[] = [];

  while (true) {
    const page = await input.request<MessagePage>(
      buildMessagePagePath(input.sessionId, { cursor, direction: "forward" })
    );
    allMessages = mergeSessionMessages(allMessages, page.items);
    if (!page.nextCursor) {
      return allMessages;
    }
    cursor = page.nextCursor;
  }
}
