import { bestEffortPass } from "../generation/bestEffortPass.js";
import { loadPageTextSnapshot, type PageTextSnapshot } from "../generation/bookHelpers.js";
import {
  pagesOutsideStoredQualityProvenance,
  qualityReportWithProvenance,
  storedQualityProvenance,
  type ReviewedPageFingerprint
} from "./compileExportQualityProvenance.js";
import type { QualityGateContext } from "../generation/qualityEnrichment.js";
import { updateJobProgress } from "../runtime/jobLifecycle.js";
import { isStopRequestedError, type ExportPageForRepair } from "../runtime/jobTypes.js";
import {
  buildManuscriptQualityReport,
  parseStoryDelta,
  rebuildStoryState,
  seedStoryStateFromPromises,
  unpaidPromiseIssues,
  type BookPlan,
  type ManuscriptQualityIssue,
  type ManuscriptQualityReport,
  type StoryState
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * What a compile does when it can no longer answer for the manuscript, and what
 * it is still allowed to say on the way out. Split out of `compileExport.ts`
 * along the seam its size budget named, and since split again: the fence that
 * asks whether this compile still owns the book, the errors it raises and the
 * note a truncated repair leaves are in `compileExportFence.ts`, which reads the
 * two things below that both halves need — the retry budget every deciding read
 * is under, and the comparison that says which pages this compile can no longer
 * speak for.
 *
 * Everything here exists for one asymmetry: `compile-export` has no BullMQ
 * retry budget and, for a verdict-owning row, owns the project's outcome — so
 * an error that travels marks a finished, fully paid book FAILED and refunds
 * `FULL_BOOK_GENERATION`. Every decision below is made against that price.
 */

/**
 * What a compile measured, kept as the ingredients of its verdict rather than
 * as the verdict.
 *
 * `buildManuscriptQualityReport` is a grader: hand it findings and it answers
 * `clean`, `review_recommended` or `blocked`, and from that answer there is no
 * way back to the pages each finding was about. A compile holding only the
 * graded report therefore cannot withdraw the half of it that has stopped being
 * true — which is the whole of what a stand-down needs to do. So the handler
 * keeps these four fields beside the report it built from them and hands *them*
 * to the door out.
 *
 * That is also what makes the two verdicts one verdict. The report a compile
 * ships and the report a compile stands down with are the same function over
 * the same findings, one of them filtered first; when they were two expressions
 * in two places, only one of them ever learned the filter.
 */
export interface StandDownFindings {
  /**
   * The in-memory manuscript these findings were measured against. A stored
   * reconstruction leaves this empty and uses `reviewedPageFingerprints`.
   *
   * Not the one in the database — that is the read `standDownQualityReport`
   * takes for itself, and the difference between the two is exactly what this
   * compile may no longer speak for.
   */
  reviewedPages: ExportPageForRepair[];
  /** Durable evidence used only when a redelivery reconstructs stored findings. */
  reviewedPageFingerprints?: ReviewedPageFingerprint[];
  deterministicIssues: ManuscriptQualityIssue[];
  modelIssues: ManuscriptQualityIssue[];
  /** Whether the model half of the review actually ran. */
  finalReviewRan: boolean;
  /** Whether deterministic warnings from this compile may affect book state. */
  deterministicWarningsAffectVerdict?: boolean;
}

/** The grader, applied to findings. One spelling, so a stand-down cannot grade differently. */
export function qualityReportFromFindings(findings: StandDownFindings): ManuscriptQualityReport {
  const deterministicWarningsAffectVerdict =
    findings.deterministicWarningsAffectVerdict ?? findings.finalReviewRan;
  const report = buildManuscriptQualityReport(findings.deterministicIssues, findings.modelIssues, {
    finalReviewRan: findings.finalReviewRan,
    deterministicWarningsAffectVerdict
  });
  return qualityReportWithProvenance(report, {
    finalReviewRan: findings.finalReviewRan,
    deterministicWarningsAffectVerdict,
    reviewedPages: findings.reviewedPageFingerprints ?? findings.reviewedPages
  });
}

/**
 * Stands this compile down for the one the newer manuscript queued: the single
 * door out of a compile that has stopped speaking for the book.
 *
 * The job still COMPLETEs: nothing failed, and failing it would refund a book
 * that is fine. The warning is the trace worth having — `markCompleted`
 * overwrites the progress message a moment later, so without it a compile that
 * deliberately published nothing looks identical to one that published.
 *
 * **It takes the findings because standing down is what settles them.** There
 * are four ways out of `compileExport.ts` with nothing published — the repair
 * pass losing the manuscript mid-page, the compile's own supersede read before
 * the render, `publishCompiledExports`' compare-and-set answering somebody
 * else, and open `GENERATE_IMAGE` jobs at the top of the handler — and for a
 * while only the first of them corrected the verdict. The image-job gate used
 * to retract the column to `DbNull` instead, which is how a first attempt with
 * no findings could grade `passed` over a previous `blocked` card. The other
 * two late doors ran *after* `recordCompileQualityReport` had already stored the
 * pass's findings, so a reader who edited page 3 while the compile was between
 * its repair and its render was left with a `blocked` quality card about prose
 * they had replaced: nothing was coming to overwrite it, because the compile
 * that superseded this one may own no verdict at all (a
 * `MARKDOWN_RECOMPILE_WITHOUT_VERDICT` image edit, or an edit recompile
 * building its report with `finalReviewRan: false`). Filtering the report at
 * one of the doors and not the others is a property that has to be
 * remembered; filtering it *inside the door* is one that cannot be forgotten,
 * because there is no other way to stand down. The stored row is written on
 * every path for the same reason: the two late doors overwrite a stale claim,
 * the early one makes the compile's only claim, and `recordCompileQualityReport`
 * is an update either way.
 *
 * The verdict goes first because the stale verdict is the harm. A process that
 * dies between the two writes has retracted what it could no longer stand
 * behind and merely failed to say so.
 *
 * Both writes are best-effort, and that is the second half of unifying them.
 * They address a `GenerationJob` row a retention sweep or a queue
 * reconciliation may have retired while this compile spent minutes inside its
 * repair, and the P2025 out of either used to travel from the two late doors —
 * straight past the catch, into `markFailed`, marking a finished, fully paid
 * book FAILED. See `writeStandDownRecordBestEffort`, and note that a
 * `StopRequestedError` still escapes both.
 *
 * **The verdict is decided above that guard rather than inside it.** What the
 * compile may still claim is a *read*, and a read and a write fail for
 * different reasons and have different right answers. Folded into the
 * best-effort write, a manuscript re-read that threw took the whole write down
 * with it — and "no write" is not "no claim": at the two late doors the row
 * already holds this compile's unfiltered report, so the one failure the
 * withdrawal exists to survive left exactly the `blocked` card about replaced
 * prose that it exists to take back, with nothing coming to overwrite it. The
 * read now answers `null` when it cannot measure and the write still happens;
 * see `withdrawnQualityVerdict`.
 */
export async function standDownForNewerExport(options: {
  projectId: string;
  generationJobId: string;
  /** Absent only when a stored legacy report has no reviewed-page provenance. */
  findings?: StandDownFindings;
}): Promise<void> {
  const verdict = options.findings
    ? await withdrawnQualityVerdict(options.projectId, options.findings)
    : null;
  await writeStandDownRecordBestEffort(options.projectId, options.generationJobId, () =>
    recordCompileQualityReport(options.generationJobId, verdict)
  );
  // One `attempt` for both traces of one fact. The console line is what an
  // operator greps across every book on the box; the progress line is what the
  // run itself says until `markCompleted` overwrites it.
  await writeStandDownRecordBestEffort(options.projectId, options.generationJobId, async () => {
    console.warn("Export compile superseded before publication", {
      event: "generation.consistency_warning",
      warning: "export_publication_superseded",
      projectId: options.projectId,
      generationJobId: options.generationJobId
    });
    await updateJobProgress(options.generationJobId, {
      message: "The book changed while this export was compiling; the newer export publishes it instead."
    });
  });
}

/**
 * Reconstructs the findings a prior delivery of this compile already wrote,
 * so an unpublished exit that happens *before* QA can still stand down
 * instead of retracting the column.
 *
 * New reports carry hashes of the exact reviewed pages. A legacy report is a
 * grade with no such provenance and must be retracted rather than attached to
 * the live pages this redelivery happened to load. No path here re-runs QA.
 */
function findingsFromStoredQualityReport(report: unknown):
  | { kind: "unmeasured" }
  | { kind: "unproven" }
  | { kind: "proven"; findings: StandDownFindings } {
  if (report === null || report === undefined) {
    return { kind: "unmeasured" };
  }
  const parsed = parseStoredQualityReport(report);
  const provenance = storedQualityProvenance(report);
  if (parsed === null || provenance === null) {
    return { kind: "unproven" };
  }
  return {
    kind: "proven",
    findings: {
      // Never substitute this delivery's live rows for a historical snapshot.
      reviewedPages: [],
      reviewedPageFingerprints: provenance.reviewedPages,
      deterministicIssues: parsed.issues.filter((issue) => issue.source === "deterministic"),
      modelIssues: parsed.issues.filter((issue) => issue.source === "model"),
      finalReviewRan: provenance.finalReviewRan,
      deterministicWarningsAffectVerdict: provenance.deterministicWarningsAffectVerdict
    }
  };
}

/**
 * The unpublished exit taken when open `GENERATE_IMAGE` jobs still block
 * this compile: the gate stays (a Bull redelivery of an already-ACTIVE
 * compile must not render terminal prose before the replacement image
 * publishes), but the verdict is settled through the same door every other
 * unpublished exit uses.
 */
export async function standDownForOpenImageJobs(options: {
  projectId: string;
  generationJobId: string;
}): Promise<void> {
  const row = await prisma.generationJob.findUnique({
    where: { id: options.generationJobId },
    select: { qualityReport: true }
  });
  const reconstruction = findingsFromStoredQualityReport(row?.qualityReport);
  if (reconstruction.kind === "unmeasured") {
    return;
  }
  await standDownForNewerExport({
    projectId: options.projectId,
    generationJobId: options.generationJobId,
    ...(reconstruction.kind === "proven" ? { findings: reconstruction.findings } : {})
  });
}

function parseStoredQualityReport(value: unknown): {
  issues: ManuscriptQualityIssue[];
} | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.issues)) {
    return null;
  }
  const issues: ManuscriptQualityIssue[] = [];
  for (const entry of record.issues) {
    const issue = parseStoredQualityIssue(entry);
    if (issue === null) {
      return null;
    }
    issues.push(issue);
  }
  return { issues };
}

