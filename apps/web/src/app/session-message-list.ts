import type { Message } from "@oah/api-contracts";

function countMessagesByRole(messages: Array<{ role: Message["role"] }>) {
  const counts = {
    system: 0,
    user: 0,
    assistant: 0,
    tool: 0
  };

  for (const message of messages) {
    switch (message.role) {
      case "system":
        counts.system += 1;
        break;
      case "user":
        counts.user += 1;
        break;
      case "assistant":
        counts.assistant += 1;
        break;
      case "tool":
        counts.tool += 1;
        break;
    }
  }

  return counts;
}

function parseComparableMessageTimestamp(value: string | undefined) {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

function compareMessagesChronologically(left: Pick<Message, "createdAt" | "id">, right: Pick<Message, "createdAt" | "id">) {
  const leftValue = parseComparableMessageTimestamp(left.createdAt);
  const rightValue = parseComparableMessageTimestamp(right.createdAt);
  const timestampComparison =
    Number.isFinite(leftValue) && Number.isFinite(rightValue) ? leftValue - rightValue : 0;

  if (timestampComparison !== 0) {
    return timestampComparison;
  }

  return left.id.localeCompare(right.id);
}

function findChronologicalMessageInsertIndex(messages: Message[], incoming: Message) {
  let low = 0;
  let high = messages.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = messages[middle];
    if (!candidate) {
      break;
    }

    if (compareMessagesChronologically(candidate, incoming) <= 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
}

function upsertSessionMessage(current: Message[], incoming: Message) {
  let existingIndex = -1;
  for (let index = 0; index < current.length; index += 1) {
    if (current[index]?.id === incoming.id) {
      existingIndex = index;
      break;
    }
  }

  if (existingIndex >= 0) {
    if (Object.is(current[existingIndex], incoming)) {
      return current;
    }

    const next = [...current];
    const currentMessage = next[existingIndex];
    if (!currentMessage) {
      return current;
    }

    next[existingIndex] = incoming;
    if (compareMessagesChronologically(currentMessage, incoming) === 0) {
      return next;
    }

    next.splice(existingIndex, 1);
    const insertIndex = findChronologicalMessageInsertIndex(next, incoming);
    next.splice(insertIndex, 0, incoming);
    return next;
  }

  const insertIndex = findChronologicalMessageInsertIndex(current, incoming);
  if (insertIndex >= current.length) {
    return [...current, incoming];
  }

  const next = [...current];
  next.splice(insertIndex, 0, incoming);
  return next;
}

function mergeSessionMessages(current: Message[], incoming: Message[]) {
  if (incoming.length === 0) {
    return current;
  }

  if (current.length === 0) {
    return incoming.length <= 1 ? incoming : [...incoming].sort(compareMessagesChronologically);
  }

  const indexById = new Map<string, number>();
  for (let index = 0; index < current.length; index += 1) {
    const message = current[index];
    if (message) {
      indexById.set(message.id, index);
    }
  }

  let next = current;
  let hasUpdates = false;
  let requiresResort = false;
  let hasInsertions = false;

  for (const message of incoming) {
    const existingIndex = indexById.get(message.id);
    if (existingIndex === undefined) {
      hasInsertions = true;
      continue;
    }

    if (Object.is(current[existingIndex], message)) {
      continue;
    }

    if (next === current) {
      next = [...current];
    }
    next[existingIndex] = message;
    hasUpdates = true;

    const currentMessage = current[existingIndex];
    if (currentMessage && compareMessagesChronologically(currentMessage, message) !== 0) {
      requiresResort = true;
    }
  }

  if (!hasInsertions) {
    if (!hasUpdates) {
      return current;
    }

    return requiresResort ? [...next].sort(compareMessagesChronologically) : next;
  }

  const mergedById = new Map<string, Message>();
  for (const message of next) {
    mergedById.set(message.id, message);
  }
  for (const message of incoming) {
    mergedById.set(message.id, message);
  }

  return [...mergedById.values()].sort(compareMessagesChronologically);
}

function inferCompletedMessageRole(data: Record<string, unknown>): Message["role"] {
  if (data.role === "system") {
    return "system";
  }
  if (data.role === "user") {
    return "user";
  }
  if (data.role === "assistant") {
    return "assistant";
  }
  if (data.role === "tool") {
    return "tool";
  }

  return typeof data.toolName === "string" && typeof data.toolCallId === "string" ? "tool" : "assistant";
}

export {
  compareMessagesChronologically,
  countMessagesByRole,
  inferCompletedMessageRole,
  mergeSessionMessages,
  upsertSessionMessage
};
