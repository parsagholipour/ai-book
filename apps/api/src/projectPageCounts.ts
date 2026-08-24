import {
  PAGE_REWRITING_JOB_TYPES,
  openJobRewritesPages,
  type GenerationJobType
} from "@book-maker/core";
import { prisma, type BookEditOperationKind, type PageModel, type Prisma, type ProjectStatus } from "@book-maker/db";

/**
 * How many pages of a book are written, as every surface reporting progress
 * counts them: one read of the project's pages, and one question about the work
 * still open over them.
 *
 * It lives beside `projectStatus.ts` rather than in it because the answers below
 * are one subject — a kept draft counts as a page of the book exactly when
 * nothing is still going to redraft it — and that subject had grown to a third
 * of the poll's file. `buildProjectStatus` is the only caller, which is why the
 * tests are split the same way: `projectStatus.test.ts` measures the numbers
 * where they become visible, and `projectPageCounts.test.ts` asks the rule
 * directly where a poll fixture per case would say less than the case does.
 */

/**
 * The `Page` columns the status poll reads, spelled the way the Prisma model
 * spells them.
 *
 * A raw statement is an assertion over the wire rather than a type: a column
 * identifier has no link to the model, so renaming a field in `schema.prisma`
 * regenerates, typechecks and tests green and then throws `column
 * "qualityReport" does not exist` on the first status request of the day.
 * `satisfies` is that missing link — and the statement below is assembled from
 * these names rather than spelling them a second time, so the list cannot drift
 * from the SQL: it *is* the SQL. That covers the three columns nothing reads the
 * *value* of just as loudly: `markdown` and `qualityReport` are asked about
 * rather than selected and `projectId` only binds the parameter, but each one is
 * still a checked identifier, because a rename breaks the statement either way.
 *
 * What no type can see is a `@map` / `@@map`, which renames a column without
 * renaming the field it belongs to. The schema carries neither — on `Page` or
 * anywhere else — and `projectStatus.test.ts` reads `schema.prisma` itself to
 * go on saying so.
 */
const PAGE_STATUS_COLUMNS = ["id", "index", "status", "revision"] as const satisfies
  readonly Prisma.PageScalarFieldEnum[];
const PAGE_PROJECT_COLUMN = "projectId" satisfies Prisma.PageScalarFieldEnum;
const PAGE_BODY_COLUMN = "markdown" satisfies Prisma.PageScalarFieldEnum;
const PAGE_REPORT_COLUMN = "qualityReport" satisfies Prisma.PageScalarFieldEnum;
const PAGE_TABLE = "Page" satisfies Prisma.ModelName;

/**
 * The one read of the project's pages. Two of its columns are asked *about*
 * rather than selected, and both answers come back as one boolean per row:
 * whether the page holds prose, which the predicate below turns into a page of
 * the book, and whether it was ever reviewed, which is one integer in the
 * status poll. Neither value is wanted here, and both are expensive to carry —
 * `markdown` is the whole book, and `qualityReport` is a JSON report per page:
 * 600 of them deserialized, on every poll, to count them.
 *
 * The body test asks for a non-whitespace character, not for a non-empty
 * string: a drafting failure that stores `"\n"` leaves a FAILED_QA row `<> ''`
 * read as prose, so once rewrite ownership settled the shelf card and the book screen
 * reported 200/200 for a book with a blank printed page — the "never got
 * written, so owed rather than done" case `isBookPage` says it guards, through
 * the one door emptiness left open. Not `btrim`, whose default trim set is the
 * space character alone and which therefore answers *true* for `"\n"` and
 * `"\t"`; the regex was measured against the dev Postgres, false for `" "`,
 * `"\n"`, `"\t"` and `"  \n\r\t "` and true for `"\n a \n"`, and it stops at the
 * first non-space character rather than copying a body this read exists not to
 * carry. `[:space:]` does not cover U+00A0 or U+200B, so those still count as
 * written — the safe direction, since a page reported done that prints blank is
 * worse than one reported owed.
 *
 * `COALESCE` rather than the bare test because `NULL ~ …` is NULL, not false:
 * were `markdown` ever to become nullable the column would come back as a third
 * state instead of a boolean — an undercount with no error behind it, which is
 * the failure this read exists to prevent.
 *
 * The report test carries the same guard, and it is the column that actually
 * needs one: `markdown` is `text NOT NULL`, while `Page.qualityReport` is
 * `Json?` and therefore holds SQL NULL *or* the jsonb value `null`. Prisma
 * normalises both to JS `null` on read, so the filter this statement replaced —
 * `page.qualityReport !== null` — counted neither, and a bare `IS NOT NULL` is
 * true for jsonb `null`: a page written through `Prisma.JsonNull` would be
 * reported as reviewed while carrying no report at all. Nothing writes one
 * today — 0 rows of 855 on the dev database — and `NullableJsonNullValueInput`
 * is one call away in the generated client, which is the whole distance between
 * a predicate that means what it says and one that does not. `jsonb_typeof`
 * answers `'null'` for that value and NULL for the absent column, and the
 * `COALESCE` folds both into the same false; all of it measured against the dev
 * Postgres, including the spelling not taken — `<> 'null'::jsonb` is NULL
 * rather than false for a SQL NULL, which is the third state again, in the
 * predicate written to avoid it.
 */