function parseStoredQualityIssue(value: unknown): ManuscriptQualityIssue | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.code !== "string" ||
    (record.severity !== "error" && record.severity !== "warning") ||
    (record.source !== "deterministic" && record.source !== "model") ||
    typeof record.message !== "string" ||
    typeof record.guidance !== "string" ||
    !Array.isArray(record.affectedPageIndexes) ||
    record.affectedPageIndexes.some((index) => typeof index !== "number")
  ) {
    return null;
  }
  return {
    code: record.code,
    severity: record.severity,
    source: record.source,
    message: record.message,
    guidance: record.guidance,
    affectedPageIndexes: record.affectedPageIndexes
  };
}

/**
 * How hard a read that decides something tries before it gives up.
 *
 * Three attempts over ~300ms, against a page repair that costs several model
 * calls: the budget is sized to ride out a connection reset or a pool that is
 * briefly full, not to wait out an outage. Anything that survives it is a
 * database this compile is not going to finish against anyway, and the handler
 * has a cheaper answer for that than sitting on a worker slot.
 *
 * Both of a compile's deciding reads are under it, because both are the same
 * shape of bet: the repair's ownership fence (`compileExportFence.ts`), whose
 * failure stops a paid repair pass, and the stand-down's manuscript re-read
 * below, whose failure costs the compile the verdict it is entitled to leave.
 * Neither is worth losing to one exhausted pool, which is why the budget is
 * exported rather than copied.
 */
