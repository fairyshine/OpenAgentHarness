import type { WorkspaceRuntime } from "@oah/api-contracts";

import type { WorkspaceCreateDialog, WorkspaceCreateField } from "./types.js";

const WORKSPACE_CREATE_FIELDS: WorkspaceCreateField[] = ["name", "runtime", "rootPath", "ownerId", "serviceName"];

export function createWorkspaceDialog(defaultRuntime: string | undefined, runtimes: WorkspaceRuntime[] = []): WorkspaceCreateDialog {
  const runtime = defaultRuntime ?? "";
  const runtimeSelectedIndex = Math.max(
    0,
    runtimes.findIndex((item) => item.name === runtime)
  );
  return {
    kind: "workspace-create",
    field: "name",
    name: "",
    runtime,
    runtimeQuery: "",
    runtimeSelectedIndex,
    rootPath: "",
    ownerId: "",
    serviceName: ""
  };
}

export function moveWorkspaceCreateField(field: WorkspaceCreateField, delta: number) {
  const index = WORKSPACE_CREATE_FIELDS.indexOf(field);
  return WORKSPACE_CREATE_FIELDS[(index + delta + WORKSPACE_CREATE_FIELDS.length) % WORKSPACE_CREATE_FIELDS.length] ?? field;
}

export function cycleRuntime(currentRuntime: string, runtimes: WorkspaceRuntime[], delta: number) {
  if (runtimes.length === 0) {
    return currentRuntime;
  }
  const currentIndex = Math.max(0, runtimes.findIndex((runtime) => runtime.name === currentRuntime));
  return runtimes[(currentIndex + delta + runtimes.length) % runtimes.length]?.name ?? currentRuntime;
}
