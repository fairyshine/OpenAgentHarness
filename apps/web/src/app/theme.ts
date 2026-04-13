import { useLayoutEffect, useState } from "react";

const APP_THEME_STORAGE_KEY = "oah.web.theme";

export const appThemeOptions = [
  { value: "default", label: "Default" },
  { value: "blue-violet", label: "Blue Violet" }
] as const;

export type AppThemeName = (typeof appThemeOptions)[number]["value"];
type AppThemePreset = {
  appearance: "light" | "dark";
  accent: "graphite" | "blue" | "emerald" | "amber";
  contrast: "soft" | "default" | "strong";
  scale: "compact" | "default" | "comfortable";
  radius: "compact" | "default" | "relaxed";
  surface: "soft" | "default" | "defined";
  motion: "normal" | "reduced";
  tokens?: Record<`--${string}`, string>;
};

const appThemeNames = new Set<AppThemeName>(appThemeOptions.map((option) => option.value));

export const defaultAppTheme: AppThemeName = "default";

const appThemePresets: Record<AppThemeName, AppThemePreset> = {
  default: {
    appearance: "light",
    accent: "graphite",
    contrast: "default",
    scale: "default",
    radius: "default",
    surface: "default",
    motion: "normal",
    tokens: {
      "--app-shell-background": "#e3e1db",
      "--app-shell-gradient":
        "radial-gradient(circle at top left, rgba(255, 255, 255, 0.72), transparent 28%), radial-gradient(circle at 78% 0%, rgba(255, 250, 242, 0.46), transparent 24%), linear-gradient(180deg, #ece9e2 0%, #d8d6cf 100%)",
      "--app-topbar-background": "rgba(244, 242, 237, 0.9)",
      "--app-topbar-border": "rgba(17, 17, 17, 0.075)",
      "--app-topbar-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.84), 0 14px 28px -28px rgba(17, 17, 17, 0.26)",
      "--app-topbar-chip-background": "linear-gradient(180deg, rgba(255, 255, 255, 0.52) 0%, rgba(255, 255, 255, 0.18) 100%)",
      "--app-topbar-chip-border": "color-mix(in srgb, var(--foreground) 8%, transparent)",
      "--app-topbar-chip-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.56)",
      "--app-topbar-chip-hover-background": "rgba(255, 255, 255, 0.78)",
      "--app-topbar-control-idle-background": "rgba(17, 17, 17, 0.04)",
      "--app-topbar-control-idle-border": "color-mix(in srgb, var(--foreground) 8%, transparent)",
      "--app-topbar-control-idle-foreground": "color-mix(in srgb, var(--foreground) 58%, transparent)",
      "--app-topbar-control-idle-hover-background": "rgba(255, 255, 255, 0.76)",
      "--app-topbar-control-idle-hover-foreground": "color-mix(in srgb, var(--foreground) 92%, transparent)",
      "--app-topbar-control-active-background": "rgba(255, 255, 255, 0.9)",
      "--app-topbar-control-active-border": "color-mix(in srgb, var(--foreground) 12%, transparent)",
      "--app-topbar-control-active-foreground": "color-mix(in srgb, var(--foreground) 92%, transparent)",
      "--app-topbar-control-active-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.64), 0 10px 20px -18px rgba(17, 17, 17, 0.26)",
      "--app-sidebar-background": "linear-gradient(180deg, rgba(242, 241, 236, 0.96) 0%, rgba(224, 222, 216, 0.99) 100%)",
      "--app-sidebar-border": "rgba(255, 255, 255, 0.62)",
      "--app-main-background": "linear-gradient(180deg, rgba(248, 247, 244, 0.84) 0%, rgba(238, 236, 231, 0.98) 100%)",
      "--app-main-overlay": "rgba(255, 255, 255, 0.4)",
      "--app-main-surface-glow": "linear-gradient(180deg, rgba(255, 255, 255, 0.24) 0%, rgba(255, 255, 255, 0.05) 22%, transparent 42%)",
      "--app-pane-background": "linear-gradient(180deg, rgba(255, 255, 253, 0.82) 0%, rgba(247, 246, 242, 0.96) 100%)",
      "--app-pane-border": "rgba(17, 17, 17, 0.075)",
      "--app-pane-shadow": "rgba(17, 17, 17, 0.12)",
      "--app-section-background": "linear-gradient(180deg, rgba(255, 255, 253, 0.92) 0%, rgba(248, 247, 243, 0.98) 100%)",
      "--app-section-border": "color-mix(in srgb, var(--foreground) 7%, transparent)",
      "--app-section-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.82), 0 18px 38px -34px rgba(17, 17, 17, 0.22)",
      "--app-subsection-background": "linear-gradient(180deg, rgba(255, 255, 255, 0.52) 0%, rgba(255, 255, 255, 0.28) 100%)",
      "--app-subsection-border": "color-mix(in srgb, var(--foreground) 6%, transparent)",
      "--app-panel-card-background": "linear-gradient(180deg, rgba(255, 255, 252, 0.86) 0%, rgba(248, 247, 244, 0.96) 100%)",
      "--app-panel-card-border": "color-mix(in srgb, var(--foreground) 7%, transparent)",
      "--app-panel-card-shadow": "0 20px 40px -34px rgba(17, 17, 17, 0.2)",
      "--app-subtle-panel-background": "rgba(255, 255, 255, 0.3)",
      "--app-list-item-hover-background": "hsl(var(--foreground) / 0.028)",
      "--app-list-item-active-border": "hsl(var(--foreground) / 0.075)",
      "--app-list-item-active-background": "hsl(var(--foreground) / 0.05)",
      "--app-list-item-active-shadow": "0 16px 30px -28px rgba(17, 17, 17, 0.28)",
      "--app-list-item-child-active-background": "rgba(255, 255, 255, 0.34)",
      "--app-list-item-child-active-border": "transparent",
      "--app-list-item-icon-background": "hsl(var(--foreground) / 0.035)",
      "--app-list-item-icon-foreground": "hsl(var(--foreground) / 0.42)",
      "--app-list-item-icon-active-background": "hsl(var(--foreground) / 0.08)",
      "--app-list-item-icon-active-foreground": "hsl(var(--foreground) / 0.88)",
      "--app-list-item-control-hover-background": "rgba(255, 255, 255, 0.58)",
      "--app-list-item-control-hover-foreground": "hsl(var(--foreground) / 0.92)",
      "--app-list-item-branch-line": "hsl(var(--border) / 0.78)",
      "--app-list-item-branch-line-active": "hsl(var(--foreground) / 0.3)",
      "--app-segmented-background": "hsl(var(--muted) / 0.78)",
      "--app-segmented-border": "hsl(var(--border) / 0.55)",
      "--app-info-chip-background": "linear-gradient(180deg, rgba(255, 255, 253, 0.88) 0%, rgba(247, 246, 242, 0.96) 100%)",
      "--app-info-chip-border": "hsl(var(--border) / 0.46)",
      "--app-info-chip-shadow": "inset 0 1px 0 hsl(var(--background) / 0.82), 0 12px 24px -24px rgba(17, 17, 17, 0.16)",
      "--app-info-panel-background": "linear-gradient(180deg, rgba(251, 250, 246, 0.74) 0%, rgba(244, 243, 238, 0.92) 100%)",
      "--app-info-panel-border": "color-mix(in srgb, var(--foreground) 7%, transparent)",
      "--app-info-panel-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.64), 0 16px 30px -28px rgba(17, 17, 17, 0.16)",
      "--app-info-inline-background": "rgba(255, 255, 255, 0.54)",
      "--app-info-inline-border": "color-mix(in srgb, var(--foreground) 8%, transparent)",
      "--app-info-inline-foreground": "color-mix(in srgb, var(--foreground) 82%, transparent)",
      "--app-code-panel-background": "rgba(255, 255, 255, 0.46)",
      "--app-code-panel-border": "color-mix(in srgb, var(--foreground) 8%, transparent)",
      "--app-code-panel-foreground": "color-mix(in srgb, var(--foreground) 80%, transparent)",
      "--app-data-grid-header-background": "rgba(252, 251, 248, 0.9)",
      "--app-data-grid-header-border": "color-mix(in srgb, var(--foreground) 8%, transparent)",
      "--app-data-grid-cell-border": "color-mix(in srgb, var(--foreground) 7%, transparent)",
      "--app-data-grid-row-odd": "rgba(255, 255, 255, 0.34)",
      "--app-data-grid-row-even": "rgba(17, 17, 17, 0.028)",
      "--app-data-grid-row-hover": "rgba(17, 17, 17, 0.05)",
      "--app-data-grid-row-selected": "rgba(17, 17, 17, 0.072)",
      "--app-console-background": "linear-gradient(180deg, rgba(252, 252, 250, 0.96) 0%, rgba(241, 241, 238, 0.98) 100%)",
      "--app-console-border": "color-mix(in srgb, var(--foreground) 8%, transparent)",
      "--app-console-shadow": "0 -18px 44px -38px rgba(17, 17, 17, 0.32)",
      "--app-console-resizer-background": "rgba(17, 17, 17, 0.035)",
      "--app-console-resizer-hover-background": "rgba(17, 17, 17, 0.08)",
      "--app-console-resizer-active-background": "rgba(17, 17, 17, 0.1)",
      "--app-console-divider-border": "rgba(17, 17, 17, 0.06)",
      "--app-console-filter-idle-background": "rgba(255, 255, 255, 0.76)",
      "--app-console-filter-idle-border": "color-mix(in srgb, var(--foreground) 8%, transparent)",
      "--app-console-filter-idle-foreground": "color-mix(in srgb, var(--foreground) 62%, transparent)",
      "--app-console-filter-idle-hover-background": "rgba(255, 255, 255, 0.96)",
      "--app-console-filter-idle-hover-foreground": "color-mix(in srgb, var(--foreground) 92%, transparent)",
      "--app-console-filter-active-background": "hsl(var(--foreground))",
      "--app-console-filter-active-border": "color-mix(in srgb, var(--foreground) 10%, transparent)",
      "--app-console-filter-active-foreground": "hsl(var(--background))",
      "--app-console-chip-background": "rgba(255, 255, 255, 0.74)",
      "--app-console-chip-border": "color-mix(in srgb, var(--foreground) 8%, transparent)",
      "--app-console-chip-foreground": "color-mix(in srgb, var(--foreground) 70%, transparent)",
      "--app-console-entry-background": "rgba(255, 255, 255, 0.66)",
      "--app-console-entry-border": "color-mix(in srgb, var(--foreground) 8%, transparent)",
      "--app-console-entry-hover-background": "rgba(255, 255, 255, 0.84)",
      "--app-console-entry-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.62)",
      "--app-console-detail-background": "rgba(17, 17, 17, 0.03)",
      "--app-console-detail-border": "color-mix(in srgb, var(--foreground) 8%, transparent)",
      "--app-console-detail-foreground": "color-mix(in srgb, var(--foreground) 74%, transparent)",
      "--app-button-primary-shadow": "0 16px 28px -22px rgba(17, 17, 17, 0.38)",
      "--app-button-outline-background": "rgba(255, 255, 255, 0.74)",
      "--app-button-outline-hover-background": "rgba(255, 255, 255, 0.96)",
      "--app-button-secondary-background": "rgba(17, 17, 17, 0.06)",
      "--app-button-secondary-hover-background": "rgba(17, 17, 17, 0.09)",
      "--app-tone-sky-surface": "rgba(233, 240, 249, 0.78)",
      "--app-tone-sky-border": "rgba(118, 148, 185, 0.34)",
      "--app-tone-sky-foreground": "rgb(64 95 130)",
      "--app-tone-sky-solid": "rgb(90 128 174)",
      "--app-tone-emerald-surface": "rgba(229, 240, 233, 0.84)",
      "--app-tone-emerald-border": "rgba(105, 145, 119, 0.34)",
      "--app-tone-emerald-foreground": "rgb(46 105 72)",
      "--app-tone-emerald-solid": "rgb(63 134 92)",
      "--app-tone-amber-surface": "rgba(247, 237, 220, 0.86)",
      "--app-tone-amber-border": "rgba(180, 141, 82, 0.34)",
      "--app-tone-amber-foreground": "rgb(135 93 36)",
      "--app-tone-amber-solid": "rgb(193 136 52)",
      "--app-tone-plum-surface": "rgba(240, 233, 246, 0.82)",
      "--app-tone-plum-border": "rgba(145, 125, 173, 0.34)",
      "--app-tone-plum-foreground": "rgb(108 81 138)",
      "--app-tone-plum-solid": "rgb(136 103 171)",
      "--app-tone-rose-surface": "rgba(245, 229, 230, 0.82)",
      "--app-tone-rose-border": "rgba(177, 118, 122, 0.34)",
      "--app-tone-rose-foreground": "rgb(140 67 74)",
      "--app-tone-rose-solid": "rgb(187 92 103)"
    }
  },
  "blue-violet": {
    appearance: "light",
    accent: "blue",
    contrast: "default",
    scale: "default",
    radius: "default",
    surface: "defined",
    motion: "normal",
    tokens: {
      "--background": "#F7F8FF",
      "--foreground": "#0A0A28",
      "--card": "#FFFFFF",
      "--card-foreground": "#0A0A28",
      "--popover": "#FFFFFF",
      "--popover-foreground": "#0A0A28",
      "--primary": "#555AFF",
      "--primary-foreground": "#FFFFFF",
      "--secondary": "#F5F7FC",
      "--secondary-foreground": "rgba(10, 10, 40, 0.8)",
      "--muted": "#F5F7FC",
      "--muted-foreground": "rgba(10, 10, 40, 0.55)",
      "--accent": "#EEEEFF",
      "--accent-strong": "#555AFF",
      "--accent-soft": "rgba(85, 90, 255, 0.12)",
      "--accent-foreground": "#0A0A28",
      "--destructive": "#F02D2D",
      "--destructive-foreground": "#FFFFFF",
      "--border": "rgba(10, 10, 40, 0.1)",
      "--input": "rgba(10, 10, 40, 0.1)",
      "--ring": "#555AFF",
      "--sidebar": "#F2F3FF",
      "--sidebar-foreground": "#0A0A28",
      "--sidebar-primary": "#555AFF",
      "--sidebar-primary-foreground": "#FFFFFF",
      "--sidebar-accent": "#EEEEFF",
      "--sidebar-accent-foreground": "rgba(10, 10, 40, 0.8)",
      "--sidebar-border": "rgba(10, 10, 40, 0.1)",
      "--sidebar-ring": "#555AFF",
      "--selection-background": "rgba(85, 90, 255, 0.18)",
      "--selection-foreground": "#0A0A28",
      "--selection-code-background": "rgba(85, 90, 255, 0.22)",
      "--selection-code-foreground": "#0A0A28",
      "--selection-inverse-background": "rgba(10, 10, 40, 0.72)",
      "--selection-inverse-foreground": "#FFFFFF",
      "--selection-inverse-code-background": "rgba(10, 10, 40, 0.82)",
      "--selection-inverse-code-foreground": "#FFFFFF",
      "--app-shell-background": "#F7F8FF",
      "--app-shell-gradient":
        "radial-gradient(circle at top left, rgba(140, 85, 255, 0.12), transparent 30%), radial-gradient(circle at 82% 4%, rgba(85, 90, 255, 0.14), transparent 24%), linear-gradient(180deg, #f9f9ff 0%, #eef1ff 100%)",
      "--app-topbar-background": "rgba(255, 255, 255, 0.9)",
      "--app-topbar-border": "rgba(10, 10, 40, 0.08)",
      "--app-topbar-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 14px 28px -28px rgba(85, 90, 255, 0.28)",
      "--app-topbar-chip-background": "linear-gradient(180deg, rgba(255, 255, 255, 0.98) 0%, rgba(244, 238, 255, 0.96) 100%)",
      "--app-topbar-chip-border": "rgba(10, 10, 40, 0.1)",
      "--app-topbar-chip-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.92)",
      "--app-topbar-chip-hover-background": "#F4EEFF",
      "--app-topbar-control-idle-background": "rgba(85, 90, 255, 0.06)",
      "--app-topbar-control-idle-border": "rgba(10, 10, 40, 0.08)",
      "--app-topbar-control-idle-foreground": "rgba(10, 10, 40, 0.65)",
      "--app-topbar-control-idle-hover-background": "rgba(85, 90, 255, 0.12)",
      "--app-topbar-control-idle-hover-foreground": "rgba(10, 10, 40, 0.92)",
      "--app-topbar-control-active-background": "#EEEEFF",
      "--app-topbar-control-active-border": "rgba(85, 90, 255, 0.2)",
      "--app-topbar-control-active-foreground": "#0A0A28",
      "--app-topbar-control-active-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.88), 0 10px 20px -18px rgba(85, 90, 255, 0.32)",
      "--app-sidebar-background": "linear-gradient(180deg, rgba(245, 246, 255, 0.98) 0%, rgba(236, 239, 255, 1) 100%)",
      "--app-sidebar-border": "rgba(255, 255, 255, 0.72)",
      "--app-main-background": "linear-gradient(180deg, rgba(248, 249, 255, 0.96) 0%, rgba(243, 245, 255, 1) 100%)",
      "--app-main-overlay": "rgba(255, 255, 255, 0.52)",
      "--app-main-surface-glow": "linear-gradient(180deg, rgba(140, 85, 255, 0.08) 0%, rgba(85, 90, 255, 0.04) 22%, transparent 42%)",
      "--app-pane-background": "linear-gradient(180deg, rgba(255, 255, 255, 0.92) 0%, rgba(248, 249, 255, 0.98) 100%)",
      "--app-pane-border": "rgba(10, 10, 40, 0.08)",
      "--app-pane-shadow": "rgba(85, 90, 255, 0.14)",
      "--app-section-background": "linear-gradient(180deg, rgba(255, 255, 255, 0.96) 0%, rgba(247, 248, 255, 1) 100%)",
      "--app-section-border": "rgba(10, 10, 40, 0.08)",
      "--app-section-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.88), 0 18px 36px -34px rgba(85, 90, 255, 0.22)",
      "--app-subsection-background": "linear-gradient(180deg, rgba(255, 255, 255, 0.7) 0%, rgba(244, 247, 255, 0.92) 100%)",
      "--app-subsection-border": "rgba(10, 10, 40, 0.07)",
      "--app-panel-card-background": "linear-gradient(180deg, rgba(255, 255, 255, 0.98) 0%, rgba(246, 248, 255, 1) 100%)",
      "--app-panel-card-border": "rgba(10, 10, 40, 0.08)",
      "--app-panel-card-shadow": "0 20px 40px -34px rgba(85, 90, 255, 0.2)",
      "--app-subtle-panel-background": "rgba(238, 242, 255, 0.7)",
      "--app-list-item-hover-background": "rgba(85, 90, 255, 0.08)",
      "--app-list-item-active-border": "rgba(85, 90, 255, 0.22)",
      "--app-list-item-active-background": "#EEEEFF",
      "--app-list-item-active-shadow": "0 16px 30px -28px rgba(85, 90, 255, 0.3)",
      "--app-list-item-child-active-background": "rgba(140, 85, 255, 0.1)",
      "--app-list-item-child-active-border": "transparent",
      "--app-list-item-icon-background": "rgba(85, 90, 255, 0.08)",
      "--app-list-item-icon-foreground": "rgba(10, 10, 40, 0.55)",
      "--app-list-item-icon-active-background": "rgba(85, 90, 255, 0.14)",
      "--app-list-item-icon-active-foreground": "#474CD6",
      "--app-list-item-control-hover-background": "rgba(85, 90, 255, 0.1)",
      "--app-list-item-control-hover-foreground": "#474CD6",
      "--app-list-item-branch-line": "rgba(10, 10, 40, 0.14)",
      "--app-list-item-branch-line-active": "rgba(85, 90, 255, 0.46)",
      "--app-segmented-background": "rgba(85, 90, 255, 0.08)",
      "--app-segmented-border": "rgba(10, 10, 40, 0.1)",
      "--app-info-chip-background": "linear-gradient(180deg, rgba(255, 255, 255, 1) 0%, rgba(244, 238, 255, 0.92) 100%)",
      "--app-info-chip-border": "rgba(10, 10, 40, 0.1)",
      "--app-info-chip-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.92), 0 12px 24px -24px rgba(85, 90, 255, 0.18)",
      "--app-info-panel-background": "linear-gradient(180deg, rgba(255, 255, 255, 0.96) 0%, rgba(244, 247, 255, 0.94) 100%)",
      "--app-info-panel-border": "rgba(10, 10, 40, 0.08)",
      "--app-info-panel-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.74), 0 16px 30px -28px rgba(85, 90, 255, 0.16)",
      "--app-info-inline-background": "rgba(238, 242, 255, 0.84)",
      "--app-info-inline-border": "rgba(85, 90, 255, 0.14)",
      "--app-info-inline-foreground": "rgba(10, 10, 40, 0.8)",
      "--app-code-panel-background": "rgba(245, 247, 255, 0.96)",
      "--app-code-panel-border": "rgba(10, 10, 40, 0.08)",
      "--app-code-panel-foreground": "rgba(10, 10, 40, 0.8)",
      "--app-data-grid-header-background": "rgba(245, 247, 255, 0.96)",
      "--app-data-grid-header-border": "rgba(10, 10, 40, 0.08)",
      "--app-data-grid-cell-border": "rgba(10, 10, 40, 0.08)",
      "--app-data-grid-row-odd": "rgba(255, 255, 255, 0.72)",
      "--app-data-grid-row-even": "rgba(85, 90, 255, 0.03)",
      "--app-data-grid-row-hover": "rgba(85, 90, 255, 0.08)",
      "--app-data-grid-row-selected": "rgba(85, 90, 255, 0.12)",
      "--app-console-background": "linear-gradient(180deg, rgba(255, 255, 255, 0.98) 0%, rgba(242, 245, 255, 1) 100%)",
      "--app-console-border": "rgba(10, 10, 40, 0.08)",
      "--app-console-shadow": "0 -18px 44px -38px rgba(85, 90, 255, 0.3)",
      "--app-console-resizer-background": "rgba(85, 90, 255, 0.08)",
      "--app-console-resizer-hover-background": "rgba(85, 90, 255, 0.16)",
      "--app-console-resizer-active-background": "rgba(85, 90, 255, 0.24)",
      "--app-console-divider-border": "rgba(10, 10, 40, 0.08)",
      "--app-console-filter-idle-background": "rgba(255, 255, 255, 0.92)",
      "--app-console-filter-idle-border": "rgba(10, 10, 40, 0.08)",
      "--app-console-filter-idle-foreground": "rgba(10, 10, 40, 0.65)",
      "--app-console-filter-idle-hover-background": "#F4EEFF",
      "--app-console-filter-idle-hover-foreground": "rgba(10, 10, 40, 0.92)",
      "--app-console-filter-active-background": "#555AFF",
      "--app-console-filter-active-border": "rgba(85, 90, 255, 0.24)",
      "--app-console-filter-active-foreground": "#FFFFFF",
      "--app-console-chip-background": "rgba(238, 242, 255, 0.9)",
      "--app-console-chip-border": "rgba(85, 90, 255, 0.14)",
      "--app-console-chip-foreground": "rgba(10, 10, 40, 0.72)",
      "--app-console-entry-background": "rgba(255, 255, 255, 0.88)",
      "--app-console-entry-border": "rgba(10, 10, 40, 0.08)",
      "--app-console-entry-hover-background": "rgba(244, 238, 255, 0.86)",
      "--app-console-entry-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.72)",
      "--app-console-detail-background": "rgba(85, 90, 255, 0.05)",
      "--app-console-detail-border": "rgba(85, 90, 255, 0.12)",
      "--app-console-detail-foreground": "rgba(10, 10, 40, 0.74)",
      "--app-button-primary-shadow": "0 16px 28px -22px rgba(85, 90, 255, 0.36)",
      "--app-button-outline-background": "rgba(255, 255, 255, 0.88)",
      "--app-button-outline-hover-background": "#F4EEFF",
      "--app-button-secondary-background": "rgba(85, 90, 255, 0.08)",
      "--app-button-secondary-hover-background": "rgba(85, 90, 255, 0.14)",
      "--app-tone-sky-surface": "#EBF2FF",
      "--app-tone-sky-border": "rgba(55, 130, 255, 0.22)",
      "--app-tone-sky-foreground": "rgb(44 104 217)",
      "--app-tone-sky-solid": "#3782FF",
      "--app-tone-emerald-surface": "#E8F8F2",
      "--app-tone-emerald-border": "rgba(30, 180, 120, 0.22)",
      "--app-tone-emerald-foreground": "rgb(20 135 89)",
      "--app-tone-emerald-solid": "#1EB478",
      "--app-tone-amber-surface": "#FFF8E6",
      "--app-tone-amber-border": "rgba(255, 180, 0, 0.24)",
      "--app-tone-amber-foreground": "rgb(166 118 0)",
      "--app-tone-amber-solid": "#FFB400",
      "--app-tone-plum-surface": "#F4EEFF",
      "--app-tone-plum-border": "rgba(140, 85, 255, 0.24)",
      "--app-tone-plum-foreground": "rgb(108 70 217)",
      "--app-tone-plum-solid": "#8C55FF",
      "--app-tone-rose-surface": "#FEEAEA",
      "--app-tone-rose-border": "rgba(240, 45, 45, 0.2)",
      "--app-tone-rose-foreground": "rgb(196 34 34)",
      "--app-tone-rose-solid": "#F02D2D"
    }
  }
};

