import type { JobLifecycleSettlement } from "./jobTypes.js";

const SUCCESSOR_HANDOFF_MESSAGE = "Completed; successor compile owns lifecycle settlement";

/** Keeps successor handoff settlement deferred across a completed-row redelivery. */
export function completedJobLifecycle(
  requested: JobLifecycleSettlement,
  existing: { message?: string | null; status?: string } | null | undefined,
  qualityState: unknown
): { lifecycleSettlement: JobLifecycleSettlement; message: string } {
  const lifecycleSettlement =
    requested === "defer-to-successor" ||
    (existing?.status === "COMPLETED" && existing.message === SUCCESSOR_HANDOFF_MESSAGE)
      ? "defer-to-successor"
      : "settle";
  const message =
    lifecycleSettlement === "defer-to-successor"
      ? SUCCESSOR_HANDOFF_MESSAGE
      : qualityState === "blocked"
        ? existing?.message ?? "Review required before export"
        : qualityState === "review_recommended"
          ? "Export complete; review recommended. See the saved quality report for affected pages."
          : qualityState === "passed"
            ? "Export complete. Quality checks passed."
            : "Completed";
  return { lifecycleSettlement, message };
}