export const OWNERSHIP_READ_ATTEMPTS = 3;
const OWNERSHIP_READ_BACKOFF_MS = 100;

/**
 * One read, retried, with the last failure raised as itself.
 *
 * A stop is handed straight back from inside the loop: nothing in a Prisma read
 * raises one today, but a helper that retried a cancellation and then reported
 * a database problem would be a handler swallowing a stop, which is the one
 * thing none of this may do.
 */
export async function readWithRetry<T>(read: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= OWNERSHIP_READ_ATTEMPTS; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      if (isStopRequestedError(error)) {
        throw error;
      }
      lastError = error;
      if (attempt < OWNERSHIP_READ_ATTEMPTS) {
        await sleep(OWNERSHIP_READ_BACKOFF_MS * attempt);
      }
    }
  }
  throw lastError;
}

/**
 * Leaves this compile's findings on its own durable row.
 *
 * One function because there are three writers of the same column and they used
 * to be three spellings of the same statement, one of which was missing: the
 * pass's normal report, the EPUB degradation that appends to it, and the
 * stand-down inside the final-QA repair, which recorded nothing at all. That
 * asymmetry is the bug it exists to close — see the repair's catch in
 * `compileExport.ts`.
 *
 * **`null` is a retraction, and it is a fourth thing to be able to say.** A
 * stand-down that cannot re-read the manuscript cannot tell which of its
 * findings still hold — and neither, in the end, can one whose re-read came
 * back saying every finding it had names prose that has moved. The two answers
 * either could give instead are both claims: the unfiltered snapshot asserts
 * findings about prose that may be gone, and an empty report asserts that a
 * book nobody re-measured is fine —
 * `buildManuscriptQualityReport` grades no findings as `passed`, which is the
 * card saying "Quality checks passed" over whatever the last honest compile
 * found. Clearing the column says neither. `loadProjectQualityReport`
 * (`apps/api/src/mobile/qualityVerdict.ts`) selects the newest verdict-owning
 * compile whose `qualityReport` is `not: DbNull`, so a retracted row steps
 * aside and the book falls back to the last verdict measured against a
 * manuscript that existed.
 */
export async function recordCompileQualityReport(
  generationJobId: string,
  report: ManuscriptQualityReport | null
): Promise<void> {
  await prisma.generationJob.update({
    where: { id: generationJobId },
    data: { qualityReport: report === null ? Prisma.DbNull : (report as unknown as Prisma.InputJsonValue) }
  });
}