const PAGE_STATUS_SQL = [
  `SELECT ${PAGE_STATUS_COLUMNS.map(quotedIdentifier).join(", ")},`,
  `  COALESCE(${quotedIdentifier(PAGE_BODY_COLUMN)}, '') ~ '[^[:space:]]' AS "hasMarkdown",`,
  `  COALESCE(jsonb_typeof(${quotedIdentifier(PAGE_REPORT_COLUMN)}), 'null') <> 'null' AS "hasQualityReport"`,
  `FROM ${quotedIdentifier(PAGE_TABLE)}`,
  `WHERE ${quotedIdentifier(PAGE_PROJECT_COLUMN)} = $1`
].join("\n");

function quotedIdentifier(name: string): string {
  return `"${name}"`;
}

/**
 * One page of the project, as every number below counts it. The shape is the
 * model's own, minus the two columns nobody here reads the value of:
 * `hasMarkdown` and `hasQualityReport` are what the statement above computes in
 * their place.
 */
export type ProjectPageRow = Pick<PageModel, (typeof PAGE_STATUS_COLUMNS)[number]> & {
  hasMarkdown: boolean;
  hasQualityReport: boolean;
};

/**
 * Every page number the status poll reports, off one snapshot.
 *
 * The complete count used to be its own `page.count` beside this list, over the
 * same rows with a narrower predicate — a second round trip, and a second
 * snapshot of a book the worker is still writing to. The compile's repair pass
 * flips FAILED_QA pages to COMPLETED one at a time while the app polls, so a
 * poll landing between the two reads answered "199/200 complete, 0 blocked
 * pages": a state the book was never in, made of two states it was.
 *
 * One statement is also a stronger claim than two reads inside a REPEATABLE
 * READ transaction would be — a lost isolation level brings the skew back
 * silently, where a lost column identifier throws.
 */
export async function readProjectPageRows(projectId: string): Promise<ProjectPageRow[]> {
  return await prisma.$queryRawUnsafe<ProjectPageRow[]>(PAGE_STATUS_SQL, projectId);
}

/**
 * How many of those rows are pages of the book the reader is holding.
 *
 * A page that exhausted its QA budget keeps its best draft and still ships in
 * the export (FAILED_QA with prose), so once nothing is going to rewrite it, it
 * counts — a finished, readable 200-page book must not report 197/200. Whether
 * anything still will is the *pipeline's* question rather than the page's,
 * which is why it arrives as an argument; see `pageRewriteScope`.
 */
export function countBookPages(pages: readonly ProjectPageRow[], rewriteScope: PendingPageRewriteScope): number {
  const owedPageIndexes = rewriteScope.kind === "page_indexes" ? new Set(rewriteScope.pageIndexes) : null;
  return pages.filter((page) =>
    isBookPage(page, rewriteScope.kind === "all" || owedPageIndexes?.has(page.index) === true)
  ).length;
}

/**
 * Pages an open pipeline can still rewrite. `page_indexes` with an empty list
 * means no page is owed; `all` means either every page is in scope or the open
 * work cannot be narrowed safely enough to count a kept draft.
 */
export type PendingPageRewriteScope =
  | Readonly<{ kind: "all" }>
  | Readonly<{ kind: "page_indexes"; pageIndexes: readonly number[] }>;

