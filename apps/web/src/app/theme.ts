import { useLayoutEffect, useState } from "react";

import { appThemeOptions, appThemePresets, type AppThemeName } from "./themes";

export { appThemeOptions, type AppThemeName } from "./themes";

const APP_THEME_STORAGE_KEY = "oah.web.theme";

const appThemeNames = new Set<AppThemeName>(appThemeOptions.map((option) => option.value));

export const defaultAppTheme: AppThemeName = "default";

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