/**
 * Runs one of the superseded stand-down's own `GenerationJob` writes, and lets
 * it fail.
 *
 * Both of them — the verdict and the progress line `standDownForNewerExport`
 * leaves — touch a row that a retention sweep or a queue reconciliation may
 * have retired while this compile spent minutes inside its repair, and Prisma
 * answers a missing row with P2025. That is not an
 * `ExportRepairSupersededError`, so nothing above catches it and the compile
 * lands in `markFailed`: a finished, fully paid book marked FAILED and
 * `FULL_BOOK_GENERATION` handed back, which is the single outcome the class, the
 * catch and this whole path exist to refuse. A verdict or a message nobody can
 * read is the cheaper loss by an enormous margin, and each write is attempted
 * separately because neither is worth the other either.
 *
 * The verdict's *read* is deliberately **not** inside it. It used to be, and
 * that made one failure wear the other's guard: `standDownQualityReport`
 * re-reads the manuscript to know what it is still entitled to claim, and when
 * that read threw the swallowed failure took the write with it — leaving the
 * unfiltered report standing at the two doors that had already stored one, and
 * no report at all at the door that had not. A read that cannot answer decides
 * *what* to write; only the write itself may be dropped. See
 * `withdrawnQualityVerdict`, which settles the first question before this
 * function is asked the second.
 *
 * **Only a stand-down is allowed this**, and it is now the only caller: both
 * uses are inside `standDownForNewerExport`, which is the whole of what a
 * compile that publishes nothing does. Everywhere else these writes are
 * load-bearing — a compile that cannot record what it found has genuinely
 * failed, and settling it as one is right.
 *
 * `StopRequestedError` still travels: `updateJobProgress` asserts the run was
 * not stopped, and a handler that swallows that answer turns a reader's
 * cancellation into a finished book. That rethrow is `bestEffortPass`'s and not
 * this function's — it was hand-rolled here, one of four spellings of the same
 * three lines, and a restated rule is only ever as strong as the next copy
 * somebody adds beside it. What survives here is the part that is genuinely
 * this call site's: a *write*, so there is nothing to keep and the fallback is
 * `undefined`, and a warning shaped for grepping rather than reading, which is
 * what `details` carries through.
 */
export async function writeStandDownRecordBestEffort(
  projectId: string,
  generationJobId: string,
  write: () => Promise<void>
): Promise<void> {
  await bestEffortPass<void>({
    attempt: write,
    fallback: undefined,
    warning: "Superseded export compile could not record its stand-down",
    details: {
      event: "generation.consistency_warning",
      warning: "export_stand_down_record_failed",
      projectId,
      generationJobId
    }
  });
}

/**
 * The one finding this file *produces*, spelled once.
 *
 * Both halves of it live here — `unpaidPromiseQualityIssues` builds it and
 * `scoredAgainstTheWholeBook` has to recognise it — so the string is a constant
 * rather than a literal in each. A filter that knows a producer by its code is
 * only as good as the two spellings agreeing, and nothing else in the codebase
 * emits this one.
 */
const UNPAID_PROMISE_CODE = "UNPAID_PROMISE";

/**
 * The unpaid-promise warnings a report carries, off a story state the caller is
 * entitled to have computed.
 *
 * The state is a parameter rather than a read because the two callers may not
 * take the same one. The publishing compile rebuilds it through
 * `rebuildProjectStoryState`, which *writes* the fold back onto the project —
 * and does so whether or not this audit is enabled, which is why the gate is
 * here and not around the rebuild. The compile standing down inside its own
 * repair may not write anything about a book it has just disclaimed, so it
 * folds the same extracts out of the snapshot it reviewed, through
 * `reviewedStoryState`, and keeps the answer to itself. Which one a call site
 * is entitled to is that function's docstring.
 *
 * **And it arrives unevaluated, because the gate is the first line.** Folding
 * one of those states is a `parseStoryDelta` — a zod parse — per page plus a
 * `rebuildStoryState` over the result, run synchronously on the worker's event
 * loop, and with `storyExtractAudit` off nothing here reads a single entry of
 * it. The publishing caller pays that fold whatever this answers, so deferring
 * it costs that path nothing; the caller it is for is the stand-down inside the
 * repair, which folds a state of its own for this question alone and runs on
 * the one path documented as needing to be cheap — the compile that superseded
 * this one is rendering and publishing against the same database. Evaluated as
 * an argument, a 300-page book on a tier with the audit off folded the whole
 * manuscript there and handed it to a function that returns `[]` before
 * looking at it. Same shape, and the same reason, as the `unflagged` thunk
 * `withoutCollidingRewrites` takes in
 * `packages/core/src/generation/pageBeatDedup.ts`: the guard sits in front of
 * the thunk, and a call that does read the state pays exactly what it paid
 * before.
 *
 * **The page it names is a signpost, not its subject.** `affectedPageIndexes`
 * carries the book's last page because that is where an open promise has to be
 * paid off or retired; the complaint is about a promise opened on some other
 * page and answered on none of them, which is a claim about the manuscript.
 * Every reader wants the signpost — the reader's quality card links it, and the
 * publishing path ships this finding exactly as it is built here — so the shape
 * stays. The one reader that may not take it for a location is the withdrawal
 * filter, and that is `scoredAgainstTheWholeBook`'s job rather than this
 * function's.
 */