const ALL_PAGE_REWRITES: PendingPageRewriteScope = Object.freeze({ kind: "all" });
const NO_PAGE_REWRITES: PendingPageRewriteScope = Object.freeze({
  kind: "page_indexes",
  pageIndexes: Object.freeze([] as number[])
});

function pageIndexRewriteScope(pageIndexes: readonly number[]): PendingPageRewriteScope {
  if (
    pageIndexes.length === 0 ||
    pageIndexes.some((pageIndex) => !Number.isInteger(pageIndex) || pageIndex <= 0)
  ) {
    return ALL_PAGE_REWRITES;
  }
  return {
    kind: "page_indexes",
    pageIndexes: [...new Set(pageIndexes)].sort((left, right) => left - right)
  };
}

function mergePageRewriteScopes(scopes: readonly PendingPageRewriteScope[]): PendingPageRewriteScope {
  const pageIndexes = new Set<number>();
  for (const scope of scopes) {
    if (scope.kind === "all") {
      return ALL_PAGE_REWRITES;
    }
    for (const pageIndex of scope.pageIndexes) {
      pageIndexes.add(pageIndex);
    }
  }
  return pageIndexes.size === 0
    ? NO_PAGE_REWRITES
    : { kind: "page_indexes", pageIndexes: [...pageIndexes].sort((left, right) => left - right) };
}

/**
 * The statuses in which the pipeline has stopped *starting* work on pages.
 * `EDITING` belongs here — the ordinary edit's own recompile carries
 * `skipFinalReview`, so a page it left FAILED_QA is already the page that
 * prints — but it is only half the question, and `EDITING` is exactly where the
 * other half was learned: an edit that is still running says EDITING too. See
 * `openPageRewriteScope`.
 */
const SETTLED_PROJECT_STATUSES: ReadonlySet<string> = new Set(
  ["COMPLETE", "REVIEW_REQUIRED", "EDITING"] as const satisfies readonly ProjectStatus[]
);

/**
 * Whether a kept draft is the page the book prints: both halves have to agree —
 * the pipeline has stopped drafting, *and* nothing open would redraft it.
 *
 * Only a book whose status already stopped the drafting can have its count
 * turned by the second half, so the poll that runs every few seconds through a
 * generation never sends that read. Every poll of a *finished* book does — a
 * shelf card is polled long after the generation that filled it — which is what
 * `openPageRewriteScope` is written to make cheap.
 */
export async function pageRewriteScope(projectId: string, projectStatus: string): Promise<PendingPageRewriteScope> {
  if (!SETTLED_PROJECT_STATUSES.has(projectStatus)) {
    return ALL_PAGE_REWRITES;
  }
  return await openPageRewriteScope(projectId);
}

const APPLY_BOOK_EDIT_JOB_TYPE = "APPLY_BOOK_EDIT" satisfies GenerationJobType;

