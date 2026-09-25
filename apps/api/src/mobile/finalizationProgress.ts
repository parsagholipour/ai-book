import type { MobileProjectStatusDto } from "./dto.js";
import { jsonRecord } from "./support.js";

type FinalizationProgress = NonNullable<NonNullable<MobileProjectStatusDto["generationProgress"]>["finalization"]>;

const LABELS: Record<FinalizationProgress["phase"], string> = {
  review: "Reading the whole book",
  repair: "Polishing your pages",
  final_review: "Checking the finished story",
  illustrations: "Creating your illustrations",
  coverage: "Checking your book requirements",
  render: "Preparing your downloads",
  published: "Your book is ready"
};

/** Only closed tokens and validated counters cross the mobile boundary. */
export function serializeFinalizationProgress(payload: unknown, targetPages: number): FinalizationProgress | null {
  const value = jsonRecord(jsonRecord(payload).finalizationProgress);
  const phase = value.phase;
  if (typeof phase !== "string" || !Object.hasOwn(LABELS, phase)) return null;
  const timestamp = typeof value.updatedAt === "string" ? Date.parse(value.updatedAt) : Number.NaN;
  if (!Number.isFinite(timestamp)) return null;
  const limit = Number.isInteger(targetPages) && targetPages > 0 ? targetPages : 0;
  const count = (input: unknown): number | null =>
    typeof input === "number" && Number.isInteger(input) && input >= 0 && input <= limit ? input : null;
  const attempts = count(value.attempts);
  const remaining = count(value.remainingRepairPages);
  if (attempts === null || remaining === null) return null;
  const pageIndex = count(value.pageIndex);
  const illustrationJobsTotal = count(value.illustrationJobsTotal);
  const closedPhase = phase as FinalizationProgress["phase"];
  return {
    phase: closedPhase,
    label: closedPhase === "repair" && pageIndex ? `Polishing page ${pageIndex} of ${limit}` : LABELS[closedPhase],
    pageIndex: pageIndex && pageIndex > 0 ? pageIndex : null,
    // These count pages claimed for repair, not provider calls or hidden retries.
    repairPagesAttempted: attempts,
    remainingRepairPages: remaining,
    ...(illustrationJobsTotal !== null ? { illustrationJobsTotal } : {}),
    lastProgressAt: new Date(timestamp).toISOString()
  };
}