export function unpaidPromiseQualityIssues(options: {
  quality: QualityGateContext;
  targetPages: number;
  /** Unevaluated until the gate above has said the fold will be read. */
  storyState: () => StoryState;
}): ManuscriptQualityIssue[] {
  if (!options.quality.enabled("storyExtractAudit")) {
    return [];
  }
  return unpaidPromiseIssues(options.storyState(), options.targetPages, options.targetPages).map((message) => ({
    code: UNPAID_PROMISE_CODE,
    severity: "warning",
    source: "deterministic",
    message,
    guidance: "Pay off or explicitly retire the promise on the last page.",
    affectedPageIndexes: [options.targetPages]
  }));
}

/**
 * The pages this compile reviewed that the book no longer holds in that form.
 *
 * Compared row by row against the manuscript as it now stands, because two
 * different writers can have moved a page out from under the snapshot and the
 * report may not tell them apart: this pass itself, which rewrote every flagged
 * page it reached before the fence stopped it, and the reader's edit, which is
 * why the fence stopped it. Either way the prose the finding describes is gone.
 * `revision` catches a rewrite that produced identical text; the text catches a
 * writer that did not touch the counter.
 *
 * Exported for its second reader, `recordTruncatedRepairPass`
 * (`compileExportFence.ts`), which counts the same set to say how much of the
 * book a truncated pass had rewritten. One comparison, so a note about a pass
 * and the verdict that pass produced cannot disagree about which pages moved.
 */
export function pagesTheCompileNoLongerSpeaksFor(
  reviewed: PageTextSnapshot[],
  current: PageTextSnapshot[]
): Set<number> {
  const currentByIndex = new Map(current.map((page) => [page.index, page]));
  // The indexes the first loop already walks, kept rather than re-scanned. A
  // `reviewed.some(...)` inside the second loop made this half quadratic, which
  // on a 300-page stand-down is 90,000 linear scans run synchronously on the
  // worker's event loop — in a path that runs while the compile which
  // superseded this one is trying to publish.
  const reviewedIndexes = new Set(reviewed.map((page) => page.index));
  const moved = new Set<number>();
  for (const page of reviewed) {
    const now = currentByIndex.get(page.index);
    if (!now || now.revision !== page.revision || now.markdown !== page.markdown || now.title !== page.title) {
      moved.add(page.index);
    }
  }
  for (const page of current) {
    if (!reviewedIndexes.has(page.index)) {
      moved.add(page.index);
    }
  }
  return moved;
}

/**
 * Whether a finding's subject is the manuscript rather than the pages it names.
 *
 * Two shapes answer yes, and the second is why this is a question rather than a
 * length check. A finding that names **no** page has nothing to be scored
 * against but the book, which is argued in `issuesStillTrueOfTheBook` below. A
 * finding that names **one page it is not about** is the same claim wearing a
 * page number: `unpaidPromiseQualityIssues` stamps `[targetPages]` on every
 * promise the book leaves open, and that index is where the reader is told to
 * pay it off, not the prose being complained about.
 *
 * Scored as a located finding, that anchor was unfalsifiable by construction.
 * The repair pass rewrites in ascending order and stops where the fence went
 * dark, so the pages that move are a prefix — and the last page of a long book
 * is the one page a truncated pass never reaches. A repair that rewrote page
 * 150 of 200, paying promise P off in its new `storyDelta`, and then lost the
 * manuscript at page 160, stood down complaining about P: the fold behind the
 * finding is over the pages as this compile *read* them, where P is still
 * open, and page 200 had not moved, so `issuesStillTrueOfTheBook` kept it. The
 * row was left holding a `review_recommended` verdict stamped
 * `finalReviewRan: true`, about a promise this very compile had paid.
 *
 * Re-folding the promise state over the pages as they now stand was the other
 * way out, and it is the one thing this file may not do: those pages are the
 * reader's manuscript, and measuring anything over them is how a stand-down
 * invents a finding about prose nobody here reviewed — the rule
 * `withdrawnQualityVerdict` and `reviewedStoryState` are both written against,
 * and the reason a fresh deterministic sweep is refused two functions down.
 * Naming the shape instead costs one advisory line on the book where the
 * promise really is still open and some unrelated page moved, and it buys back
 * the property the whole withdrawal rests on: this compile asserts only what it
 * measured, about a book it still recognises.
 *
 * The code is the test because the code is the producer. `UNPAID_PROMISE` is
 * built in this file and nowhere else, off the constant both halves spell, and
 * "the page I name is a signpost" is a property of that producer rather than of
 * the shape of an array. Every other deterministic finding names the pages it
 * is genuinely about — `PAGE_COUNT_MISMATCH` names all of them, which reaches
 * the same answer by the located route — and the model half either names its
 * pages or names none.
 */