/**
 * Whether anything still open for this project is going to rewrite one of its
 * pages.
 *
 * A status cannot answer that on its own, though `SETTLED_PROJECT_STATUSES` was
 * read as saying it could. Three forks draft pages in a status that reads as
 * finished: `restructurePages` and `replanBook` set the project EDITING and then
 * draft through `reviewAndSaveGeneratedPage`, and `continueBook` sets it
 * COMPLETE and then queues its recompile. Every one of them can leave a
 * FAILED_QA row holding prose in a status this file used to read as settled, so
 * "add 3 pages" reported 203/203 with three pages still owed — the skew the
 * predicate exists to prevent, on the book screen and the shelf card.
 *
 * The compile is one such job and was for a while the only one asked about,
 * which left the drafting window before it exists uncovered: the structural
 * insert's recompile is queued after its *last* page is written, so a poll
 * landing on page 2 of 3 saw no compile, called the rewrites settled, and
 * counted a page the drafting loop had just flagged. `openJobRewritesPages`
 * closes that by asking the type as well as the payload —
 * `JOB_PAGE_REWRITE_SCOPE` in `packages/core/src/jobScope.ts` is exhaustive over
 * `GenerationJobType`, so a new job type is a compile error there until someone
 * says whether it can rewrite a page, rather than another hand-kept list to
 * drift.
 *
 * Both halves of the answer live in that table, and a finished book needs both.
 * A narration or a library portrait is open on plenty of delivered books and can
 * move nothing, so the type filter keeps them out of the read entirely; an export
 * repair *is* a COMPILE_EXPORT and does come back, and `skipFinalReview` on its
 * payload is what says it rewrites nothing. That flag is negated here rather than
 * in the `where`: negating a JSON-path predicate in SQL drops every row whose
 * payload simply *lacks* the key, which is every full-review compile — the only
 * compile this asks about. (`mobile/qualityVerdict.ts` met the same trap and
 * needed a column to get out of it; this one needs no write, because a payload
 * flag read in JS over at most a handful of open jobs is already the whole
 * answer.)
 *
 * The rows come off `@@index([projectId, type, status])` rather than out of the
 * 25 newest jobs the status poll already holds, for the reason that file records:
 * job churn — a repair every five minutes, an audiobook, a burst of image
 * retries — pushes the row that matters out of that window, and a count that
 * silently changes meaning when it does is the failure again with no symptom.
 * Widening the type list from one value to seven keeps the same index, and the
 * read is still sent only for a settled project.
 *
 * It is *one* read of the jobs, and the payload rides along with the type — the
 * fork of an open apply is the only thing that costs a second statement, and
 * `openEditPageRewriteScope` is where that is paid for. Six of those seven types
 * never look at a payload, which was the argument for asking the
 * index about `type` alone first and sending a payload-carrying read only when
 * that had not already answered: `APPLY_BOOK_EDIT` carries the reader's edit
 * request text and its per-page instructions, and shipping those here to be
 * dropped is real waste. What the probe shortened was the two cases that were
 * already cheap — nothing open, and an open row the table answers `always` for
 * — while the case it was written for grew a statement. Every delivered book
 * has an export repair queued every five minutes (`ensureExportRepairQueued`),
 * so a COMPLETE book's steady state *is* an open COMPILE_EXPORT: the probe
 * finds the row, the table cannot settle it, and a second statement re-reads
 * the same rows to add one column. That is an extra round trip on every poll of
 * every finished book on the box.
 *
 * And the bytes it was buying sit beside a much larger spend in the same
 * handler. `project.jobs` there loads the 25 newest job rows *whole*, payload
 * included, and parses each of them for `jobsWithSteps`, on every poll, settled
 * or not. Ordinarily an open job is one of those rows, so its request text has
 * already been shipped and deserialized by the time this read declines to fetch
 * it; where the churn above has pushed it out, what the probe saved is one
 * row's payload against 25 the poll paid for anyway. Either way the split
 * bought a second copy, at most a handful of rows wide, for a round trip in the
 * one case that recurs forever.
 *
 * Asking Postgres for the flag instead — a raw statement selecting `type` and a
 * JSON-path boolean — would be one round trip and no payload bytes, and is not
 * worth it here: it spells `skipsFinalReview` a second time, in SQL, across the
 * negation trap above, to save the deserialization of a few small payloads. The
 * flag is read in JS, where the one definition of it lives.
 *
 * One type is left over when that read has answered, and it is the one the
 * table cannot answer at all: an APPLY_BOOK_EDIT is a page rewrite, a
 * structural insert *and* a free picture move, told apart by a column on
 * another row. It is asked about last, and only where nothing else has already
 * settled the question — see `EDIT_OPERATION_PAGE_REWRITE_SCOPE` and
 * `openEditPageRewriteScope`.
 */
async function openPageRewriteScope(projectId: string): Promise<PendingPageRewriteScope> {
  const openJobs = await prisma.generationJob.findMany({
    where: {
      projectId,
      // Copied, never handed over: the list is a frozen module singleton, and a
      // builder that normalised its arguments in place would throw on it.
      type: { in: [...PAGE_REWRITING_JOB_TYPES] },
      status: { in: ["QUEUED", "ACTIVE"] }
    },
    select: { type: true, payload: true }
  });
  const owed = openJobs.filter((job) => openJobRewritesPages(job.type, job.payload));
  if (owed.length === 0) {
    return NO_PAGE_REWRITES;
  }
  const applies = owed.filter((job) => job.type === APPLY_BOOK_EDIT_JOB_TYPE);
  // Anything else the table already settled is the answer, and settles it
  // without the second read.
  if (applies.length < owed.length) {
    return ALL_PAGE_REWRITES;
  }
  return await openEditPageRewriteScope(applies.map((job) => job.payload));
}


