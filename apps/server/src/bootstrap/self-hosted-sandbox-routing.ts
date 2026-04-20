import { lookup } from "node:dns/promises";
import { setTimeout as sleep } from "node:timers/promises";

import type {
  WorkerRegistry,
  WorkerRegistryEntry,
  WorkspacePlacementEntry,
  WorkspacePlacementRegistry,
  WorkspaceRecord
} from "@oah/engine-core";

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function defaultPortForProtocol(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}

function normalizeBaseUrl(input: string): URL | undefined {
  try {
    return new URL(input.trim());
  } catch {
    return undefined;
  }
}

function mergeSandboxBaseUrl(templateBaseUrl: string, targetBaseUrl: string): string | undefined {
  const template = normalizeBaseUrl(templateBaseUrl);
  const target = normalizeBaseUrl(targetBaseUrl);
  if (!template || !target) {
    return undefined;
  }

  return `${target.origin}${template.pathname}${template.search}`;
}

async function defaultResolveHostAddresses(hostname: string): Promise<string[]> {
  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return [...new Set(records.map((record) => record.address))];
  } catch {
    return [];
  }
}

async function resolveBaseUrlEndpoints(
  baseUrl: string,
  resolveHostAddresses: (hostname: string) => Promise<string[]>
): Promise<Set<string>> {
  const parsed = normalizeBaseUrl(baseUrl);
  if (!parsed) {
    return new Set();
  }

  const port = parsed.port || defaultPortForProtocol(parsed.protocol);
  const addresses = await resolveHostAddresses(parsed.hostname);
  const endpoints = new Set<string>([`${parsed.hostname}:${port}`]);
  for (const address of addresses) {
    endpoints.add(`${address}:${port}`);
  }
  return endpoints;
}

async function expandCandidateBaseUrls(
  baseUrl: string,
  resolveHostAddresses: (hostname: string) => Promise<string[]>
): Promise<string[]> {
  const parsed = normalizeBaseUrl(baseUrl);
  if (!parsed) {
    return [baseUrl];
  }

  const addresses = await resolveHostAddresses(parsed.hostname);
  if (addresses.length === 0) {
    return [baseUrl];
  }

  const candidates = new Set<string>();
  for (const address of addresses) {
    const candidate = new URL(parsed.toString());
    candidate.hostname = address;
    candidates.add(candidate.toString().replace(/\/+$/u, ""));
  }

  return [...candidates];
}

async function expandCandidateBaseUrlsFromActiveWorkers(
  baseUrl: string,
  workerRegistry: Pick<WorkerRegistry, "listActive">
): Promise<string[]> {
  if (typeof workerRegistry.listActive !== "function") {
    return [];
  }

  const activeWorkers = await workerRegistry.listActive();
  const candidates = new Set<string>();
  for (const worker of activeWorkers) {
    if (worker.processKind !== "standalone" || worker.health !== "healthy") {
      continue;
    }

    const candidateBaseUrl = mergeSandboxBaseUrl(baseUrl, worker.ownerBaseUrl ?? "");
    if (candidateBaseUrl) {
      candidates.add(candidateBaseUrl.replace(/\/+$/u, ""));
    }
  }

  return [...candidates].sort((left, right) => left.localeCompare(right));
}

function placementPriority(left: WorkspacePlacementEntry, right: WorkspacePlacementEntry): number {
  return right.updatedAt.localeCompare(left.updatedAt);
}

function stableHash(input: string): number {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }
  return hash;
}

interface CandidateScore {
  baseUrl: string;
  foreignOwnerCount: number;
  workspaceCount: number;
  tieBreak: number;
}

function placementOwnerId(placement: Pick<WorkspacePlacementEntry, "ownerId">): string | undefined {
  return trimToUndefined(placement.ownerId);
}

async function mapPinnedOwnerCandidates(options: {
  baseUrl: string;
  placements: WorkspacePlacementEntry[];
  candidateBaseUrls: string[];
  resolveHostAddresses: (hostname: string) => Promise<string[]>;
}): Promise<Map<string, string>> {
  const candidateEndpoints = new Map<string, Set<string>>(
    await Promise.all(
      options.candidateBaseUrls.map(
        async (candidateBaseUrl): Promise<readonly [string, Set<string>]> => [
          candidateBaseUrl,
          await resolveBaseUrlEndpoints(candidateBaseUrl, options.resolveHostAddresses)
        ]
      )
    )
  );
  const pinnedOwners = new Map<string, string>();

  for (const placement of [...options.placements].sort(placementPriority)) {
    const ownerId = placementOwnerId(placement);
    const ownerBaseUrl = trimToUndefined(placement.ownerBaseUrl);
    if (!ownerId || !ownerBaseUrl || pinnedOwners.has(ownerId)) {
      continue;
    }

    const placementEndpoints = await resolveBaseUrlEndpoints(
      mergeSandboxBaseUrl(options.baseUrl, ownerBaseUrl) ?? ownerBaseUrl,
      options.resolveHostAddresses
    );
    const matchedCandidate = options.candidateBaseUrls.find((candidateBaseUrl) => {
      const endpoints = candidateEndpoints.get(candidateBaseUrl);
      return endpoints ? [...placementEndpoints].some((endpoint) => endpoints.has(endpoint)) : false;
    });
    if (matchedCandidate) {
      pinnedOwners.set(ownerId, matchedCandidate);
    }
  }

  return pinnedOwners;
}