function scoredAgainstTheWholeBook(issue: ManuscriptQualityIssue): boolean {
  return issue.affectedPageIndexes.length === 0 || issue.code === UNPAID_PROMISE_CODE;
}

/**
 * The findings this compile may still assert, given which pages have moved.
 *
 * A finding that names pages it is about is scored against those pages: page
 * 2's complaint survives page 1 being rewritten, because page 2 is still the
 * prose that was read.
 *
 * **A finding about the book is scored against the whole book.** Its subject is
 * the manuscript — "the ending never pays off the central promise", the chapter
 * sweep's schema allowing an empty `affectedPageIndexes`,
 * `qualityIssuesFromFinalQa` mapping a complaint that names no page number to
 * `[]`, `MISSING_PAGES`, which is exactly the claim any page appearing
 * falsifies, and `UNPAID_PROMISE`, whose page anchor is a signpost rather than a
 * subject (`scoredAgainstTheWholeBook`). `some(...)` over an empty array is
 * `false`, so every unlocated one used to be *kept*: the stand-down shipped a
 * `review_recommended` verdict stamped `finalReviewRan: true`, built out of a
 * whole-book complaint, about a manuscript the reader had since edited. The
 * sentinel-anchored one was kept by the opposite accident — its anchor is the
 * page a truncated pass is least likely to have touched.
 *
 * So a book-level finding survives only a book that has not moved at all, and
 * the bluntness is the point rather than a compromise. Nothing here can tell a
 * cosmetic edit from a substantive one — `pagesTheCompileNoLongerSpeaksFor`
 * compares revision, title and text, and a fixed typo and a paid page rewrite
 * are the same answer — and the pass's own repairs count as movement too, which
 * is the case that settles it: the publishing path re-runs
 * `strategy.runFinalBookQa` over the repaired pages precisely because a
 * whole-book verdict does not survive the pages under it being rewritten. A
 * stand-down cannot re-run anything, so withholding is the only honest form of
 * the same rule. What it costs is one advisory line on a card; what keeping it
 * costs is a claim about a book nobody graded.
 */
function issuesStillTrueOfTheBook(
  issues: ManuscriptQualityIssue[],
  moved: ReadonlySet<number>
): ManuscriptQualityIssue[] {
  return issues.filter((issue) =>
    scoredAgainstTheWholeBook(issue)
      ? moved.size === 0
      : !issue.affectedPageIndexes.some((index) => moved.has(index))
  );
}

/** Both halves of what a compile measured, counted: the grade is over the two together. */
function findingCount(findings: StandDownFindings): number {
  return findings.deterministicIssues.length + findings.modelIssues.length;
}

/**
 * Whether the withdrawal has taken away everything this compile had to say —
 * which is not the same fact as its having found nothing.
 *
 * `buildManuscriptQualityReport` grades no findings as `passed`, score 100:
 * "Quality checks passed" on the reader's card. That sentence is a
 * *measurement* when it comes from a review that read a manuscript and
 * complained about none of it, and a *residue* when it is merely what is left
 * once the filter has withheld every finding there was. The second is the exact
 * claim `withdrawnQualityVerdict` refuses to make about a manuscript it cannot
 * read at all — a book nobody re-measured is fine — arrived at by the other
 * route, and it is the one shape of stand-down that could *upgrade* the row it
 * was written to correct. A compile that recorded `blocked` over a
 * deterministic error on page 3 and then lost the publication claim to the
 * recompile of the reader's edit *to page 3* withheld its only finding and
 * wrote `passed` over its own `blocked`. Nothing was coming to correct that
 * either: the compile that supersedes this one may own no verdict at all.
 *
 * So all-withheld is the same fact as cannot-measure, and it takes the same
 * door. `recordCompileQualityReport(…, null)` retracts, and
 * `loadProjectQualityReport` falls back to the last verdict measured against a
 * manuscript that existed.
 *
 * **An empty *measured* set is left alone**, and that asymmetry is the whole of
 * why this is a question about the findings rather than about the report.
 * Retracting is not free — it costs the book the verdict this compile paid a
 * full review for and hands the reader an *older* compile's instead — so it is
 * the better answer only when what would be written is unsupported. A review
 * that ran and found nothing supports its `passed`: at the two doors below
 * `recordCompileQualityReport` it is the report already on the row, so writing
 * it again upgrades nothing, and at the repair door it is the only thing this
 * compile measured. Retracting that because some page moved would throw a full
 * review away over a fixed typo, and would make the withdrawal a blanket rather
 * than a filter — the rule `issuesStillTrueOfTheBook` exists to avoid.
 */
function withheldEveryFindingItMeasured(measured: StandDownFindings, surviving: StandDownFindings): boolean {
  return findingCount(measured) > 0 && findingCount(surviving) === 0;
}

