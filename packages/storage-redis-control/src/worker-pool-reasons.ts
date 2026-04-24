export type RedisRunWorkerPoolRebalanceReason =
  | "startup"
  | "steady"
  | "scale_up"
  | "scale_down"
  | "cooldown_hold"
  | "shutdown";
