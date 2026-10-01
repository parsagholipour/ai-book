import {
  persistablePdfPageMapAfterRender,
  type GenerateBookPdfResult,
  type PersistableBookPdfPageMap
} from "@book-maker/core";
import { createRunLogger } from "../providers/runLogging.js";
import { workerJobStringField, type RawWorkerJob } from "../runtime/jobPayloads.js";

/** The run-log event a compile writes when its PDF publishes without a measured page map. */
export const PDF_PAGE_MAP_FALLBACK_EVENT = "export.pdf_page_map_fallback";

/**
 * What a compile persists for the PDF it just rendered, and a record whenever
 * that is the cover-numbering stub rather than a measurement.
 *
 * The decision is `persistablePdfPageMapAfterRender`'s alone; this only says
 * it out loud. A stub is indistinguishable from a measured book everywhere but
 * chat, which quietly drops back to model indexes — so two practical books
 * shipped without ranges and nothing anywhere said so. The run-log event is
 * written for every fallback, the designed ones included: a repair publishing
 * the stored `book.md` with no anchor plan (`unplanned-render`), a book with no
 * anchors. A render that was handed anchors and still could not be measured is
 * the regression class, and also warns on the console with the pages it lost.
 *
 * Never throws and never changes the result: the run logger swallows its own
 * write failures, and no compile may fail or publish differently over the map.
 */
export async function pdfPageMapAfterCompileRender(
  job: RawWorkerJob,
  result: Pick<GenerateBookPdfResult, "pageMap" | "pageMapFailure">,
  options: { planned: boolean; hasCoverPage: boolean }
): Promise<PersistableBookPdfPageMap> {
  const persisted = persistablePdfPageMapAfterRender({ pageMap: result.pageMap, hasCoverPage: options.hasCoverPage });
  if (!("kind" in persisted)) {
    return persisted;
  }
  const failure = options.planned
    ? result.pageMapFailure ?? { reason: "unmeasured", pageIndexes: [] }
    : { reason: "unplanned-render", pageIndexes: [] };
  try {
    await createRunLogger(job).append(PDF_PAGE_MAP_FALLBACK_EVENT, { ...failure, hasCoverPage: options.hasCoverPage });
  } catch (error) {
    // `append` swallows its own write failures; building the logger can still throw on a malformed job.
    console.error(`Failed to write the ${PDF_PAGE_MAP_FALLBACK_EVENT} run-log event`, error);
  }
  if (options.planned && failure.reason !== "no-anchors") {
    console.warn("PDF published without a measured page map; chat falls back to model page indexes", {
      event: "generation.consistency_warning",
      warning: "pdf_page_map_fallback",
      projectId: workerJobStringField(job, "projectId"),
      generationJobId: workerJobStringField(job, "generationJobId"),
      ...failure
    });
  }
  return persisted;
}