/**
 * The verdict a superseded compile is entitled to leave behind: everything it
 * measured, minus every finding it has since stopped being able to stand
 * behind — or nothing at all, when that subtraction empties a set that was not
 * empty.
 *
 * The stand-down used to record the pre-repair snapshot verbatim, stamped
 * `finalReviewRan: true`, and that report was a claim about a manuscript that
 * no longer existed. The repair pass runs in ascending page order and rewrites
 * every `severity === "error"` page the deterministic sweep named; a fence that
 * trips on page 15 of 15 has already saved fourteen repairs to the database,
 * and the report still named all fifteen. The publishing path never ships that
 * report — it re-runs `strategy.runFinalBookQa` over the repaired pages
 * precisely because the pre-repair verdict is stale — so this path was
 * publishing what that path refuses to.
 *
 * Which mattered because nothing was coming to replace it. The compile that
 * supersedes this one may own no verdict at all: an image move, remove or
 * insertion queues a `MARKDOWN_RECOMPILE_WITHOUT_VERDICT` recompile, and an
 * edit's own recompile builds its report with `finalReviewRan: false`. So
 * `loadProjectQualityReport` kept serving this snapshot — and a deterministic
 * *error* is the one thing that survives every gate in
 * `buildManuscriptQualityReport`, so a page whose placeholder text this pass had
 * already replaced left the reader's quality card reading `blocked` for a book
 * that no longer has the defect.
 *
 * The fix is to drop the findings rather than to re-grade the book. Re-running
 * the deterministic sweep over the *current* pages was the obvious alternative
 * and is the wrong one: those pages are the reader's manuscript, not the one
 * this compile reviewed, so it would answer with `PAGE_COUNT_MISMATCH` — an
 * error, and a fresh `blocked` — the moment their edit added or removed a page.
 * Measuring what this compile actually read and then withholding whatever has
 * since moved is honest in both directions: it cannot invent a finding about
 * prose nobody here reviewed, and it cannot assert one about prose that is
 * gone.
 *
 * The same rule covers the model half. The chapter sweep and the final-QA
 * complaints name pages too (`qualityIssuesFromFinalQa` maps each message to
 * the pages that message names), and a complaint about page 3 is exactly as
 * stale as a deterministic one when page 3 has been rewritten since.
 * A complaint that names *no* page is covered too, and by a different question —
 * see `issuesStillTrueOfTheBook`, where the asymmetry is argued.
 * **A subtraction that leaves nothing behind is not a pass**, and that is the
 * one place the withdrawal can produce a claim rather than withdraw one: no
 * findings grades `passed`, score 100, so the filter written to take a
 * `blocked` card off a replaced page could write "Quality checks passed" over
 * it instead — for a book whose only graded prose is exactly the prose that
 * moved. `withheldEveryFindingItMeasured` is where that is told apart from a
 * review that genuinely found nothing, and the answer to it is `null`.
 *
 * `finalReviewRan` is carried through from the findings rather than asserted
 * here: it really did run for the compile that stands down inside its own
 * repair, and it really did not for a `skipFinalReview` recompile that loses
 * the compare-and-set at the far end, and both of those now come through this
 * one function.
 */
async function standDownQualityReport(
  projectId: string,
  findings: StandDownFindings
): Promise<ManuscriptQualityReport | null> {
  // The narrow loader, because this is the only read in the file that happens
  // *while somebody else is publishing*: the compile that superseded this one is
  // in its render or its compare-and-set on the same database. Four scalars per
  // page is the whole question — see `loadPageTextSnapshot`, and note that the
  // reviewed side arrives as full export rows and simply carries more than the
  // comparison looks at.
  //
  // Retried on the fence's budget, and for the fence's reason: the pool this
  // asks is the one an edit-side race has just been contending, so the cheap
  // failure here is a connection reset rather than a database that is gone —
  // and giving up on it costs the book the whole verdict this compile paid a
  // full review for. See `readWithRetry`; the answer when it still will not
  // come back is `withdrawnQualityVerdict`'s, not this function's.
  const current = await readWithRetry(() => loadPageTextSnapshot(projectId));
  const moved = findings.reviewedPageFingerprints
    ? pagesOutsideStoredQualityProvenance(findings.reviewedPageFingerprints, current)
    : pagesTheCompileNoLongerSpeaksFor(findings.reviewedPages, current);
  const surviving: StandDownFindings = {
    ...findings,
    deterministicIssues: issuesStillTrueOfTheBook(findings.deterministicIssues, moved),
    modelIssues: issuesStillTrueOfTheBook(findings.modelIssues, moved)
  };
  // The read answered, and the filter still left this compile with nothing it
  // can stand behind. That is `withheldEveryFindingItMeasured`'s question, and
  // its `null` means what the unreadable one's means — no claim — so it reaches
  // the same write rather than an empty report, which would be a claim.
  // The ordinary same-delivery path already stored a measured clean pass and
  // keeps the documented empty-finding asymmetry. A redelivery has stronger
  // durable evidence: preserve that pass only while the fingerprints prove it
  // still describes the current manuscript. Movement makes it unproven, not a
  // fresh failure and certainly not a fresh pass.
  const storedCleanPassMoved =
    findings.reviewedPageFingerprints !== undefined && findingCount(findings) === 0 && moved.size > 0;
  return storedCleanPassMoved || withheldEveryFindingItMeasured(findings, surviving)
    ? null
    : qualityReportFromFindings(surviving);
}

