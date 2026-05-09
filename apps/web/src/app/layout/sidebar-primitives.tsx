import type { ReactNode } from "react";

import { Network } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { toneBadgeClass, type StatusSemanticTone } from "../support";

function tableLabel(name: string) {
  return name.replace(/_/g, " ");
}

function compactFilterCount(values: string[]) {
  return values.filter((value) => value.trim().length > 0).length;
}

function blurActiveDialogElement() {
  if (typeof document === "undefined") {
    return;
  }

  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement && activeElement.closest('[data-slot="dialog-content"]')) {
    activeElement.blur();
  }
}

function deferDialogOpen(callback: () => void) {
  window.setTimeout(callback, 0);
}

function SidebarSection(props: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-black/8 pt-4 first:border-t-0 first:pt-0">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{props.title}</p>
          {props.description ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{props.description}</p> : null}
        </div>
        {props.action}
      </div>
      {props.children}
    </section>
  );
}

function SidebarHero(props: {
  icon: ReactNode;
  eyebrow?: string;
  title?: string;
  description?: string;
  accentClassName?: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className={`sidebar-hero border-b border-black/8 pb-4 ${props.accentClassName ?? ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="sidebar-hero-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-black/10 bg-white/55 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]">
            {props.icon}
          </div>
          {props.eyebrow || props.title || props.description ? (
            <div className="min-w-0">
              {props.eyebrow ? <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{props.eyebrow}</p> : null}
              {props.title ? <p className="mt-1 text-sm font-semibold tracking-tight text-foreground">{props.title}</p> : null}
              {props.description ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{props.description}</p> : null}
            </div>
          ) : null}
        </div>
        {props.action}
      </div>
      {props.children ? <div className="mt-4 space-y-3">{props.children}</div> : null}
    </section>
  );
}

function SidebarMetric(props: {
  label: string;
  value: string;
  tone?: StatusSemanticTone;
  detail?: string;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={`border ${props.compact ? "rounded-xl px-3 py-2" : "rounded-[1.6rem] px-3.5 py-3"} ${toneBadgeClass(props.tone ?? "sky")} ${
        props.className ?? ""
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <p className={`uppercase ${props.compact ? "text-[9px] tracking-[0.18em]" : "text-[10px] tracking-[0.2em]"}`}>{props.label}</p>
      </div>
      <p className={`truncate font-semibold tracking-tight ${props.compact ? "mt-1.5 text-sm" : "mt-2 text-[0.95rem]"}`}>{props.value}</p>
      {props.detail ? <p className={`text-current/72 ${props.compact ? "mt-0.5 text-[10px]" : "mt-1 text-[11px]"}`}>{props.detail}</p> : null}
    </div>
  );
}

function StatusPill(props: { label: string; value: string; tone: StatusSemanticTone; icon: typeof Network }) {
  const Icon = props.icon;
  return (
    <div className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] ${toneBadgeClass(props.tone)}`}>
      <Icon className="h-3.5 w-3.5" />
      <span className="uppercase tracking-[0.14em] opacity-72">{props.label}</span>
      <span className="font-medium normal-case tracking-normal">{props.value}</span>
    </div>
  );
}

function SidebarFilterField(props: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <label className="space-y-1">
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{props.label}</span>
      <Input
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder={props.placeholder}
        className="h-8 rounded-xl border-black/10 bg-white/68 text-xs shadow-none"
      />
    </label>
  );
}

function SidebarModeToggle(props: {
  items: Array<{ key: string; label: string; icon: ReactNode }>;
  activeKey: string;
  onChange: (key: string) => void;
  iconOnly?: boolean;
}) {
  return (
    <div
      className={`sidebar-mode-toggle info-panel grid gap-1 rounded-[1.35rem] p-1 ${props.iconOnly ? "shrink-0" : ""}`}
      style={{ gridTemplateColumns: `repeat(${Math.max(1, props.items.length)}, minmax(0, 1fr))` }}
    >
      {props.items.map((item) => (
        <Button
          key={item.key}
          variant="ghost"
          className={`${props.iconOnly ? "h-8 w-8 px-0" : "h-10 min-w-0 px-2"} justify-center rounded-[0.9rem] text-sm transition-all ${
            props.activeKey === item.key
              ? "border border-black/10 bg-white text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.85),0_8px_18px_-16px_rgba(17,17,17,0.38)]"
              : "text-muted-foreground hover:bg-white/55 hover:text-foreground"
          }`}
          onClick={() => props.onChange(item.key)}
          title={item.label}
          aria-label={item.label}
        >
          <span className="shrink-0 opacity-80">{item.icon}</span>
          {props.iconOnly ? null : <span className="min-w-0 truncate">{item.label}</span>}
        </Button>
      ))}
    </div>
  );
}

function SidebarActionItem(props: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  active?: boolean;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      className={`h-auto w-full justify-start rounded-2xl px-3 py-3 text-left transition-all ${
        props.active
          ? "info-panel ob-list-item-active"
          : "info-panel info-panel-hoverable"
      }`}
      onClick={props.onClick}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {props.icon ? (
          <div
            className={`ob-list-item-icon mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${
              props.active ? "ob-list-item-icon-active" : ""
            }`}
          >
            {props.icon}
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium text-foreground">{props.title}</span>
            {props.badge ? <Badge variant="outline">{props.badge}</Badge> : null}
          </div>
          {props.subtitle ? <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{props.subtitle}</p> : null}
        </div>
      </div>
    </Button>
  );
}

export {
  SidebarActionItem,
  SidebarFilterField,
  SidebarHero,
  SidebarMetric,
  SidebarModeToggle,
  SidebarSection,
  StatusPill,
  blurActiveDialogElement,
  compactFilterCount,
  deferDialogOpen,
  tableLabel
};
