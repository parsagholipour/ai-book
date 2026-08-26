import { shouldSkipUnsatisfiableCitationRepair } from "@book-maker/core";

/** Selects legacy FAILED_QA pages that still have a satisfiable repair. */
export function failedQaPageIndexesForCompile(
  pages: Array<{ index: number; status: string; qualityReport?: unknown }>,
  citeableResearchNotes: string[]
): number[] {
  return pages
    .filter(
      (page) =>
        page.status === "FAILED_QA" &&
        !shouldSkipUnsatisfiableCitationRepair(page.qualityReport, citeableResearchNotes)
    )
    .map((page) => page.index);
}
