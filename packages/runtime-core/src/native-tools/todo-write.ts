import path from "node:path";

import { z } from "zod";

import { formatToolOutput } from "../tool-output.js";
import type { RuntimeToolSet } from "../types.js";
import { ensureParentDirectory, readJsonFile } from "./fs-utils.js";
import { normalizePathForMatch } from "./paths.js";
import { getNativeToolRetryPolicy, type NativeToolFactoryContext } from "./types.js";

const TODO_WRITE_DESCRIPTION =
  "Update the todo list for the current session. Use statuses pending, in_progress, and completed. Always provide both content and activeForm for each item. Prefer keeping at least one item in_progress while work remains.";

const todoItemSchema = z.object({
  content: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed"]),
  activeForm: z.string().min(1)
});

type TodoItem = z.infer<typeof todoItemSchema>;

const TodoWriteInputSchema = z
  .object({
    todos: z.array(todoItemSchema).describe("The updated todo list")
  })
  .strict();

export function createTodoWriteTool(context: NativeToolFactoryContext): RuntimeToolSet {
  return {
    TodoWrite: {
      description: TODO_WRITE_DESCRIPTION,
      retryPolicy: getNativeToolRetryPolicy("TodoWrite"),
      inputSchema: TodoWriteInputSchema,
      async execute(rawInput) {
        context.assertVisible("TodoWrite");
        const normalizedInput =
          rawInput && typeof rawInput === "object" && rawInput !== null
            ? {
                ...((rawInput as Record<string, unknown>) ?? {}),
                todos: Array.isArray((rawInput as Record<string, unknown>).todos)
                  ? ((rawInput as Record<string, unknown>).todos as Array<Record<string, unknown>>).map((todo) => ({
                      activeForm:
                        typeof todo.activeForm === "string"
                          ? todo.activeForm
                          : typeof todo.content === "string"
                            ? todo.content
                            : "",
                      ...todo
                    }))
                  : (rawInput as Record<string, unknown>).todos
              }
            : rawInput;
        const input = TodoWriteInputSchema.parse(normalizedInput);
        const oldTodos = await readJsonFile<TodoItem[]>(context.fileSystem, context.todoPath, []);
        const allCompleted = input.todos.length > 0 && input.todos.every((todo) => todo.status === "completed");

        const persistedTodos = allCompleted ? [] : input.todos;
        await ensureParentDirectory(context.fileSystem, context.todoPath);
        await context.fileSystem.writeFile(context.todoPath, Buffer.from(JSON.stringify(persistedTodos, null, 2), "utf8"));

        return formatToolOutput(
          [
            ["todo_path", normalizePathForMatch(path.relative(context.workspaceRoot, context.todoPath))],
            ["remaining", persistedTodos.filter((todo) => todo.status !== "completed").length]
          ],
          [
            {
              title: "todos",
              lines: input.todos.map((todo) => `${todo.status}: ${todo.content}`),
              emptyText: "(none)"
            },
            {
              title: "previous_todos",
              lines: oldTodos.map((todo) => `${todo.status}: ${todo.content}`),
              emptyText: "(none)"
            }
          ]
        );
      }
    }
  };
}
