export function normalizeServiceName(serviceName: string | undefined): string | undefined {
  const trimmed = serviceName?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed === "@default") {
    return "@default";
  }

  return trimmed.toLowerCase();
}