/**
 * Which forks of `applyBookEdit` can leave a page owed a rewrite, keyed by the
 * column the worker forks on.
 *
 * `JOB_PAGE_REWRITE_SCOPE` answers `always` for APPLY_BOOK_EDIT, and at the
 * granularity of a job type that is the honest answer — but it is coarser than
 * the truth, and the difference is user-visible on the commonest free edit
 * there is. Moving a picture is free and is explicitly *not* a page edit; it
 * rides APPLY_BOOK_EDIT all the same, so a delivered 200-page book with three
 * kept FAILED_QA drafts reported 197/200 for the whole edit, flipped `pagesDone`
 * false, re-opened the finished book's Pages step on the shelf card and the book
 * screen, and then snapped back. A stalled operation row held the book there
 * for good.
 *
 * `BookEditOperation.kind` is a sound discriminator for it, which not every
 * column on that row would be. It is written once, in the `create` that opens
 * the operation — before the generation job row exists, let alone goes ACTIVE —
 * and no later write touches it: the worker *reads* it to fork on, and the
 * fence comments in `applyBookEdit.ts` turn on it being the copy that cannot go
 * missing. So a poll landing at any moment of the edit's life reads the same
 * value the handler will fork on, including the moments before the job is
 * delivered at all.
 *
 * The three `none` rows are the presentation edits: `applyImageInsertion` and
 * `applyImageLayout` write `markdown`, `imagePrompt` and a revision bump, never
 * `Page.status`, never through the review loop, and their recompiles carry
 * `skipFinalReview`. Nothing they do can turn a kept draft back into an owed
 * page. The ordinary text edits are `page_indexes`: their operation records the
 * exact model indexes before enqueueing the worker, whose payload carries the
 * same target. The read takes the union of both copies, so a mismatch cannot
 * make a page look settled while either copy still says it is owed.
 * Structural, continuation and replan work is `all`, because an empty target is
 * part of their payload contract rather than evidence that no page is owed.
 * MANUAL_EDIT is page-scoped and unreachable: Edit Mode writes its pages in the
 * API transaction and files the operation APPLIED with no job at all, so no
 * open row can name it — but an APPLY_BOOK_EDIT that somehow did would fall
 * through to the same index-driven rewrite loop.
 *
 * Exported for the test that reads `enum BookEditOperationKind` out of
 * `schema.prisma` and measures this table against it, for the same reason the
 * column list above is read from the schema rather than trusted: `satisfies`
 * ties this to the *generated client*, which is a `pnpm db:generate` behind the
 * schema at any moment.
 */
type EditPageRewriteScope = "none" | "page_indexes" | "all";

export const EDIT_OPERATION_PAGE_REWRITE_SCOPE = {
  /** The pages the reader named, redrafted through the review loop. */
  PAGE_REWRITE: "page_indexes",
  /** A worded patch to one page; the same loop where the text is not exact. */
  LOCAL_PATCH: "page_indexes",
  CHAPTER_REGENERATE: "page_indexes",
  /** Inserts draft new pages through `reviewAndSaveGeneratedPage`. */
  RESTRUCTURE_PAGES: "all",
  BOOK_REPLAN: "all",
  CONTINUE_BOOK: "all",
  /** Rides a REVISE_PLAN job, which the type filter drops before this is read. */
  PLAN_REVISION: "all",
  MANUAL_EDIT: "page_indexes",
  /** A bought illustration placed into the page, not a rewrite of it. */
  ADD_IMAGE: "none",
  /** Free, and not a page edit — the invariant the residue above contradicted. */
  MOVE_IMAGE: "none",
  REMOVE_IMAGE: "none"
} as const satisfies Record<BookEditOperationKind, EditPageRewriteScope>;

/**
 * The same table as a lookup, so an inherited property cannot answer for a
 * kind — and so an unknown one answers the safe way. The `satisfies` above is
 * what makes a new `BookEditOperationKind` a compile error here, but only once
 * the client is regenerated; a kind this process has never heard of is work it
 * cannot rule out.
 */
const editPageRewriteScopeByKind = new Map<string, EditPageRewriteScope>(
  Object.entries(EDIT_OPERATION_PAGE_REWRITE_SCOPE)
);

