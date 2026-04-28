export type AppThemeName = "default" | "blue-violet" | "cyberpunk";

export type AppThemeOption = {
  value: AppThemeName;
  label: string;
};

export type AppThemePreset = {
  appearance: "light" | "dark";
  accent: "graphite" | "blue" | "emerald" | "amber";
  contrast: "soft" | "default" | "strong";
  scale: "compact" | "default" | "comfortable";
  radius: "compact" | "default" | "relaxed";
  surface: "soft" | "default" | "defined";
  motion: "normal" | "reduced";
  tokens?: Record<`--${string}`, string>;
};

export type AppThemeDefinition = AppThemeOption & {
  preset: AppThemePreset;
};
