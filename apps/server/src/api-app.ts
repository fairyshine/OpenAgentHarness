import { createBaseApp, registerInternalRoutes } from "./app-core.js";
import { registerPublicRoutes } from "./http/routes/public.js";
import { registerInternalModelRoutes } from "./http/routes/internal-models-lazy.js";
import { registerWorkspaceRoutes } from "./http/routes/workspaces-lazy.js";
import { registerSandboxRoutes } from "./http/routes/sandboxes-lazy.js";
import { registerSessionRoutes } from "./http/routes/sessions-lazy.js";
import type { AppDependencies } from "./http/types.js";

function warmRouteModules(): void {
  void import("./http/routes/workspaces.js");
  void import("./http/routes/sessions.js");
}

export function createApiApp(dependencies: AppDependencies) {
  const app = createBaseApp(dependencies);
  const workspaceMode = dependencies.workspaceMode ?? "multi";

  registerPublicRoutes(app, dependencies, { workspaceMode });
  registerWorkspaceRoutes(app, dependencies, { workspaceMode });
  registerSandboxRoutes(app, dependencies, { workspaceMode });
  registerSessionRoutes(app, dependencies);
  registerInternalRoutes(app, dependencies);
  registerInternalModelRoutes(app, dependencies);
  app.addHook("onReady", async () => {
    warmRouteModules();
  });

  return app;
}