/**
 * What this compile is allowed to leave on its row, or `null` when it cannot
 * honestly leave anything — which it reaches two ways: a manuscript it cannot
 * re-read, argued below, and a re-read that says every finding it had is about
 * prose that has since moved (`withheldEveryFindingItMeasured`). The two are
 * one fact — this compile has no claim to make — and the row cannot tell them
 * apart, which is right: a reader is owed the last verdict somebody measured,
 * not the reason this one went quiet.
 *
 * The withdrawal rests on one read — the manuscript as it now stands — and that
 * read can fail against the same unhealthy pool that let an edit race this
 * compile in the first place. Folded into the best-effort *write*, the failure
 * simply cancelled the write, which is the worst of the three available
 * answers: at the compile's own supersede read and at the publication claim the
 * row already holds this pass's unfiltered report, so the one path that exists
 * to withdraw a `blocked` card about replaced prose left it standing, with
 * nothing coming to overwrite it. At the repair door it is the mirror image —
 * a verdict-owning compile records no verdict at all and
 * `loadProjectQualityReport` reaches past the row — and the two doors answered
 * differently for no reason anybody chose.
 *
 * They now answer the same way, and the answer is a retraction rather than a
 * report. "Cannot measure" is not "measured and found nothing": the compile
 * knows it has been superseded and cannot know which of its findings the newer
 * manuscript still deserves, so it asserts none of them — not the stale
 * snapshot, and not the empty report that grades `passed` and would paper over
 * the last verdict anyone did measure. `recordCompileQualityReport(…, null)`
 * clears the column and the book falls back to that verdict.
 *
 * Best-effort, because a stand-down's whole point is that nothing on it may
 * fail a finished, fully paid book — and a `StopRequestedError` still escapes,
 * this being `bestEffortPass`'s rule rather than a restated one. The warning
 * names the read specifically: "could not record" and "could not measure" are
 * different mornings for whoever greps `generation.consistency_warning`. The
 * other route to `null` files none, and that asymmetry is right: a withdrawal
 * that withheld everything is this filter working rather than failing, and
 * `standDownForNewerExport` has already logged that the compile published
 * nothing.
 */
async function withdrawnQualityVerdict(
  projectId: string,
  findings: StandDownFindings
): Promise<ManuscriptQualityReport | null> {
  return bestEffortPass<ManuscriptQualityReport | null>({
    attempt: () => standDownQualityReport(projectId, findings),
    fallback: null,
    warning: "Superseded export compile could not re-read the manuscript it is withdrawing findings from",
    details: {
      event: "generation.consistency_warning",
      warning: "export_stand_down_manuscript_unreadable",
      projectId
    }
  });
}

/**
 * The story state a stand-down is entitled to fold, over the pages it read
 * rather than over the project's rows.
 *
 * `unpaidPromiseQualityIssues` is part of every report the publishing path
 * ships, and a stand-down report that silently drops a whole check is a
 * different report about the same book — so it is folded on that path too. But
 * `rebuildStoryStateFromPages` reads the project, which by then holds the
 * reader's new page 3 and every page this pass had already rewritten. So the
 * one half of the report measured over a different book was an UNPAID_PROMISE
 * derived from prose this compile never read, asserted about a book it had just
 * disclaimed, and served to the reader's quality card by
 * `loadProjectQualityReport`.
 *
 * The withdrawal filter does not stand in for this, and the two are not the
 * same guard. It now scores the finding against the whole book
 * (`scoredAgainstTheWholeBook`), so it withholds it the moment any page has
 * moved — but that is a question about a *third* read, taken later and against
 * a book that is still changing, and its answer is "keep" whenever the two
 * snapshots happen to agree. What decides which prose the finding is about at
 * all is this fold. The filter withholds a claim that has stopped being true;
 * this keeps the claim from being about somebody else's pages in the first
 * place, which is not something a later comparison can undo.
 *
 * What the fold actually needs is one column per page — `Page.storyDelta` — and
 * the reviewed snapshot carries it. This is the same arithmetic
 * `rebuildStoryStateFromPages` does, minus the read that made it a question
 * about a different manuscript, and minus the write: a compile standing down
 * may not put a fold of a book it has disclaimed back onto the project. A page
 * whose delta never landed contributes nothing, exactly as it contributes
 * nothing there.
 */
export function reviewedStoryState(
  reviewedPages: Array<{ index: number; storyDelta: unknown }>,
  plan: BookPlan
): StoryState {
  return rebuildStoryState(
    reviewedPages.flatMap((page) => {
      const delta = parseStoryDelta(page.storyDelta);
      return delta ? [{ pageIndex: page.index, delta }] : [];
    }),
    seedStoryStateFromPromises(plan.promises ?? [])
  );
}
