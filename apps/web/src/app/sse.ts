import type { SseFrame } from "./support-types";

async function consumeSse(
  response: Response,
  onFrame: (frame: SseFrame) => void,
  signal: AbortSignal
): Promise<void> {
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

export { consumeSse };
