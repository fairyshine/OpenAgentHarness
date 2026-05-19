import { useEffect, useState, type FormEvent } from "react";

import { Check, FileText, RefreshCw, Search, X } from "lucide-react";

import type { Run, Session, Workspace, WorkspaceCatalog, WorkspaceMemoryCorpus } from "@oah/api-contracts";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";

import { formatTimestamp, type ModelCallTraceEngineTool, type ModelCallTraceToolServer } from "../support";
import { CatalogLine, EmptyState, EntityPreview, InsightRow, InspectorTabButton, JsonBlock } from "../primitives";
import type { WorkspaceMemoryController } from "../use-workspace-memory";
import {
  buildStructuredActionInput,
  deriveStructuredActionInputSpec,
  initializeStructuredActionInputValues
} from "../action-input-form";

import {
  ACTION_INPUT_UNSET_VALUE,
  DetailSection,
  InspectorDisclosure,
  InspectorPanelHeader,
  ToolSnapshotBrowser,
  TraceSummaryStat
} from "./shared";
import { OverviewRecordsCard } from "./overview-workbench";

function WorkspaceCatalogCollection(props: {
  title: string;
  description: string;
  items: unknown[];
}) {
  return (
    <InspectorDisclosure title={props.title} description={props.description} badge={props.items.length}>
      {props.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No records available.</p>
      ) : (
        <EntityPreview title={props.title} data={props.items} />
      )}
    </InspectorDisclosure>
  );
}

