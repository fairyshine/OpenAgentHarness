import { useEffect, useState } from "react";

import type { Run, Session, Workspace, WorkspaceCatalog } from "@oah/api-contracts";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";

import { type ModelCallTraceEngineTool, type ModelCallTraceToolServer } from "../support";
import { CatalogLine, EmptyState, EntityPreview, InsightRow } from "../primitives";
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

function WorkspaceWorkbench(props: {
  workspace: Workspace | null;
  session: Session | null;
  run: Run | null;
  catalog: WorkspaceCatalog | null;
  engineTools: ModelCallTraceEngineTool[];
  engineToolNames: string[];
  activeToolNames: string[];
  toolServers: ModelCallTraceToolServer[];
  triggerWorkspaceAction: (input: { workspaceId: string; actionName: string; input?: unknown }) => Promise<boolean>;
  refreshWorkspace: (targetId: string) => void;
}) {
  const [panel, setPanel] = useState<"snapshot" | "catalog" | "records">("snapshot");
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

          {panel !== "snapshot" ? (
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