function listTrackedOwnerIds(placements: WorkspacePlacementEntry[]): string[] {
  return [...new Set(placements.map((placement) => placementOwnerId(placement)).filter((ownerId): ownerId is string => Boolean(ownerId)))].sort(
    (left, right) => left.localeCompare(right)
  );
}

function assignPendingOwnerCandidate(input: {
  ownerId: string;
  trackedOwnerIds: string[];
  pinnedOwners: Map<string, string>;
  candidateBaseUrls: string[];
}): { baseUrl: string | undefined; waitForReplica: boolean } {
  const pendingOwnerIds = input.trackedOwnerIds.filter((trackedOwnerId) => !input.pinnedOwners.has(trackedOwnerId));
  if (!pendingOwnerIds.includes(input.ownerId)) {
    return {
      baseUrl: input.pinnedOwners.get(input.ownerId),
      waitForReplica: false
    };
  }

  const pinnedCandidateBaseUrls = new Set(input.pinnedOwners.values());
  const availableCandidates = [...input.candidateBaseUrls]
    .filter((candidateBaseUrl) => !pinnedCandidateBaseUrls.has(candidateBaseUrl))
    .sort((left, right) => left.localeCompare(right));
  if (availableCandidates.length < pendingOwnerIds.length) {
    return {
      baseUrl: undefined,
      waitForReplica: true
    };
  }

  return {
    baseUrl: availableCandidates[pendingOwnerIds.indexOf(input.ownerId)],
    waitForReplica: false
  };
}

async function scoreCandidateBaseUrls(options: {
  baseUrl: string;
  ownerId: string;
  placements: WorkspacePlacementEntry[];
  candidateBaseUrls: string[];
  resolveHostAddresses: (hostname: string) => Promise<string[]>;
}): Promise<CandidateScore[]> {
  const placementEndpoints = new Map<string, Set<string>>();
  for (const placement of options.placements) {
    const placementBaseUrl = trimToUndefined(placement.ownerBaseUrl);
    if (!placementBaseUrl) {
      continue;
    }
    placementEndpoints.set(
      placement.workspaceId,
      await resolveBaseUrlEndpoints(
        mergeSandboxBaseUrl(options.baseUrl, placementBaseUrl) ?? placementBaseUrl,
        options.resolveHostAddresses
      )
    );
  }

  return Promise.all(
    options.candidateBaseUrls.map(async (candidateBaseUrl) => {
      const endpoints = await resolveBaseUrlEndpoints(candidateBaseUrl, options.resolveHostAddresses);
      const foreignOwners = new Set<string>();
      let workspaceCount = 0;

      for (const placement of options.placements) {
        const affinityOwnerId = placementOwnerId(placement);
        const knownEndpoints = placementEndpoints.get(placement.workspaceId);
        if (!knownEndpoints || knownEndpoints.size === 0) {
          continue;
        }

        const matchesCandidate = [...knownEndpoints].some((endpoint) => endpoints.has(endpoint));
        if (!matchesCandidate) {
          continue;
        }

        workspaceCount += 1;
        if (affinityOwnerId && affinityOwnerId !== options.ownerId) {
          foreignOwners.add(affinityOwnerId);
        }
      }

      return {
        baseUrl: candidateBaseUrl,
        foreignOwnerCount: foreignOwners.size,
        workspaceCount,
        tieBreak: stableHash(`${options.ownerId}:${candidateBaseUrl}`)
      } satisfies CandidateScore;
    })
  );
}

function selectBestCandidate(scoredCandidates: CandidateScore[]): CandidateScore | undefined {
  return [...scoredCandidates].sort((left, right) => {
    if (left.foreignOwnerCount !== right.foreignOwnerCount) {
      return left.foreignOwnerCount - right.foreignOwnerCount;
    }
    if (left.workspaceCount !== right.workspaceCount) {
      return left.workspaceCount - right.workspaceCount;
    }
    if (left.tieBreak !== right.tieBreak) {
      return left.tieBreak - right.tieBreak;
    }
    return left.baseUrl.localeCompare(right.baseUrl);
  })[0];
}

function shouldWaitForDedicatedCandidate(input: {
  workerRegistry?: Pick<WorkerRegistry, "listActive"> | undefined;
  scoredCandidates: CandidateScore[];
}): boolean {
  if (!input.workerRegistry || typeof input.workerRegistry.listActive !== "function") {
    return false;
  }

  if (input.scoredCandidates.length === 0) {
    return true;
  }

  return input.scoredCandidates.every((candidate) => candidate.foreignOwnerCount > 0);
}

