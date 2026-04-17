import http from "node:http";

const port = 8798;

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function readPromptText(payload) {
  if (typeof payload?.prompt === "string" && payload.prompt.trim()) {
    return payload.prompt.trim();
  }

  const lastMessage = Array.isArray(payload?.messages) ? payload.messages.at(-1) : undefined;
  const content = lastMessage?.content;
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("")
      .trim();
    if (text) {
      return text;
    }
  }

  return "hello";
}

function buildReply(payload) {
  const model = typeof payload?.model === "string" && payload.model.trim() ? payload.model : "mock-local";
  const prompt = readPromptText(payload);
  return { model, text: `Mock reply: ${prompt}` };
}

http
  .createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      sendJson(response, 200, {
        object: "list",
        data: [{ id: "mock-local", object: "model", created: 0, owned_by: "open-agent-harness" }]
      });
      return;
    }

    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      sendJson(response, 404, { error: { message: "Not found" } });
      return;
    }

    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const payload = body ? JSON.parse(body) : {};
      const reply = buildReply(payload);
      if (payload.stream) {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive"
        });
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion.chunk",
            created: 0,
            model: reply.model,
            choices: [{ index: 0, delta: { role: "assistant", content: reply.text }, finish_reason: null }]
          })}\n\n`
        );
        response.end(
          `data: ${JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion.chunk",
            created: 0,
            model: reply.model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
          })}\n\ndata: [DONE]\n\n`
        );
        return;
      }

      sendJson(response, 200, {
        id: "chatcmpl-mock",
        object: "chat.completion",
        created: 0,
        model: reply.model,
        choices: [{ index: 0, message: { role: "assistant", content: reply.text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 }
      });
    });
  })
  .listen(port, "127.0.0.1");
