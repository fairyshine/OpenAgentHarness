export type Notice = {
  level: "info" | "error";
  message: string;
};

export type ChatLine = {
  id: string;
  role: string;
  text: string;
  createdAt?: string;
  tone?: "normal" | "muted" | "error";
};

export type WorkspaceCreateField = "name" | "runtime" | "rootPath" | "ownerId" | "serviceName";

export type WorkspaceCreateDialog = {
  kind: "workspace-create";
  field: WorkspaceCreateField;
  name: string;
  runtime: string;
  rootPath: string;
  ownerId: string;
  serviceName: string;
};

export type Dialog =
  | { kind: "workspace-list"; selectedIndex: number }
  | WorkspaceCreateDialog
  | { kind: "session-list"; selectedIndex: number }
  | { kind: "session-create"; draft: string }
  | { kind: "help" };

export type VisibleWindow<T> = {
  items: T[];
  offset: number;
};
