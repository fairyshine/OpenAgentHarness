import { AppHeader } from "./layout/AppHeader";
import { AppSidebar } from "./layout/AppSidebar";
import { RuntimeWorkspace } from "./layout/RuntimeWorkspace";
import { ProviderWorkspace } from "./provider/ProviderWorkspace";
import { StorageWorkspace } from "./storage/StorageWorkspace";
import { useAppController } from "./use-app-controller";

export function AppScreen() {
  const controller = useAppController();

  return (
    <div className="h-screen flex flex-col bg-background overflow-x-hidden">
      <AppHeader {...controller.headerProps} />

      <div className="flex-1 min-h-0 flex overflow-hidden">
        <AppSidebar {...controller.sidebarSurfaceProps} />

        <main className="flex-1 min-h-0 flex flex-col min-w-0">
          {controller.errorMessage ? (
            <div className="border-b border-rose-200/80 bg-rose-50/75 px-6 py-3 text-sm text-rose-700 dark:border-rose-800/80 dark:bg-rose-950/40 dark:text-rose-400">{controller.errorMessage}</div>
          ) : null}

          {controller.surfaceMode === "storage" ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-4 md:px-5 md:py-5">
              <StorageWorkspace {...controller.storageSurfaceProps} />
            </div>
          ) : controller.surfaceMode === "provider" ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-4 md:px-5 md:py-5">
              <ProviderWorkspace {...controller.providerSurfaceProps} />
            </div>
          ) : (
            <RuntimeWorkspace {...controller.runtimeDetailSurfaceProps} />
          )}
        </main>
      </div>
    </div>
  );
}
