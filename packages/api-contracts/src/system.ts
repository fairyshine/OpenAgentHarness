import { z } from "zod";

export const systemApiCompatibilitySchema = z.literal("oah/v1");
export const systemProductSchema = z.literal("open-agent-harness");
export const systemEditionSchema = z.enum(["enterprise", "personal"]);
export const systemRuntimeModeSchema = z.enum(["daemon", "embedded", "compose", "kubernetes", "split"]);
export const systemDeploymentKindSchema = z.enum(["oah", "oap"]);

export const systemCapabilitiesSchema = z.object({
  localDaemonControl: z.boolean(),
  localWorkspacePaths: z.boolean(),
  workspaceRegistration: z.boolean(),
  storageInspection: z.boolean(),
  assetManagement: z.boolean().default(false),
  modelManagement: z.boolean(),
  localDaemonSupervisor: z.boolean()
});

export const systemProfileSchema = z.object({
  apiCompatibility: systemApiCompatibilitySchema,
  product: systemProductSchema,
  edition: systemEditionSchema,
  runtimeMode: systemRuntimeModeSchema,
  deploymentKind: systemDeploymentKindSchema,
  displayName: z.string().min(1),
  capabilities: systemCapabilitiesSchema
});

export type SystemEdition = z.infer<typeof systemEditionSchema>;
export type SystemRuntimeMode = z.infer<typeof systemRuntimeModeSchema>;
export type SystemDeploymentKind = z.infer<typeof systemDeploymentKindSchema>;
export type SystemCapabilities = z.infer<typeof systemCapabilitiesSchema>;
export type SystemProfile = z.infer<typeof systemProfileSchema>;

export function formatSystemProfileDisplayName(profile: Pick<SystemProfile, "deploymentKind" | "edition" | "runtimeMode">): string {
  if (profile.deploymentKind === "oap" || profile.edition === "personal") {
    return "OAP Local";
  }

  if (profile.runtimeMode === "kubernetes") {
    return "OAH Kubernetes";
  }

  if (profile.runtimeMode === "compose" || profile.runtimeMode === "split") {
    return "OAH Docker";
  }

  return "OAH Server";
}