/**
 * Whether any of these open applies took a fork that rewrites pages.
 *
 * One read, by primary key, of at most a handful of rows — and only for a
 * settled book that has an open APPLY_BOOK_EDIT, which is an edit in flight
 * rather than a steady state. The case that recurs forever is the export repair
 * on every delivered book, and that one is answered off its own payload above
 * without reaching this.
 *
 * Every unknown answers `all`, which is the safe direction of this predicate
 * throughout: a page reported owed and then delivered, rather than delivered
 * and then taken back. A payload with no `operationId`, a missing operation row,
 * or an empty/malformed target on a page-scoped fork cannot justify counting a
 * kept draft. The job payload and operation row normally carry the same page
 * indexes; their union is conservative during the brief window where the
 * operation has recorded a narrower applied result but the job is still open.
 */
async function openEditPageRewriteScope(payloads: unknown[]): Promise<PendingPageRewriteScope> {
  const payloadsByOperationId = new Map<string, unknown[]>();
  for (const payload of payloads) {
    const operationId = editOperationIdOf(payload);
    if (!operationId) {
      return ALL_PAGE_REWRITES;
    }
    const operationPayloads = payloadsByOperationId.get(operationId) ?? [];
    operationPayloads.push(payload);
    payloadsByOperationId.set(operationId, operationPayloads);
  }
  const operationIds = [...payloadsByOperationId.keys()];
  const operations = await prisma.bookEditOperation.findMany({
    where: { id: { in: operationIds } },
    select: { id: true, kind: true, affectedPageIndexes: true }
  });
  if (operations.length < operationIds.length) {
    return ALL_PAGE_REWRITES;
  }
  return mergePageRewriteScopes(
    operations.map((operation) => {
      const scope = editPageRewriteScopeByKind.get(operation.kind);
      if (scope === "none") {
        return NO_PAGE_REWRITES;
      }
      if (scope === "page_indexes") {
        const operationPayloads = payloadsByOperationId.get(operation.id);
        if (!operationPayloads) {
          return ALL_PAGE_REWRITES;
        }
        return mergePageRewriteScopes([
          pageIndexRewriteScope(operation.affectedPageIndexes),
          ...operationPayloads.map((payload) =>
            pageIndexRewriteScope(editAffectedPageIndexesOf(payload) ?? [])
          )
        ]);
      }
      return ALL_PAGE_REWRITES;
    })
  );
}

/** The operation an `APPLY_BOOK_EDIT` payload names, or null if it names none. */
function editOperationIdOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const operationId = (payload as Record<string, unknown>).operationId;
  return typeof operationId === "string" && operationId.length > 0 ? operationId : null;
}

/** Page targets copied onto an `APPLY_BOOK_EDIT` payload, or null when unknown. */
function editAffectedPageIndexesOf(payload: unknown): readonly number[] | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const pageIndexes = (payload as Record<string, unknown>).affectedPageIndexes;
  return Array.isArray(pageIndexes) && pageIndexes.every((pageIndex) => typeof pageIndex === "number")
    ? pageIndexes
    : null;
}

/**
 * A page the finished book prints: approved, or out of QA budget but still
 * holding the draft the export will ship. A FAILED_QA row with no prose is a
 * page that never got written, and it is owed rather than done — whitespace
 * included, a rule `PAGE_STATUS_SQL` states because the database answers it.
 *
 * The kept draft counts only once no open work owns that page, because FAILED_QA is
 * written at two moments that mean opposite things to this number. Drafting
 * writes it as soon as a page's rewrite budget runs out — see
 * `reviewAndSaveGeneratedPage` — with the compile's repair pass still to come,
 * and counting that page reports a 200-page book 200/200 while three pages are
 * still owed: `pagesDone` then marks Pages done and starts the images step over
 * work in flight. The repair writes it again for the pages it could not fix,
 * and those *are* the book.
 *
 * Nothing on the row separates the two, so the caller asks the pipeline: a
 * status that has stopped drafting (`SETTLED_PROJECT_STATUSES`) and nothing open
 * that would rewrite the page (`openPageRewriteScope`). Both halves, because
 * neither is the answer on its own — a generation's own repair runs while the
 * project is GENERATING, and a structural insert drafts, flags and repairs its
 * pages while the project says EDITING or COMPLETE.
 */
function isBookPage(page: Pick<ProjectPageRow, "status" | "hasMarkdown">, rewriteOwed: boolean): boolean {
  return page.status === "COMPLETED" || (!rewriteOwed && page.status === "FAILED_QA" && page.hasMarkdown);
}
