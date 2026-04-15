import path from "node:path";

import { loadServerConfig } from "@oah/config";
import { createRedisSessionRunQueue, createRedisWorkerRegistry } from "@oah/storage-redis";

import { RedisWorkerController, resolveStandaloneWorkerControllerConfig } from "./controller.js";
import {
  createWorkerControllerLeaderElector,
  resolveWorkerControllerLeaderElectionConfig
} from "./leader-election.js";
import { createWorkerReplicaTarget, resolveWorkerReplicaTargetConfig } from "./scale-target.js";

function parseConfigPath(argv: string[]): { path: string; explicit: boolean } {
  const configFlagIndex = argv.findIndex((value) => value === "--config");
  if (configFlagIndex >= 0) {
    const configPath = argv[configFlagIndex + 1];
    if (!configPath) {
      throw new Error("Missing value for --config.");
    }

    return {
      path: path.resolve(process.cwd(), configPath),
      explicit: true
    };
  }

  const envPath = process.env.OAH_CONFIG;
  if (envPath) {
    return {
      path: path.resolve(process.cwd(), envPath),
      explicit: true
    };
  }

  return {
    path: path.resolve(process.cwd(), "server.yaml"),
    explicit: false
  };
}

async function main() {
  const configPath = parseConfigPath(process.argv.slice(2));
  const config = await loadServerConfig(configPath.path);
  if (!config.storage.redis_url) {
    throw new Error("worker-controller requires storage.redis_url.");
  }

  const [queue, registry] = await Promise.all([
    createRedisSessionRunQueue({
      url: config.storage.redis_url
    }),
    createRedisWorkerRegistry({
      url: config.storage.redis_url
    })
  ]);

  const controller = new RedisWorkerController({
    queue,
    registry,
    config: resolveStandaloneWorkerControllerConfig(config),
    scaleTarget: createWorkerReplicaTarget(resolveWorkerReplicaTargetConfig(config)),
    logger: {
      info(message) {
        console.info(message);
      },
      warn(message, error) {
        console.warn(message, error);
      }
    }
  });
  const leaderElector = createWorkerControllerLeaderElector(resolveWorkerControllerLeaderElectionConfig(config), {
    logger: {
      info(message) {
        console.info(message);
      },
      warn(message, error) {
        console.warn(message, error);
      }
    },
    async onGainedLeadership() {
      controller.start({
        skipInitialEvaluation: true
      });
      const initial = await controller.evaluateNow("startup");
      console.log(
        `Open Agent Harness worker-controller leader active (desiredReplicas=${initial.desiredReplicas}, suggestedReplicas=${initial.suggestedReplicas}, activeReplicas=${initial.activeReplicas}, target=${initial.scaleTarget?.kind ?? "none"}, targetOutcome=${initial.scaleTarget?.outcome ?? "n/a"})`
      );
    },
    async onLostLeadership() {
      controller.stop();
      console.log("Open Agent Harness worker-controller leadership inactive; reconcile loop paused.");
    }
  });

  const close = async () => {
    await leaderElector.close();
    await controller.close();
    await Promise.all([queue.close(), registry.close()]);
  };

  let closing = false;
  const handleSignal = (signal: NodeJS.Signals) => {
    if (closing) {
      return;
    }

    closing = true;
    console.log(`Received ${signal}; shutting down worker-controller...`);
    void close().finally(() => {
      process.exit(0);
    });
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  leaderElector.start();
  const leadership = leaderElector.snapshot();
  console.log(
    `Open Agent Harness worker-controller started (leaderElection=${leadership.kind}, identity=${leadership.identity}, leader=${leadership.leader ? "yes" : "no"})`
  );

  await new Promise<void>(() => undefined);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