const MEMORY_CORPUS_OPTIONS: WorkspaceMemoryCorpus[] = ["all", "index", "topics", "sessions", "daily", "dreams"];

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function MemoryWorkbench(props: {
  workspace: Workspace | null;
  memory: WorkspaceMemoryController;
}) {
  const memory = props.memory;
  const fileItems = memory.searchResults?.items ?? memory.index?.items ?? [];
  const pendingProposals = memory.proposals?.items ?? [];

  async function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await memory.searchMemory();
  }

  if (!props.workspace) {
    return <EmptyState title="No workspace selected" description="Open a workspace to inspect memory." />;
  }

  return (
    <div className="grid gap-4 2xl:grid-cols-[minmax(360px,0.82fr)_minmax(0,1.18fr)]">
      <div className="space-y-4">
        <DetailSection
          title="Memory Status"
          description="Workspace-scoped memory inventory and write gate state."
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={memory.status?.enabled ? "secondary" : "outline"}>{memory.status?.enabled ? "enabled" : "disabled"}</Badge>
            <Badge variant="outline">{memory.status?.writePolicy ?? "n/a"}</Badge>
            <Badge variant="outline">{memory.status?.rootPath ?? ".openharness/memory"}</Badge>
            <Button variant="secondary" size="sm" onClick={() => void memory.refreshMemory()} disabled={memory.busy}>
              <RefreshCw className={cn("h-4 w-4", memory.busy ? "animate-spin" : "")} />
              Refresh
            </Button>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <InsightRow label="Files" value={String(memory.status?.fileCount ?? 0)} />
            <InsightRow label="Bytes" value={formatBytes(memory.status?.totalBytes ?? 0)} />
            <InsightRow label="Topics" value={String(memory.status?.topics ?? 0)} />
            <InsightRow label="Sessions" value={String(memory.status?.sessions ?? 0)} />
            <InsightRow label="Daily" value={String(memory.status?.daily ?? 0)} />
            <InsightRow label="Dreams" value={String(memory.status?.dreams ?? 0)} />
            <InsightRow label="Proposals" value={String(memory.status?.pendingProposals ?? 0)} />
            <InsightRow label="Index" value={memory.status?.indexExists ? "present" : "missing"} />
          </div>
        </DetailSection>

        <DetailSection
          title="Search"
          description="Search across memory files through the workspace memory API."
        >
          <form className="space-y-3" onSubmit={(event) => void handleSearchSubmit(event)}>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={memory.searchQuery}
                  onChange={(event) => memory.setSearchQuery(event.target.value)}
                  placeholder="Search memory"
                  className="h-9 pl-8 text-sm"
                />
              </div>
              <Select value={memory.searchCorpus} onValueChange={(value) => memory.setSearchCorpus(value as WorkspaceMemoryCorpus)}>
                <SelectTrigger className="h-9 w-full text-sm sm:w-36" aria-label="Memory corpus">
                  <SelectValue placeholder="Corpus" />
                </SelectTrigger>
                <SelectContent align="start">
                  {MEMORY_CORPUS_OPTIONS.map((corpus) => (
                    <SelectItem key={corpus} value={corpus}>
                      {corpus}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="submit" size="sm" disabled={memory.searchBusy || !memory.searchQuery.trim()}>
                <Search className={cn("h-4 w-4", memory.searchBusy ? "animate-pulse" : "")} />
                Search
              </Button>
            </div>
          </form>
        </DetailSection>

        <DetailSection
          title="Memory Files"
          description={memory.searchResults ? `Search results for "${memory.searchResults.query}".` : "Current memory index."}
        >
          {fileItems.length === 0 ? (
            <EmptyState title="No memory files" description="Memory files will appear here after the workspace records them." />
          ) : (
            <div className="max-h-[520px] space-y-2 overflow-auto pr-1">
              {fileItems.map((item) => (
                <button
                  key={item.path}
                  type="button"
                  onClick={() => void memory.readMemory(item.path)}
                  className={cn(
                    "w-full rounded-lg border border-border/70 bg-background/75 p-3 text-left transition hover:border-border hover:bg-muted/25",
                    memory.selectedMemory?.path === item.path ? "border-foreground/30 bg-muted/30" : ""
                  )}
                >
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{item.title}</p>
                      <p className="mt-1 truncate text-xs text-muted-foreground">{item.path}</p>
                    </div>
                    <Badge variant="outline">{item.corpus}</Badge>
                  </div>
                  {item.description ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">{item.description}</p> : null}
                  {"snippet" in item && typeof item.snippet === "string" && item.snippet ? (
                    <p className="mt-2 line-clamp-2 text-xs leading-5 text-foreground/75">{item.snippet}</p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    <span>{formatBytes(item.sizeBytes)}</span>
                    <span>{formatTimestamp(item.updatedAt)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </DetailSection>
      </div>

      <div className="space-y-4">
        <DetailSection
          title="Selected Memory"
          description={memory.selectedMemory?.path ?? "Select a memory file to inspect its contents."}
        >
          {memory.readBusy ? (
            <p className="text-sm text-muted-foreground">Loading memory file...</p>
          ) : memory.selectedMemory ? (
            <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/70 bg-muted/10 p-3 text-xs leading-6 text-foreground/80">
              {memory.selectedMemory.content}
            </pre>
          ) : (
            <EmptyState title="No file selected" description="Choose an item from Memory Files." />
          )}
        </DetailSection>

        <DetailSection
          title="Pending Proposals"
          description="Suggested writes waiting for explicit apply or reject."
        >
          {pendingProposals.length === 0 ? (
            <EmptyState title="No proposals" description="Pending memory proposals will appear here." />
          ) : (
            <div className="space-y-2">
              {pendingProposals.map((proposal) => {
                const proposalBusy = memory.proposalBusyPath === proposal.path;
                return (
                  <div key={proposal.path} className="rounded-lg border border-border/70 bg-background/75 p-3">
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{proposal.targetPath ?? proposal.path}</p>
                        <p className="mt-1 truncate text-xs text-muted-foreground">{proposal.path}</p>
                      </div>
                      <Badge variant="outline">{proposal.tool}</Badge>
                    </div>
                    {proposal.summary ? <p className="mt-2 text-xs leading-5 text-muted-foreground">{proposal.summary}</p> : null}
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button size="sm" onClick={() => void memory.applyProposal(proposal.path)} disabled={proposalBusy}>
                        <Check className="h-4 w-4" />
                        Apply
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => void memory.rejectProposal(proposal.path)} disabled={proposalBusy}>
                        <X className="h-4 w-4" />
                        Reject
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => void memory.readMemory(proposal.path)}>
                        <FileText className="h-4 w-4" />
                        Open
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </DetailSection>
      </div>
    </div>
  );
}

function WorkspaceWorkbench(props: {
  workspace: Workspace | null;
  session: Session | null;
  run: Run | null;
  catalog: WorkspaceCatalog | null;
  workspaceMemory: WorkspaceMemoryController;
  engineTools: ModelCallTraceEngineTool[];
  engineToolNames: string[];
  activeToolNames: string[];
  toolServers: ModelCallTraceToolServer[];
  triggerWorkspaceAction: (input: { workspaceId: string; actionName: string; input?: unknown }) => Promise<boolean>;
  refreshWorkspace: (targetId: string) => void;
}) {
  const [panel, setPanel] = useState<"snapshot" | "catalog" | "records" | "memory">("snapshot");
  const [selectedUserActionName, setSelectedUserActionName] = useState("");
  const [actionInputMode, setActionInputMode] = useState<"structured" | "json">("json");
  const [actionInputText, setActionInputText] = useState("");
  const [structuredActionInputValues, setStructuredActionInputValues] = useState<Record<string, string>>({});
  const [actionInputError, setActionInputError] = useState("");
  const [actionRunBusy, setActionRunBusy] = useState(false);
  const workspaceKind = props.workspace?.kind ?? "n/a";
  const workspaceId = props.workspace?.id ?? "n/a";
  const selectedRunId = props.run?.id ?? "n/a";
  const userCallableActions = (props.catalog?.actions ?? []).filter((action) => action.callableByUser !== false);
  const selectedUserAction = userCallableActions.find((action) => action.name === selectedUserActionName) ?? userCallableActions[0];
  const selectedUserActionFormSpec = deriveStructuredActionInputSpec(selectedUserAction?.inputSchema);
  const inventoryRows = props.catalog
    ? [
        { label: "agents", value: props.catalog.agents.length },
        { label: "models", value: props.catalog.models.length },
        { label: "actions", value: props.catalog.actions.length },
        { label: "skills", value: props.catalog.skills.length },
        { label: "tools", value: props.catalog.tools?.length ?? 0 },
        { label: "hooks", value: props.catalog.hooks.length },
        { label: "engineTools", value: props.catalog.engineTools?.length ?? 0 },
        { label: "nativeTools", value: props.catalog.nativeTools.length }
      ]
    : [];
  const userCallableActionNamesKey = userCallableActions.map((action) => action.name).join("|");
  const selectedUserActionKey = `${selectedUserAction?.name ?? ""}:${JSON.stringify(selectedUserAction?.inputSchema ?? null)}`;

  useEffect(() => {
    if (userCallableActions.length === 0) {
      if (selectedUserActionName) {
        setSelectedUserActionName("");
      }
      return;
    }

    if (!userCallableActions.some((action) => action.name === selectedUserActionName)) {
      setSelectedUserActionName(userCallableActions[0]!.name);
    }
  }, [selectedUserActionName, userCallableActionNamesKey, userCallableActions]);

  useEffect(() => {
    setActionInputError("");
    setActionInputText("");
    if (selectedUserActionFormSpec) {
      setActionInputMode("structured");
      setStructuredActionInputValues(initializeStructuredActionInputValues(selectedUserActionFormSpec));
      return;
    }

    setActionInputMode("json");
    setStructuredActionInputValues({});
  }, [selectedUserActionKey, selectedUserActionFormSpec]);

  async function handleRunWorkspaceAction() {
    if (!props.workspace?.id || !selectedUserAction) {
      return;
    }

    const trimmedInput = actionInputText.trim();
    let parsedInput: unknown;
    if (selectedUserActionFormSpec && actionInputMode === "structured") {
      const builtInput = buildStructuredActionInput(selectedUserActionFormSpec, structuredActionInputValues);
      if (!builtInput.ok) {
        setActionInputError(builtInput.error);
        return;
      }
      parsedInput = builtInput.value;
    } else if (trimmedInput.length > 0) {
      try {
        parsedInput = JSON.parse(trimmedInput);
      } catch {
        setActionInputError("Action input must be valid JSON.");
        return;
      }
    }

    setActionInputError("");
    setActionRunBusy(true);
    try {
      const triggered = await props.triggerWorkspaceAction({
        workspaceId: props.workspace.id,
        actionName: selectedUserAction.name,
        ...(trimmedInput.length > 0 ? { input: parsedInput } : {})
      });
      if (triggered) {
        setActionInputText("");
      }
    } finally {
      setActionRunBusy(false);
    }
  }

  return (
    <section className="space-y-4">
      <section className="ob-section rounded-[20px] p-5">
        <InspectorPanelHeader
          title="Workspace"
          description="Workspace 页现在收成一套更紧凑的环境工作台: 顶部先看状态和控制，下方再切换 Snapshot、Catalog、Records。"
        />
        <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1.18fr)_minmax(320px,0.82fr)]">
          <div className="rounded-[18px] border border-border/70 bg-muted/15 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{workspaceKind}</Badge>
              <Badge variant="outline">{props.catalog ? "catalog loaded" : "catalog missing"}</Badge>
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <TraceSummaryStat label="Workspace" value={workspaceId} />
              <TraceSummaryStat label="Status" value={props.workspace?.status ?? "n/a"} />
              <TraceSummaryStat label="Selected Run" value={selectedRunId} />
              <TraceSummaryStat label="Catalog" value={props.catalog ? "loaded" : "n/a"} />
            </div>
          </div>

          <div className="rounded-[18px] border border-border/70 bg-background/80 p-4">
            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Controls</p>
            {props.workspace ? (
              <>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="ghost" size="sm" onClick={() => props.refreshWorkspace(props.workspace!.id)}>
                    Refresh
                  </Button>
                </div>
                <div className="mt-4 rounded-[16px] border border-border/70 bg-muted/10 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Run Action</p>
                    {selectedUserAction?.retryPolicy ? <Badge variant="outline">{selectedUserAction.retryPolicy}</Badge> : null}
                  </div>
                  {userCallableActions.length > 0 ? (
                    <>
                      <div className="mt-3">
                        <Select value={selectedUserAction?.name ?? ""} onValueChange={setSelectedUserActionName}>
                          <SelectTrigger className="h-9 w-full text-sm" aria-label="User action">
                            <SelectValue placeholder="Select action" />
                          </SelectTrigger>
                          <SelectContent align="start">
                            {userCallableActions.map((action) => (
                              <SelectItem key={action.name} value={action.name}>
                                {action.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {selectedUserAction?.description ? (
                        <p className="mt-2 text-xs leading-5 text-muted-foreground">{selectedUserAction.description}</p>
                      ) : null}
                      {selectedUserAction?.inputSchema ? (
                        <div className="mt-3">
                          <JsonBlock title="Input Schema" value={selectedUserAction.inputSchema} />
                        </div>
                      ) : null}
                      {selectedUserActionFormSpec ? (
                        <div className="mt-3 space-y-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant={actionInputMode === "structured" ? "secondary" : "outline"}
                              onClick={() => setActionInputMode("structured")}
                            >
                              Structured
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant={actionInputMode === "json" ? "secondary" : "outline"}
                              onClick={() => setActionInputMode("json")}
                            >
                              Raw JSON
                            </Button>
                          </div>
                          {actionInputMode === "structured" ? (
                            selectedUserActionFormSpec.fields.length > 0 ? (
                              <div className="grid gap-3 sm:grid-cols-2">
                                {selectedUserActionFormSpec.fields.map((field) => (
                                  <div key={field.name} className={cn("space-y-2", field.kind === "boolean" ? "sm:col-span-2" : "")}>
                                    <Label>
                                      {field.label}
                                      {field.required ? " *" : ""}
                                    </Label>
                                    {field.kind === "string" ? (
                                      <Input
                                        value={structuredActionInputValues[field.name] ?? ""}
                                        onChange={(event) => {
                                          setStructuredActionInputValues((current) => ({
                                            ...current,
                                            [field.name]: event.target.value
                                          }));
                                          if (actionInputError) {
                                            setActionInputError("");
                                          }
                                        }}
                                        placeholder={field.description ?? field.label}
                                      />
                                    ) : field.kind === "number" || field.kind === "integer" ? (
                                      <Input
                                        type="number"
                                        step={field.kind === "integer" ? "1" : "any"}
                                        value={structuredActionInputValues[field.name] ?? ""}
                                        onChange={(event) => {
                                          setStructuredActionInputValues((current) => ({
                                            ...current,
                                            [field.name]: event.target.value
                                          }));
                                          if (actionInputError) {
                                            setActionInputError("");
                                          }
                                        }}
                                        placeholder={field.kind === "integer" ? "0" : "0.0"}
                                      />
                                    ) : field.kind === "boolean" ? (
                                      <Select
                                        value={structuredActionInputValues[field.name] || ACTION_INPUT_UNSET_VALUE}
                                        onValueChange={(value) => {
                                          setStructuredActionInputValues((current) => ({
                                            ...current,
                                            [field.name]: value === ACTION_INPUT_UNSET_VALUE ? "" : value
                                          }));
                                          if (actionInputError) {
                                            setActionInputError("");
                                          }
                                        }}
                                      >
                                        <SelectTrigger className="h-9 w-full text-sm" aria-label={field.label}>
                                          <SelectValue placeholder={field.required ? "Select true or false" : "Not set"} />
                                        </SelectTrigger>
                                        <SelectContent align="start">
                                          {!field.required ? <SelectItem value={ACTION_INPUT_UNSET_VALUE}>Not set</SelectItem> : null}
                                          <SelectItem value="true">true</SelectItem>
                                          <SelectItem value="false">false</SelectItem>
                                        </SelectContent>
                                      </Select>
                                    ) : field.kind === "string_enum" ? (
                                      <Select
                                        value={structuredActionInputValues[field.name] || ACTION_INPUT_UNSET_VALUE}
                                        onValueChange={(value) => {
                                          setStructuredActionInputValues((current) => ({
                                            ...current,
                                            [field.name]: value === ACTION_INPUT_UNSET_VALUE ? "" : value
                                          }));
                                          if (actionInputError) {
                                            setActionInputError("");
                                          }
                                        }}
                                      >
                                        <SelectTrigger className="h-9 w-full text-sm" aria-label={field.label}>
                                          <SelectValue placeholder={field.required ? "Select a value" : "Not set"} />
                                        </SelectTrigger>
                                        <SelectContent align="start">
                                          {!field.required ? <SelectItem value={ACTION_INPUT_UNSET_VALUE}>Not set</SelectItem> : null}
                                          {field.options.map((option: string) => (
                                            <SelectItem key={option} value={option}>
                                              {option}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    ) : null}
                                    {field.description ? <p className="text-xs leading-5 text-muted-foreground">{field.description}</p> : null}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="text-xs leading-5 text-muted-foreground">
                                This action accepts an object input with no predefined fields. Structured mode will submit an empty object.
                              </p>
                            )
                          ) : (
                            <Textarea
                              value={actionInputText}
                              onChange={(event) => {
                                setActionInputText(event.target.value);
                                if (actionInputError) {
                                  setActionInputError("");
                                }
                              }}
                              placeholder='Optional JSON input, for example {"mode":"quick"}'
                              className="min-h-[108px] text-xs leading-6"
                            />
                          )}
                        </div>
                      ) : (
                        <Textarea
                          value={actionInputText}
                          onChange={(event) => {
                            setActionInputText(event.target.value);
                            if (actionInputError) {
                              setActionInputError("");
                            }
                          }}
                          placeholder='Optional JSON input, for example {"mode":"quick"}'
                          className="mt-3 min-h-[108px] text-xs leading-6"
                        />
                      )}
                      <p className={cn("mt-2 text-xs leading-5", actionInputError ? "text-rose-600" : "text-muted-foreground")}>
                        {actionInputError ||
                          (props.session?.workspaceId === props.workspace.id
                            ? `This run will attach to the current session ${props.session.id}.`
                            : "No active session is attached to this workspace. Running the action will create a temporary session automatically.")}
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Button size="sm" disabled={actionRunBusy || !selectedUserAction} onClick={() => void handleRunWorkspaceAction()}>
                          {actionRunBusy ? "Running..." : "Run Action"}
                        </Button>
                        <Badge variant="secondary">{selectedUserAction?.name ?? "no action selected"}</Badge>
                      </div>
                    </>
                  ) : (
                    <p className="mt-3 text-xs leading-5 text-muted-foreground">
                      No user-callable actions are exposed in this workspace catalog.
                    </p>
                  )}
                </div>
                <p className="mt-3 text-xs leading-6 text-muted-foreground">
                  Use Snapshot for quick environment checks. Switch to Catalog or Records only when you need the full detail.
                </p>
              </>
            ) : (
              <EmptyState title="No workspace selected" description="Open a workspace to manage mirror sync and inspect environment state." />
            )}
          </div>
        </div>
      </section>

      <section className="ob-section rounded-[20px] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-foreground">Workspace Views</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Keep the default page short, then open deeper detail only when needed.</p>
          </div>
          <div className="segmented-shell">
            <InspectorTabButton label="Snapshot" active={panel === "snapshot"} onClick={() => setPanel("snapshot")} />
            <InspectorTabButton label="Catalog" active={panel === "catalog"} onClick={() => setPanel("catalog")} />
            <InspectorTabButton label="Records" active={panel === "records"} onClick={() => setPanel("records")} />
            <InspectorTabButton label="Memory" active={panel === "memory"} onClick={() => setPanel("memory")} />
          </div>
        </div>

        <div className="mt-5">
          {panel === "snapshot" ? (
            <div className="grid gap-4 2xl:grid-cols-[minmax(320px,0.72fr)_minmax(0,1.28fr)]">
              <div className="space-y-4">
                <DetailSection
                  title="Workspace Snapshot"
                  description="先看 workspace 的基础状态，再决定是否深入 catalog 或 records。"
                >
                  {props.workspace ? (
                    <>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <InsightRow label="Workspace Kind" value={props.workspace.kind} />
                        <InsightRow label="Workspace Status" value={props.workspace.status} />
                        <InsightRow label="Catalog" value={props.catalog ? "loaded" : "n/a"} />
                        <InsightRow label="Selected Run" value={props.run?.id ?? "n/a"} />
                      </div>
                    </>
                  ) : (
                    <EmptyState title="No workspace selected" description="Open a workspace to inspect environment state." />
                  )}
                </DetailSection>

                <DetailSection
                  title="Inventory Snapshot"
                  description="先看数量和边界，确认 catalog 是否符合预期。"
                >
                  {props.catalog ? (
                    <div className="grid gap-2">
                      {inventoryRows.map((item) => (
                        <CatalogLine key={item.label} label={item.label} value={item.value} />
                      ))}
                    </div>
                  ) : (
                    <EmptyState title="No catalog" description="Load a workspace first to inspect the current inventory." />
                  )}
                </DetailSection>
              </div>

              <DetailSection
                title="Tool Snapshot"
                description="默认首屏把工具环境放在右侧主区域，目录和详情集中阅读，减少来回跳转。"
              >
                <ToolSnapshotBrowser
                  engineTools={props.engineTools}
                  engineToolNames={props.engineToolNames}
                  activeToolNames={props.activeToolNames}
                  toolServers={props.toolServers}
                />
              </DetailSection>
            </div>
          ) : null}

          {panel === "memory" ? (
            <MemoryWorkbench workspace={props.workspace} memory={props.workspaceMemory} />
          ) : null}

          {panel !== "snapshot" && panel !== "memory" ? (
            <DetailSection
              title={panel === "catalog" ? "Catalog Detail" : "Record Detail"}
              description={
                panel === "catalog"
                  ? "Catalog 模式只在你需要核对能力边界时展开，默认不再占据首屏。"
                  : "Records 模式保留 workspace、session、run 的原始对象，适合审计和排查。"
              }
            >
              {panel === "catalog" ? (
                props.catalog ? (
                  <div className="space-y-3">
                    <WorkspaceCatalogCollection
                      title="Agents"
                      description="Workspace agent definitions, or platform fallback agents when the workspace does not declare any."
                      items={props.catalog.agents}
                    />
                    <WorkspaceCatalogCollection title="Models" description="Available models and provider bindings." items={props.catalog.models} />
                    <WorkspaceCatalogCollection title="Actions" description="Runnable actions exposed in this workspace." items={props.catalog.actions} />
                    <WorkspaceCatalogCollection title="Skills" description="Loaded workspace skills." items={props.catalog.skills} />
                    <WorkspaceCatalogCollection title="Tools" description="Declared tools and tool exposure." items={props.catalog.tools ?? []} />
                    <WorkspaceCatalogCollection title="Hooks" description="Registered hook definitions." items={props.catalog.hooks} />
                    <WorkspaceCatalogCollection
                      title="Engine Tools"
                      description="Tools the runtime can actually expose across this workspace, including AgentSwitch, Skill, run_action, SubAgent, and native tools."
                      items={props.catalog.engineTools ?? props.catalog.nativeTools}
                    />
                    <WorkspaceCatalogCollection title="Native Tools" description="Base native tool inventory recorded by the runtime." items={props.catalog.nativeTools} />
                    <InspectorDisclosure title="Raw Catalog JSON" description="完整 catalog 记录，保留给审计或排查边界问题。" badge="raw">
                      <EntityPreview title={props.catalog.workspaceId} data={props.catalog} />
                    </InspectorDisclosure>
                  </div>
                ) : (
                  <EmptyState title="No catalog" description="Load a workspace first to inspect its catalog." />
                )
              ) : (
                <OverviewRecordsCard run={props.run} session={props.session} workspace={props.workspace} />
              )}
            </DetailSection>
          ) : null}
        </div>
      </section>
    </section>
  );
}

export { WorkspaceWorkbench };