export async function resolveSelfHostedSandboxCreateBaseUrl(options: {
  baseUrl: string;
  workspace: Pick<WorkspaceRecord, "ownerId"> & { id?: string | undefined };
  workspacePlacementRegistry?: Pick<WorkspacePlacementRegistry, "listAll" | "assignOwnerAffinity"> | undefined;
  workerRegistry?: Pick<WorkerRegistry, "listActive"> | undefined;
  resolveHostAddresses?: ((hostname: string) => Promise<string[]>) | undefined;
  waitForAvailableReplicaMs?: number | undefined;
  pollIntervalMs?: number | undefined;
  sleepFn?: ((ms: number) => Promise<unknown>) | undefined;
}): Promise<string | undefined> {
  const ownerId = trimToUndefined(options.workspace.ownerId);
  if (!ownerId || !options.workspacePlacementRegistry) {
    return undefined;
  }

  const resolveHostAddresses = options.resolveHostAddresses ?? defaultResolveHostAddresses;
  const workspaceId = trimToUndefined(options.workspace.id);
  if (workspaceId) {
    await options.workspacePlacementRegistry.assignOwnerAffinity(workspaceId, ownerId, {
      overwrite: false,
      updatedAt: new Date().toISOString()
    });
  }

  const waitForAvailableReplicaMs =
    typeof options.workerRegistry?.listActive === "function" ? Math.max(0, options.waitForAvailableReplicaMs ?? 30_000) : 0;
  const pollIntervalMs = Math.max(25, options.pollIntervalMs ?? 250);
  const waitUntil = Date.now() + waitForAvailableReplicaMs;
  const sleepFn = options.sleepFn ?? sleep;
  let fallbackSelection:
    | {
        baseUrl: string | undefined;
        candidateCount: number;
        source: "worker_registry" | "dns";
      }
    | undefined;

  while (true) {
    const workerRegistryCandidates = options.workerRegistry
      ? await expandCandidateBaseUrlsFromActiveWorkers(options.baseUrl, options.workerRegistry)
      : [];
    const candidateBaseUrls =
      workerRegistryCandidates.length > 0
        ? workerRegistryCandidates
        : await expandCandidateBaseUrls(options.baseUrl, resolveHostAddresses);
    const source = workerRegistryCandidates.length > 0 ? "worker_registry" : "dns";
    const placements = (await options.workspacePlacementRegistry.listAll()).filter((placement) => placement.state !== "evicted");
    const existingOwnerPlacement = placements
      .filter((placement) => placementOwnerId(placement) === ownerId && trimToUndefined(placement.ownerBaseUrl))
      .sort(placementPriority)[0];
    if (existingOwnerPlacement?.ownerBaseUrl) {
      return mergeSandboxBaseUrl(options.baseUrl, existingOwnerPlacement.ownerBaseUrl) ?? undefined;
    }

    const scoredCandidates = await scoreCandidateBaseUrls({
      baseUrl: options.baseUrl,
      ownerId,
      placements,
      candidateBaseUrls,
      resolveHostAddresses
    });
    const pinnedOwners = await mapPinnedOwnerCandidates({
      baseUrl: options.baseUrl,
      placements,
      candidateBaseUrls,
      resolveHostAddresses
    });
    const pendingOwnerSelection = assignPendingOwnerCandidate({
      ownerId,
      trackedOwnerIds: listTrackedOwnerIds(placements),
      pinnedOwners,
      candidateBaseUrls
    });
    const assignedPendingBaseUrl =
      pendingOwnerSelection.baseUrl &&
      (source === "worker_registry" || candidateBaseUrls.length > 1)
        ? pendingOwnerSelection.baseUrl
        : undefined;
    const selected = selectBestCandidate(scoredCandidates);
    const resolvedBaseUrl =
      selected && (source === "worker_registry" || candidateBaseUrls.length > 1) ? selected.baseUrl : undefined;

    fallbackSelection = {
      baseUrl: resolvedBaseUrl,
      candidateCount: candidateBaseUrls.length,
      source
    };

    if (assignedPendingBaseUrl) {
      return assignedPendingBaseUrl;
    }

    if (pendingOwnerSelection.waitForReplica) {
      if (Date.now() >= waitUntil) {
        return fallbackSelection.baseUrl;
      }

      await sleepFn(pollIntervalMs);
      continue;
    }

    if (!shouldWaitForDedicatedCandidate({ workerRegistry: options.workerRegistry, scoredCandidates })) {
      return resolvedBaseUrl;
    }

    if (Date.now() >= waitUntil) {
      return fallbackSelection.baseUrl;
    }

    await sleepFn(pollIntervalMs);
  }
}
