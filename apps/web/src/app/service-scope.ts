import type { ServiceScope } from "./support-types";

const SERVICE_SCOPE_ALL = "__all__";
const SERVICE_SCOPE_DEFAULT = "__default__";

function normalizeServiceName(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === SERVICE_SCOPE_ALL || normalized === SERVICE_SCOPE_DEFAULT) {
    return undefined;
  }

  return normalized;
}

function normalizeServiceScope(value: string | undefined): ServiceScope {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === SERVICE_SCOPE_ALL) {
    return SERVICE_SCOPE_ALL;
  }

  if (trimmed === SERVICE_SCOPE_DEFAULT) {
    return SERVICE_SCOPE_DEFAULT;
  }

  return normalizeServiceName(trimmed) ?? SERVICE_SCOPE_ALL;
}

function serviceScopeMatches(scope: string, serviceName: string | undefined): boolean {
  const normalizedScope = normalizeServiceScope(scope);
  if (normalizedScope === SERVICE_SCOPE_ALL) {
    return true;
  }

  if (normalizedScope === SERVICE_SCOPE_DEFAULT) {
    return !normalizeServiceName(serviceName);
  }

  return normalizeServiceName(serviceName) === normalizedScope;
}

function serviceScopeLabel(scope: string): string {
  const normalizedScope = normalizeServiceScope(scope);
  if (normalizedScope === SERVICE_SCOPE_ALL) {
    return "All Services";
  }

  if (normalizedScope === SERVICE_SCOPE_DEFAULT) {
    return "Default (OAH)";
  }

  return normalizedScope;
}

function toStorageServiceNameParam(scope: string): string | undefined {
  const normalizedScope = normalizeServiceScope(scope);
  if (normalizedScope === SERVICE_SCOPE_ALL) {
    return undefined;
  }

  if (normalizedScope === SERVICE_SCOPE_DEFAULT) {
    return "@default";
  }

  return normalizedScope;
}

export {
  SERVICE_SCOPE_ALL,
  SERVICE_SCOPE_DEFAULT,
  normalizeServiceName,
  normalizeServiceScope,
  serviceScopeLabel,
  serviceScopeMatches,
  toStorageServiceNameParam
};
