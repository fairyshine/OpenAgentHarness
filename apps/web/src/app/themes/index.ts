import { blueVioletTheme } from "./blue-violet";
import { cyberpunkTheme } from "./cyberpunk";
import { defaultTheme } from "./default";
import type { AppThemeDefinition, AppThemeName, AppThemeOption, AppThemePreset } from "./types";

export type { AppThemeName, AppThemePreset } from "./types";

const appThemes = [defaultTheme, blueVioletTheme, cyberpunkTheme] satisfies AppThemeDefinition[];

export const appThemeOptions: AppThemeOption[] = appThemes.map(({ value, label }) => ({ value, label }));

export const appThemePresets = Object.fromEntries(
  appThemes.map(({ value, preset }) => [value, preset])
) as Record<AppThemeName, AppThemePreset>;
