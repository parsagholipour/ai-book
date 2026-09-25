import { shouldSkipUnsatisfiableCitationRepair } from "@book-maker/core";
import { onlyDeferredMediaRemains, type DeferredMediaRepairContext } from "./deferredMediaRepair.js";

/** Selects legacy FAILED_QA pages that still have a satisfiable repair. */
export function failedQaPageIndexesForCompile(
  pages: Array<{ index: number; status: string; markdown?: string; qualityReport?: unknown }>,
  citeableResearchNotes: string[],
  context?: DeferredMediaRepairContext
): number[] {
  return pages
    .filter(
      (page) =>
        page.status === "FAILED_QA" &&
        !onlyDeferredMediaRemains(page, context) &&
        !shouldSkipUnsatisfiableCitationRepair(page.qualityReport, citeableResearchNotes)
    )
    .map((page) => page.index);
}