const appThemeTokenNames = Array.from(
  new Set(Object.values(appThemePresets).flatMap((preset) => Object.keys(preset.tokens ?? {})))
) as Array<`--${string}`>;

export function isAppThemeName(value: string): value is AppThemeName {
  return appThemeNames.has(value as AppThemeName);
}

function readStoredAppTheme(): AppThemeName {
  if (typeof window === "undefined") {
    return defaultAppTheme;
  }

  const storedTheme = window.localStorage.getItem(APP_THEME_STORAGE_KEY);
  return storedTheme && isAppThemeName(storedTheme) ? storedTheme : defaultAppTheme;
}

function applyAppTheme(theme: AppThemeName) {
  const root = document.documentElement;
  const preset = appThemePresets[theme] ?? appThemePresets.default;

  root.dataset.theme = theme;
  root.dataset.appearance = preset.appearance;
  root.dataset.accent = preset.accent;
  root.dataset.contrast = preset.contrast;
  root.dataset.scale = preset.scale;
  root.dataset.radius = preset.radius;
  root.dataset.surface = preset.surface;
  root.dataset.motion = preset.motion;
  for (const tokenName of appThemeTokenNames) {
    root.style.removeProperty(tokenName);
  }
  for (const [tokenName, tokenValue] of Object.entries(preset.tokens ?? {})) {
    root.style.setProperty(tokenName, tokenValue);
  }
  root.classList.toggle("dark", preset.appearance === "dark");
  root.style.colorScheme = preset.appearance;
}

export function useAppTheme() {
  const [theme, setTheme] = useState<AppThemeName>(() => readStoredAppTheme());

  useLayoutEffect(() => {
    applyAppTheme(theme);
    window.localStorage.setItem(APP_THEME_STORAGE_KEY, theme);
  }, [theme]);

  return {
    theme,
    setTheme
  };
}
