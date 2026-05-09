import type { StatusSemanticTone, HealthReportResponse } from "./support-types";

function toneBadgeClass(tone: StatusSemanticTone) {
  switch (tone) {
    case "emerald":
      return "border-[color:var(--app-tone-emerald-border)] bg-[color:var(--app-tone-emerald-surface)] text-[color:var(--app-tone-emerald-foreground)]";
    case "rose":
      return "border-[color:var(--app-tone-rose-border)] bg-[color:var(--app-tone-rose-surface)] text-[color:var(--app-tone-rose-foreground)]";
    case "amber":
      return "border-[color:var(--app-tone-amber-border)] bg-[color:var(--app-tone-amber-surface)] text-[color:var(--app-tone-amber-foreground)]";
    case "plum":
      return "border-[color:var(--app-tone-plum-border)] bg-[color:var(--app-tone-plum-surface)] text-[color:var(--app-tone-plum-foreground)]";
    default:
      return "border-[color:var(--app-tone-sky-border)] bg-[color:var(--app-tone-sky-surface)] text-[color:var(--app-tone-sky-foreground)]";
  }
}

function toneSolidClass(tone: StatusSemanticTone) {
  switch (tone) {
    case "emerald":
      return "bg-[color:var(--app-tone-emerald-solid)]";
    case "rose":
      return "bg-[color:var(--app-tone-rose-solid)]";
    case "amber":
      return "bg-[color:var(--app-tone-amber-solid)]";
    case "plum":
      return "bg-[color:var(--app-tone-plum-solid)]";
    default:
      return "bg-[color:var(--app-tone-sky-solid)]";
  }
}

function toneTextClass(tone: StatusSemanticTone) {
  switch (tone) {
    case "emerald":
      return "text-[color:var(--app-tone-emerald-solid)]";
    case "rose":
      return "text-[color:var(--app-tone-rose-solid)]";
    case "amber":
      return "text-[color:var(--app-tone-amber-solid)]";
    case "plum":
      return "text-[color:var(--app-tone-plum-solid)]";
    default:
      return "text-[color:var(--app-tone-sky-solid)]";
  }
}

function streamTone(status: string): StatusSemanticTone {
  switch (status) {
    case "open":
    case "listening":
      return "emerald";
    case "connecting":
      return "amber";
    case "error":
      return "rose";
    default:
      return "sky";
  }
}

function workerStateTone(state: HealthReportResponse["worker"]["activeWorkers"][number]["state"]): StatusSemanticTone {
  switch (state) {
    case "idle":
      return "emerald";
    case "busy":
      return "sky";
    case "starting":
    case "stopping":
      return "amber";
    default:
      return "sky";
  }
}

function workerHealthTone(health: HealthReportResponse["worker"]["activeWorkers"][number]["health"]): StatusSemanticTone {
  return health === "late" ? "amber" : "emerald";
}

function statusTone(status: string) {
  switch (status) {
    case "completed":
      return toneBadgeClass("emerald");
    case "running":
    case "waiting_tool":
      return toneBadgeClass("sky");
    case "queued":
      return toneBadgeClass("amber");
    case "cancelled":
      return "border-border bg-muted text-muted-foreground";
    case "failed":
    case "timed_out":
      return toneBadgeClass("rose");
    default:
      return "";
  }
}

function probeTone(status: string): StatusSemanticTone {
  switch (status) {
    case "ok":
    case "ready":
    case "up":
      return "emerald";
    case "degraded":
    case "not_configured":
    case "checking":
    case "idle":
      return "amber";
    case "error":
    case "not_ready":
    case "down":
      return "rose";
    default:
      return "sky";
  }
}

export {
  probeTone,
  statusTone,
  streamTone,
  toneBadgeClass,
  toneSolidClass,
  toneTextClass,
  workerHealthTone,
  workerStateTone
};
