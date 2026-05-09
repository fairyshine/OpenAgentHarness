import type { AppThemeName } from "../theme";
import type { useAppController } from "../use-app-controller";

type SidebarProps = ReturnType<typeof useAppController>["sidebarSurfaceProps"] & {
  theme: AppThemeName;
  onThemeChange: (theme: AppThemeName) => void;
};

export type { SidebarProps };
