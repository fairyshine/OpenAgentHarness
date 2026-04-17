import { Suspense, lazy } from "react";

import { AppHeader } from "./layout/AppHeader";
import { AppSidebar } from "./layout/AppSidebar";
import { useUiStore } from "./stores/ui-store";
import { toneBadgeClass } from "./support";
import type { AppThemeName } from "./theme";
import { useAppController } from "./use-app-controller";

const RuntimeWorkspace = lazy(async () => ({
  default: (await import("./layout/RuntimeWorkspace")).RuntimeWorkspace
}));
const RuntimeConsolePanel = lazy(async () => ({
  default: (await import("./console/RuntimeConsolePanel")).RuntimeConsolePanel
}));
const ProviderWorkspace = lazy(async () => ({
  default: (await import("./provider/ProviderWorkspace")).ProviderWorkspace
}));
const StorageWorkspace = lazy(async () => ({
  default: (await import("./storage/StorageWorkspace")).StorageWorkspace
}));

type AppScreenProps = {
  theme: AppThemeName;
  onThemeChange: (theme: AppThemeName) => void;
};

function SurfaceFallback(props: { label: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-8">
      <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3 text-sm text-muted-foreground shadow-[0_10px_30px_-24px_rgba(17,17,17,0.35)]">
        {props.label}
      </div>
    </div>
  );
}

export function AppScreen({ theme, onThemeChange }: AppScreenProps) {
  const controller = useAppController();
  const setSurfaceMode = useUiStore((state) => state.setSurfaceMode);

  return (
    <div className="app-shell h-screen flex flex-col overflow-x-hidden">
      <AppHeader {...controller.headerProps} theme={theme} onThemeChange={onThemeChange} />

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <div className="flex-1 min-h-0 flex overflow-hidden">
          <AppSidebar {...controller.sidebarSurfaceProps} />

          <main className="app-main-surface flex-1 min-h-0 flex flex-col min-w-0">
            {controller.errorMessage ? (
              <div className={`flex items-center justify-between gap-3 border-b px-6 py-3 text-sm ${toneBadgeClass("rose")}`}>
                <span className="min-w-0 flex-1 truncate">{controller.errorMessage}</span>
                <button
                  type="button"
                  onClick={() => {
                    setSurfaceMode("runtime");
                    controller.consolePanelProps.openErrors();
                  }}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition ${toneBadgeClass("rose")} bg-background/86 hover:bg-background`}
                >
                  View details
                </button>
              </div>
            ) : null}

            {controller.surfaceMode === "storage" ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <Suspense fallback={<SurfaceFallback label="Loading storage workbench..." />}>
                  <StorageWorkspace {...controller.storageSurfaceProps} />
                </Suspense>
              </div>
            ) : controller.surfaceMode === "provider" ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <Suspense fallback={<SurfaceFallback label="Loading provider workspace..." />}>
                  <ProviderWorkspace {...controller.providerSurfaceProps} />
                </Suspense>
              </div>
            ) : (
              <Suspense fallback={<SurfaceFallback label="Loading runtime workspace..." />}>
                <RuntimeWorkspace {...controller.runtimeDetailSurfaceProps} />
              </Suspense>
            )}
          </main>
        </div>

        <Suspense fallback={null}>
          <RuntimeConsolePanel {...controller.consolePanelProps} />
        </Suspense>
      </div>
    </div>
  );
}
