import { Prisma, prisma } from "@book-maker/db";
import type { ProjectQualityStatus } from "../projectStatus.js";

/**
 * Which compile's quality report is the *book's* verdict, and what the report
 * is still allowed to claim by the time somebody reads it.
 *
 * `compile-export` is two different jobs wearing one name. The compile that
 * ends a generation, or applies an edit, reviews the manuscript and owns the
 * answer. Two kinds do not. An export repair rebuilds a file that went missing
 * on a book that is already finished and already paid for, and a
 * presentation-only recompile reprints an unchanged manuscript with the Sources
 * list dropped or the chapter headings restyled; both run with
 * `skipFinalReview`, so they ask no model anything and their reports are the
 * deterministic checks alone.
 *
 * That difference is already honoured on the write side — `ownsProjectStatus`
 * in `publishCompiledExports` makes a repair's claim a lock-taking no-op rather
 * than a status write, exactly so a repair cannot turn a REVIEW_REQUIRED book
 * COMPLETE. The read side used to take the newest compile with a report, full
 * stop, so the model-free verdict replaced the real one anyway: every
 * chapter-coherence and final-QA warning the book earned vanished from the
 * quality card the moment a missing PDF was rebuilt or a reader turned the
 * Sources list off, along with the affected page indexes the card's "Fix page
 * N" button is built from. Nothing brought them back, either — neither kind
 * ever runs final review, so the next one erased them again.
 *
 * **Ownership is a column, not a scan.** Both exclusions are payload flags, and
 * negating a JSON-path predicate in SQL drops every row whose payload simply
 * lacks the key — which is all of them but the flagged ones. So the two readers
 * filtered in JS over whatever window they happened to hold: the project detail
 * serializer took the newest eight compiles, the status builder reused its
 * newest twenty-five jobs *of any type*. A book that keeps losing its exports
 * queues a repair every five minutes, and an audiobook or a burst of image
 * retries is enough on its own — either way the owning compile falls out of the
 * window and the verdict does not degrade, it disappears: `normalizeProjectQuality`
 * reads nothing as `pending`, so a book with real findings renders a blank
 * quality card. `GenerationJob.ownsQualityVerdict` is written from the payload
 * where the row is created (`jobOwnsQualityVerdict`), so the owner is one
 * indexed lookup no amount of later job churn can push out of reach.
 */

/**
 * The quality report that speaks for the project, or null when no compile has
 * reported one yet.
 *
 * `qualityReport` still has to be checked, because the column is set when the
 * job row is created rather than when it reports: a compile that is queued,
 * running, or that failed before its QA pass owns the verdict it has not
 * written yet, and answering with its empty report would blank the quality card
 * for as long as it ran. Reports on rows that own nothing — a repair's, a
 * presentation recompile's — stay where they are, worth having for an operator
 * reading why one repair produced no EPUB, and out of the book's verdict.
 */
export async function loadProjectQualityReport(projectId: string): Promise<unknown> {
  const owner = await prisma.generationJob.findFirst({
    where: {
      projectId,
      type: "COMPILE_EXPORT",
      ownsQualityVerdict: true,
      qualityReport: { not: Prisma.DbNull }
    },
    orderBy: { createdAt: "desc" },
    select: { qualityReport: true }
  });
  return owner?.qualityReport ?? null;
}

const EPUB_EXPORT_FAILED = "EPUB_EXPORT_FAILED";

/**
 * Drops the one issue that describes a file rather than the manuscript.
 *
 * `EPUB_EXPORT_FAILED` is recorded by the compile whose conversion failed, and
 * it is the whole reason the missing EPUB gets repaired at all. The repair that
 * succeeds is a newer and better-informed statement about that file, but it is
 * detached, so it owns no verdict and `loadProjectQualityReport` deliberately
 * refuses to hear it — which would leave a book whose EPUB is sitting on disk
 * still telling its reader the export failed, on the exact path the EPUB repair
 * exists for. A presentation-only reprint that fails its EPUB conversion is
 * silent for the same reason, and the download surfaces still gate on the file:
 * `serializeExportSet` reads disk, so the button stays disabled and the repair
 * lane keeps retrying whatever the quality card says.
 *
 * The file itself settles it: `serializeExportSet` already reports
 * availability from disk, and disk beats a historical job row. Only this issue
 * is resolvable this way — every other one is about the book's prose, which no
 * later compile of the same manuscript can have fixed.
 *
 * `affectedPageIndexes` is left alone: an EPUB failure names no pages, so the
 * list cannot contain anything this drops.
 */
export function qualityWithExportsOnDisk(
  quality: ProjectQualityStatus,
  exports: { epub: { available: boolean } }
): ProjectQualityStatus {
  if (!exports.epub.available || !quality.issues.some((issue) => issue.code === EPUB_EXPORT_FAILED)) {
    return quality;
  }
  const issues = quality.issues.filter((issue) => issue.code !== EPUB_EXPORT_FAILED);
  const blocked = issues.some((issue) => issue.severity === "error" && issue.source === "deterministic");
  return {
    ...quality,
    state: blocked ? "blocked" : issues.length > 0 ? "review_recommended" : "passed",
    issues
  };
}
