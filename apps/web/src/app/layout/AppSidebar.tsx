import { Bot, FolderPlus, Network, RefreshCw, RotateCcw, Server } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

import { probeTone } from "../support";
import type { useAppController } from "../use-app-controller";
import { SessionNavItem, WorkspaceNavItem } from "./sidebar-items";

type SidebarProps = ReturnType<typeof useAppController>["sidebarSurfaceProps"];

function statusClass(tone: "sky" | "emerald" | "rose" | "amber") {
  switch (tone) {
    case "emerald":
      return "border-emerald-200/80 bg-emerald-50/70 text-emerald-700 dark:border-emerald-800/80 dark:bg-emerald-950/40 dark:text-emerald-400";
    case "rose":
      return "border-rose-200/80 bg-rose-50/70 text-rose-700 dark:border-rose-800/80 dark:bg-rose-950/40 dark:text-rose-400";
    case "amber":
      return "border-amber-200/80 bg-amber-50/70 text-amber-700 dark:border-amber-800/80 dark:bg-amber-950/40 dark:text-amber-400";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

function SidebarStatus(props: { label: string; value: string; tone: "sky" | "emerald" | "rose" | "amber" }) {
  return (
    <div className={`rounded-md border px-3 py-2 text-xs ${statusClass(props.tone)}`}>
      <div className="uppercase tracking-[0.14em]">{props.label}</div>
      <div className="mt-1 font-medium normal-case tracking-normal">{props.value}</div>
    </div>
  );
}

function ToggleRow(props: { label: string; checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2">
      <span className="text-sm text-foreground">{props.label}</span>
      <Switch checked={props.checked} onCheckedChange={props.onCheckedChange} />
    </label>
  );
}

export function AppSidebar(props: SidebarProps) {
  return (
    <>
      <aside className="bg-background flex min-h-0 w-[288px] shrink-0 flex-col border-r border-border">
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden w-full">
          <div className="space-y-3 px-2 py-3">
            <div className="flex items-center justify-between gap-2 px-2">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Workspaces</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {props.orderedSavedWorkspaces.length} workspaces · {props.savedSessionsCount} sessions
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button size="icon" variant="ghost" className="h-8 w-8" onClick={props.refreshWorkspaceIndex} title="Refresh workspace list">
                  <RotateCcw className="h-4 w-4" />
                </Button>
                {props.workspaceManagementEnabled ? (
                  <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => props.setShowWorkspaceCreator(true)} title="New Workspace">
                    <FolderPlus className="h-4 w-4" />
                  </Button>
                ) : null}
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  disabled={!props.activeWorkspaceId.trim()}
                  title="New Session"
                  onClick={() => {
                    if (!props.activeWorkspaceId.trim()) {
                      return;
                    }
                    props.expandWorkspaceInSidebar(props.activeWorkspaceId);
                    props.createSession();
                  }}
                >
                  <Bot className="h-4 w-4" />
                </Button>
              </div>
            </div>
            {props.orderedSavedWorkspaces.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/80 bg-muted/20 px-4 py-8 text-center">
                <p className="text-sm font-medium text-foreground">No workspaces</p>
                <p className="mt-1 text-sm text-muted-foreground">Create or load one.</p>
              </div>
            ) : (
              props.orderedSavedWorkspaces.map((entry) => {
                const workspaceSessions = props.sessionsByWorkspaceId.get(entry.id) ?? [];
                const isExpanded = props.expandedWorkspaceIds.includes(entry.id) || entry.id === props.activeWorkspaceId;

                return (
                  <div key={entry.id} className="space-y-1">
                    <WorkspaceNavItem
                      entry={entry}
                      active={entry.id === props.activeWorkspaceId}
                      expanded={isExpanded}
                      sessionCount={workspaceSessions.length}
                      canRemove={props.workspaceManagementEnabled}
                      onSelect={() => props.openWorkspace(entry.id)}
                      onToggleExpanded={() => props.toggleWorkspaceExpansion(entry.id)}
                      onRemove={() => props.deleteWorkspace(entry.id)}
                    />
                    {isExpanded ? (
                      <div className="ml-4 space-y-1">
                        {workspaceSessions.length === 0 ? (
                          <div className="rounded-md px-2 py-2 text-xs text-muted-foreground">No sessions yet.</div>
                        ) : (
                          workspaceSessions.map((sessionEntry) => (
                            <SessionNavItem
                              key={sessionEntry.id}
                              entry={sessionEntry}
                              active={sessionEntry.id === props.sessionId}
                              onSelect={() => {
                                props.expandWorkspaceInSidebar(entry.id);
                                props.refreshSessionById(sessionEntry.id);
                              }}
                              onRename={(title) => props.renameSession(sessionEntry.id, title)}
                              onRemove={() => props.removeSavedSession(sessionEntry.id)}
                            />
                          ))
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="space-y-3 border-t border-border/80 px-3 py-3">
          <div className="grid gap-2">
            <ToggleRow label="Auto SSE" checked={props.autoStream} onCheckedChange={(checked) => props.setAutoStream(checked)} />
            <ToggleRow label="Current Run" checked={props.filterSelectedRun} onCheckedChange={(checked) => props.setFilterSelectedRun(checked)} />
          </div>

          <Button variant="ghost" className="h-8 w-full justify-start px-2.5" onClick={() => props.setShowConnectionPanel((current) => !current)}>
            <Server className="h-4 w-4" />
            Server
          </Button>

          {props.showConnectionPanel ? (
            <div className="space-y-3 rounded-xl border border-border/70 bg-muted/20 p-3">
              <div>
                <p className="text-sm font-medium text-foreground">Connection</p>
                <p className="mt-1 text-xs text-muted-foreground">Server, storage and model provider diagnostics.</p>
              </div>
              <Input value={props.connection.baseUrl} onChange={(event) => props.setConnection((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="Base URL" />
              <Input value={props.connection.token} onChange={(event) => props.setConnection((current) => ({ ...current, token: event.target.value }))} placeholder="Bearer token (optional)" />
              <div className="flex gap-2">
                <Button className="flex-1" variant="secondary" onClick={props.pingHealth}>
                  <Network className="h-4 w-4" />
                  Health
                </Button>
                <Button className="flex-1" variant="outline" onClick={() => props.setStreamRevision((current) => current + 1)}>
                  <RefreshCw className="h-4 w-4" />
                  SSE
                </Button>
              </div>

              {props.healthReport || props.readinessReport ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <SidebarStatus label="Readiness" value={props.readinessReport?.status ?? "unknown"} tone={probeTone(props.readinessReport?.status ?? "idle")} />
                  <SidebarStatus label="Mirror" value={props.healthReport?.checks.historyMirror ?? "unknown"} tone={probeTone(props.healthReport?.checks.historyMirror ?? "idle")} />
                </div>
              ) : null}

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Model Providers</p>
                  <Button variant="link" size="sm" className="h-auto px-0 text-xs" onClick={props.refreshModelProviders}>
                    Refresh
                  </Button>
                </div>
                {props.modelProviders.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">暂无 provider 列表。</div>
                ) : (
                  <div className="space-y-2">
                    {props.modelProviders.map((provider) => (
                      <div key={provider.id} className="rounded-lg border border-border/70 bg-background px-3 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge>{provider.id}</Badge>
                          <span className="text-xs text-muted-foreground">{provider.packageName}</span>
                        </div>
                        <p className="mt-2 text-sm text-foreground">{provider.description}</p>
                        <p className="mt-2 text-xs text-muted-foreground">{provider.useCases.join(" · ")}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </aside>

      <Dialog open={props.showWorkspaceCreator} onOpenChange={props.setShowWorkspaceCreator}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Workspace</DialogTitle>
            <DialogDescription>Create a workspace rooted at a project directory.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input value={props.workspaceDraft.name} onChange={(event) => props.setWorkspaceDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Workspace name" />
            <Input list="workspace-template-options" value={props.workspaceDraft.template} onChange={(event) => props.setWorkspaceDraft((current) => ({ ...current, template: event.target.value }))} placeholder="Template" />
            <datalist id="workspace-template-options">
              {props.workspaceTemplates.map((template) => (
                <option key={template} value={template} />
              ))}
            </datalist>
            <Input value={props.workspaceDraft.rootPath} onChange={(event) => props.setWorkspaceDraft((current) => ({ ...current, rootPath: event.target.value }))} placeholder="Root path" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => props.refreshWorkspaceTemplates()}>
              <RefreshCw className="h-4 w-4" />
              Templates
            </Button>
            <Button
              onClick={() => {
                props.createWorkspace();
                props.setShowWorkspaceCreator(false);
              }}
            >
              <FolderPlus className="h-4 w-4" />
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
