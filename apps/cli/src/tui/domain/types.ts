import type {
  WorkspaceMemoryCorpus,
  WorkspaceMemoryFile,
  WorkspaceMemoryProposal,
  WorkspaceMemoryReadResponse,
  WorkspaceMemoryStatus
} from "@oah/api-contracts";

export type Notice = {
  level: "info" | "error";
  message: string;
};

export type ChatLine = {
  id: string;
  role: string;
  text: string;
  createdAt?: string | undefined;
  tone?: "normal" | "muted" | "error" | undefined;
  kind?: "message" | "tool" | "attachment" | "approval" | "system" | "reasoning" | undefined;
  title?: string | undefined;
  detail?: string | undefined;
  toolName?: string | undefined;
  toolCallId?: string | undefined;
  toolStatus?: "queued" | "running" | "completed" | "failed" | "denied" | "waiting" | undefined;
  toolInput?: unknown;
  toolOutput?: unknown;
  toolOutputText?: string | undefined;
  durationMs?: number | undefined;
  sourceType?: string | undefined;
  askUserQuestion?: AskUserQuestionPrompt | undefined;
};

export type AskUserQuestionPrompt = {
  questions: AskUserQuestionItem[];
};

export type AskUserQuestionSelection = {
  promptKey: string;
  questionIndex: number;
  optionIndex: number;
  selectedByQuestion: Record<number, string[]>;
};

export type AskUserQuestionItem = {
  question: string;
  header?: string | undefined;
  options?: AskUserQuestionOption[] | undefined;
  multiSelect?: boolean | undefined;
  freeText?: boolean | undefined;
};

export type AskUserQuestionOption = {
  label: string;
  description?: string | undefined;
};

export type WorkspaceCreateField = "name" | "runtime" | "rootPath" | "ownerId" | "serviceName";

export type SessionStartupMode = "resume" | "new";

export type WorkspaceCreateDialog = {
  kind: "workspace-create";
  field: WorkspaceCreateField;
  name: string;
  runtime: string;
  runtimeQuery: string;
  runtimeSelectedIndex: number;
  rootPath: string;
  ownerId: string;
  serviceName: string;
};

export type MemoryDialogMode = "files" | "proposals" | "detail";

export type MemoryDialog = {
  kind: "memory";
  mode: MemoryDialogMode;
  selectedIndex: number;
  query: string;
  corpus: WorkspaceMemoryCorpus;
  status: WorkspaceMemoryStatus | null;
  files: WorkspaceMemoryFile[];
  proposals: WorkspaceMemoryProposal[];
  detail: WorkspaceMemoryReadResponse | null;
  loading: boolean;
  error?: string | undefined;
};

export type Dialog =
  | { kind: "workspace-list"; selectedIndex: number }
  | WorkspaceCreateDialog
  | { kind: "session-list"; selectedIndex: number }
  | { kind: "session-create"; draft: string }
  | MemoryDialog
  | { kind: "help" };

export type VisibleWindow<T> = {
  items: T[];
  offset: number;
};
