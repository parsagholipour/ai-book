import { parseChapterBrief } from "./bookHelpers.js";
import { updateJobProgress } from "../runtime/jobLifecycle.js";
import { uniqueStrings } from "../runtime/serialization.js";
import { PAGE_QA_RECOVERY_CANDIDATE, pageQaRecoveryRevision } from "./tuning.js";
// The chapter brief's prompt budget, taken from the module that already spends
// it rather than spelled a second time here. Through the barrel, which a worker
// module may take whole — core's narrow subpaths are gated on an empty runtime
// closure (`scripts/check-core-subpaths.mjs`) and this needs no such entry.
import { CHAPTER_CONTINUITY_FOCUS_LIMIT } from "@book-maker/core";
import type {
  BookGenerationStrategy,
  BookPlan,
  ChapterBrief,
  ChapterPlan,
  CreateProjectInput,
  PageDraft,
  PageProductionBeat,
  PageQualityReport,
  PriorPageContext,
  TextModelAdapter
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";

/**
 * Recovery: what a page review loop does once ordinary rewrites have stopped
 * working. Where it starts, what it tells the rewrite and the operator, and the
 * one brief repair it may buy.
 *
 * Split out of `pageReview.ts` along the seam its size budget named. The loop
 * itself and the page save stayed there; everything here answers a question
 * about escalation, which is why the brief repair — the only thing in the loop
 * that *writes* — lives with the index that triggers it rather than beside the
 * rewrite it briefs.
 */

/**
 * Where recovery starts for one loop, or that it has none.
 *
 * Fitted to the loop's budget at both ends — see `pageQaRecoveryRevision` and
 * the counting-base note on `runPageQualityLoop`. A loop pinned to a
 * `userRequest` opts out entirely: recovery's instruction is "produce a
 * complete replacement page", and the reader who paid for "make the second
 * paragraph funnier" must get their edit repaired, never the page thrown away —
 * the same contract `keepUserRequestApplied` enforces on the report. Deciding
 * it here rather than at the one call site keeps the next one honest too — and
 * it is what `onRewrite` is handed, so a progress message cannot disagree with
 * the rewrite it is announcing about which mode this loop is in.
 */
export function recoveryRevisionForLoop(options: {
  maxCandidates: number;
  /** The caller's counting base; see `runPageQualityLoop`. */
  requested?: number | undefined;
  userRequest?: string | undefined;
}): number | undefined {
  if (options.userRequest) {
    return undefined;
  }
  return pageQaRecoveryRevision(options.maxCandidates, options.requested ?? PAGE_QA_RECOVERY_CANDIDATE);
}

/**
 * Whether a loop about to spend `revision` is in recovery.
 *
 * The one place the absent case is decided, which is why the three readers
 * below all go through it instead of spelling the comparison out again — see
 * `pageRevisionMessage` for what `undefined` costs when it is spelled as a
 * number instead.
 */
export function isRecoveryRevision(revision: number, recoveryRevision: number | undefined): boolean {
  return recoveryRevision !== undefined && revision >= recoveryRevision;
}

/**
 * `recoveryRevision` is the loop's own — the number `onRewrite` was handed, and
 * never one derived a second time here. The budget is tier-scaled and recovery
 * moves with it, so a message written against the raw constant withholds
 * "quality recovery" from exactly the tiers that reach it soonest, and one
 * recomputed from the book's input announces it on the loops a `userRequest`
 * opted out of.
 *
 * **That opt-out is `undefined`, and deliberately not a number.** It used to be
 * `Number.POSITIVE_INFINITY`, which reads correctly through a `>=` and nowhere
 * else: the sentinel was one `${}` away from an operator being told "recovery
 * starts at rewrite Infinity", and one subtraction away from `NaN`, with
 * nothing in any of these signatures to warn the caller that the number it was
 * handed is not one. `number | undefined` cannot be compared or subtracted from
 * without the compiler asking what the absent case means, and
 * `isRecoveryRevision` is where this module answers it once.
 *
 * Required rather than defaulted, on all three of these. They used to fall back
 * to `PAGE_QA_RECOVERY_CANDIDATE`, the one number this paragraph says none of
 * them may read: a new progress call site or a refactor dropping the argument
 * compiled clean and restored both original bugs — "Quality recovery" withheld
 * from fast, whose budget clamps recovery onto its last candidate, and
 * announced over a `userRequest` loop that has no recovery at all. An invariant
 * a docstring calls load-bearing cannot be left to a default, so the compiler
 * holds it instead — and a required `number | undefined` parameter is still a
 * compile error to omit.
 */
export function pageRevisionMessage(
  pageIndex: number,
  revision: number,
  maxRewriteAttempts: number,
  recoveryRevision: number | undefined
): string {
  const phase = isRecoveryRevision(revision, recoveryRevision) ? "Quality recovery rewrite" : "Revising";
  const rewriteAttempt = Math.max(1, revision - 1);
  return `${phase} page ${pageIndex} (rewrite ${rewriteAttempt}/${maxRewriteAttempts})`;
}

/** `recoveryRevision` is the loop's own — see `pageRevisionMessage`. */
export function pageRewriteReport(
  report: PageQualityReport,
  revision: number,
  recoveryRevision: number | undefined
): PageQualityReport {
  if (!isRecoveryRevision(revision, recoveryRevision)) {
    return report;
  }

  const recoveryInstructions = [
    `Previous rewrite attempts still failed QA; produce a complete replacement page for attempt ${revision}.`,
    "Use the rejected page only as diagnostic context, not as prose to preserve.",
    "Do not relax quality: satisfy the page brief, advance beyond prior pages, avoid repetition, and keep the page reader-ready."
  ];

  return {
    ...report,
    issues: [...report.issues, "Earlier generated replacements for this page were still rejected by QA."],
    requiredRevisions: [...report.requiredRevisions, ...recoveryInstructions],
    notes: [report.notes, "Quality recovery mode: make a structural replacement rather than a light edit."]
      .filter(Boolean)
      .join(" ")
  };
}

/** `recoveryRevision` is the loop's own — see `pageRevisionMessage`. */
export function shouldRepairPageBriefForRecovery(
  revision: number,
  report: PageQualityReport,
  pageBrief: PageProductionBeat | undefined,
  recoveryRevision: number | undefined
): pageBrief is PageProductionBeat {
  if (!pageBrief || !isRecoveryRevision(revision, recoveryRevision)) {
    return false;
  }

  if (!report.checks.repetitionOk || !report.checks.progressionOk) {
    return true;
  }

  const feedback = [...report.issues, ...report.requiredRevisions, report.notes].join(" ").toLowerCase();
  return /brief|assignment|repeat|repetition|already covered|same (argument|beat|point|scene)|stalled|does not progress|new distinct|fresh angle/.test(
    feedback
  );
}

/**
 * A re-planned beat, the chapter brief it belongs to, and the commit neither
 * has earned yet.
 *
 * Nothing here is written into anything the caller handed in. `chapterBrief` is
 * the brief this repair was given with `beat` merged into it, as a **new**
 * object: `runPageQualityLoop` rebinds its own local to it so the page's
 * remaining rewrites read the fresh assignment, and the caller's copy — a book
 * pass's per-chapter `ChapterSetup.brief`, a compile's per-chapter parse —
 * moves only if the loop hands the merge back out at the end, which it does on
 * exactly the condition `persist` is taken on. It is `undefined` only for a
 * caller that passed no chapter brief at all.
 *
 * `persist` is the durable `Chapter.productionBrief` write, null for a page in
 * no chapter. It accepts the publication transaction when the caller owns the
 * page save; callers that own no surrounding write may omit it and retain the
 * established standalone CAS. It is the loop's to take, once and only if the
 * draft the page keeps was briefed against `beat` (see `runPageQualityLoop`).
 * One condition for the row and for every caller's memory, which is the whole
 * point.
 */
type ChapterBriefPersistenceClient = Pick<Prisma.TransactionClient, "chapter">;

export type RepairedPageBrief = {
  /** The fresh assignment every remaining rewrite is briefed against. */
  beat: PageProductionBeat;
  /** The caller's chapter brief with `beat` merged in — a new brief, never theirs. */
  chapterBrief: ChapterBrief | undefined;
  persist: ((client?: ChapterBriefPersistenceClient) => Promise<ChapterBriefCasOutcome>) | null;
};

/**
 * A combined page/brief publication could not make its chapter half durable.
 * Throwing inside the caller's transaction rolls its already-staged page back;
 * direct standalone takes remain best-effort and receive the outcome instead.
 */
export class ChapterBriefPublicationRejectedError extends Error {
  constructor(
    readonly chapterId: string,
    readonly outcome: Exclude<ChapterBriefCasOutcome, "written">
  ) {
    super(`Chapter ${chapterId} rejected its combined brief publication (${outcome})`);
    this.name = "ChapterBriefPublicationRejectedError";
  }
}

export async function repairPageBriefForRecovery(options: {
  strategy: BookGenerationStrategy;
  input: CreateProjectInput;
  plan: BookPlan;
  chapter?: ChapterPlan | undefined;
  chapterBrief?: ChapterBrief | undefined;
  chapterPageStart?: number | undefined;
  chapterPageEnd?: number | undefined;
  chapterId?: string | null | undefined;
  pageBrief: PageProductionBeat;
  pageIndex: number;
  draft: PageDraft;
  qualityReport: PageQualityReport;
  previousPages: PriorPageContext[];
  continuityNotes: string[];
  textModel: TextModelAdapter;
  generationJobId?: string | undefined;
  context: string;
  /**
   * Ownership fence. Asked once as a stand-down the moment the repair's own
   * model call returns — every page that paid for that call, whether or not
   * it has anything to commit. The owner that eventually takes `persist` asks
   * again immediately before its publication phase; keeping that assertion
   * outside this data-only commit lets a page save and its brief repair share
   * one barrier and one transaction.
   */
  assertOwnership?: (() => Promise<void>) | undefined;
}): Promise<RepairedPageBrief> {
  await updateJobProgress(options.generationJobId, {
    message: `${options.context} brief conflict detected; repairing page brief before recovery rewrite.`
  });

  const repaired = await options.strategy.repairPageBrief({
    input: options.input,
    plan: options.plan,
    chapter: options.chapter,
    chapterBrief: options.chapterBrief,
    pageBrief: options.pageBrief,
    chapterPageStart: options.chapterPageStart,
    chapterPageEnd: options.chapterPageEnd,
    pageIndex: options.pageIndex,
    draft: options.draft,
    report: options.qualityReport,
    previousPages: options.previousPages,
    continuityNotes: options.continuityNotes,
    textModel: options.textModel
  });

  // The merge, as a new brief and nobody's yet. `runPageQualityLoop` rebinds
  // its own `chapterBrief` to it for the rest of *this page's* loop — the
  // remaining rewrite and review calls have to read the repaired beat whatever
  // a concurrent sibling page does to the persisted row, and whether or not
  // this repair's own write is ever taken — and hands it back out only for a
  // page that keeps a draft briefed against it.
  //
  // **It used to `Object.assign` this onto `options.chapterBrief`**, which is a
  // write into whichever object the caller happened to pass, and all three book
  // passes hand in the single `ChapterSetup.brief` every page of a chapter is
  // briefed from. So the page-local edit became a chapter-wide one the moment
  // the repair was *bought* rather than the moment it was earned: page 10
  // reaches recovery, its post-repair rewrite is rejected, `persist` is
  // correctly skipped and the row keeps the old beat — and pages 11..N are
  // drafted and reviewed against an in-memory brief claiming page 10 covers a
  // beat page 10 never wrote, silent about the one it did, and no longer
  // agreeing with the row it came from. The compile's repair pass had that same
  // failure and fixed it at its own call site, with a per-page copy to be
  // mutated and a fold onto the shared one; the defect was here, so that fixed
  // one call site and left the three book passes with it. Returning the merge
  // is that answer moved to the seam: acceptance gates every caller's copy by
  // construction rather than by each of them remembering to copy. An *accepted*
  // repair reaching the chapter's later pages is the feature; acceptance is the
  // gate.
  const chapterBriefWithRepair = replacePageBriefInChapterBrief(options.chapterBrief, repaired);

  // The first of the fence's two asks, and with nothing yet staged it is a
  // **stand-down**: the repair above is a model call, and a delivery that lost
  // the book across it must not spend the rest of the page's rewrite budget on
  // a manuscript somebody else owns.
  //
  // **Above the early return below, because that return answers a different
  // question.** It says there is nothing to commit, which is about the repair's
  // *write*; standing down is about whether this page may go on being written
  // at all. Underneath it, the pages the return answers for were the only ones
  // this fence never reached — and they are ordinary: `Page.chapter` is
  // nullable, the whole-book saves store pages outside every chapter range with
  // a null id, and a structural insert drafts them through
  // `reviewAndSaveGeneratedPage`, which forwards its nullable `chapterId`. They
  // are also the pages with nothing behind this ask: `persist` is null for
  // them, so the write's own fence below never runs, and a delivery that had
  // already lost its lease spent every rewrite and review it had left — the
  // most expensive thing on the page — before the page save's own assertion
  // finally stood it down. One indexed read, on a path that has just paid for a
  // planner call.
  //
  // What the ask raises is the caller's to define and travels out untouched,
  // exactly as it does from the eventual publication fence: the structural insert's
  // lost-lease error, which `restructurePagesDrafting.ts` logs and rethrows,
  // and the compile repair's `ExportRepairSupersededError`, which is a
  // distinguishable class precisely so it can cross this module. A
  // `StopRequestedError` is nobody's to swallow here either — this function
  // catches nothing, which is what keeps both true.
  await options.assertOwnership?.();

  const chapterId = options.chapterId;
  if (!chapterId) {
    return { beat: repaired, chapterBrief: chapterBriefWithRepair, persist: null };
  }

  // The one write on the *drafting* side of the page save, and it is read back
  // by every other page in the chapter — so it is handed back rather than made.
  // The rewrite this beat briefs has not been judged yet, and a rewrite the
  // reviewer rejects leaves the page shipping its pre-repair prose; the loop
  // takes the write only once a draft briefed against the beat is the one the
  // page keeps. The merged brief above travels on that same answer, so a
  // caller's memory of the chapter cannot claim a repair the row refused, or
  // refuse one the row took.
  //
  // The owner that takes this asks the write's fence. Keeping the assertion out
  // of the closure is load-bearing for `reviewAndSaveGeneratedPage`: it takes
  // one barrier and then runs the page upsert and this CAS on the same
  // transaction client, so takeover cannot leave the chapter ahead of a page
  // that was never published. A direct loop caller with no surrounding page
  // publication still takes the fence immediately before calling this.
  return {
    beat: repaired,
    chapterBrief: chapterBriefWithRepair,
    persist: async (client) => {
      const outcome = await casUpdateChapterProductionBrief(client ?? prisma, chapterId, repaired);
      // Supplying a client means the page owner has already staged its own row
      // in the same transaction. A best-effort non-write is not a valid answer
      // there: returning would commit the page while the chapter (and every
      // carried copy) kept the old assignment. The throw is deliberately
      // inside that transaction, so neither half lands. A standalone caller
      // omits the client and retains the established diagnostic outcome without
      // turning a paid planner call into a whole-page retry.
      if (client && outcome !== "written") {
        throw new ChapterBriefPublicationRejectedError(chapterId, outcome);
      }
      return outcome;
    }
  };
}

const CHAPTER_BRIEF_CAS_ATTEMPTS = 3;

/**
 * What one durable brief write did, which is the whole of what its log line
 * has to tell apart. `"unclaimable"` and `"lost-race"` both leave the row
 * holding somebody else's brief and neither is an error; they are different
 * *faults*, and the run log is where an operator has to see which one this was.
 */
export type ChapterBriefCasOutcome = "written" | "no-stored-brief" | "lost-race" | "unclaimable";

/**
 * The row as this write found it: the JSON document the compare-and-swap
 * stakes its claim on, beside the brief that document parses to.
 *
 * Two values rather than one, because they are not the same value and only one
 * of them is the row. The merge wants the parse — a repaired beat is folded
 * into a `ChapterBrief`, not into whatever spelling the row happens to hold —
 * while the claim wants the document, for the reason written out under
 * `casUpdateChapterProductionBrief`.
 */
type StoredChapterBrief = { document: Prisma.InputJsonValue; brief: ChapterBrief };

async function readStoredChapterBrief(
  client: ChapterBriefPersistenceClient,
  chapterId: string
): Promise<StoredChapterBrief | undefined> {
  const row = await client.chapter.findUnique({ where: { id: chapterId }, select: { productionBrief: true } });
  const document = row?.productionBrief;
  const brief = parseChapterBrief(document);
  if (!brief || document === null || document === undefined) {
    return undefined;
  }
  return { document: document as Prisma.InputJsonValue, brief };
}

/**
 * Chapters in the same wave can have several pages hit brief-repair recovery
 * concurrently (one job per page). A blind `chapter.update` here would let
 * whichever write lands second silently discard the first page's repair, so
 * this merges the repaired beat into a freshly-read row and writes it back
 * conditioned on the row still holding the state just read — retrying against
 * the winner's brief on a miss, the same compare-and-swap shape used for
 * per-entity continuity state in entityState.ts.
 *
 * A lost race is not an error: the beat still steered the page that paid for
 * it, and the row holds a sibling's repair rather than nothing.
 *
 * **The claim is staked on the row's own JSON, never on what that JSON parses
 * to.** It used to name `currentBrief` — the output of `parseChapterBrief`,
 * which is `chapterBriefSchema`, which is a `z.preprocess(normalizeChapterBrief,
 * …)`. That parse is not an identity: it renames every alias the producers are
 * allowed to emit (`visualMoment` and `imagePrompt` both become `imageMoment`),
 * it materialises `requiredContinuity` and `continuityFocus` through
 * `.default([])`, and the object schema strips every key it does not name. So
 * for any stored document that is not already its own parse, the value the
 * `equals` predicate carried was a document the column has never held — that
 * filter compares the whole document — and the CAS matched **zero rows on every
 * attempt**: three `updateMany` and three `findUnique` per repaired page, a
 * warning about a race nobody ran, and the repair silently dropped. Every page
 * of that chapter, for as long as the row held that spelling. The page-drafting
 * loop reached it one page at a time; `compileExportRepair.ts` now passes
 * `chapterId` and `assertOwnership` for every flagged page, so one compile
 * repairing fifteen pages of such a chapter would pay it fifteen times over and
 * keep none of them.
 *
 * The two live writers of `Chapter.productionBrief` (`bookState.ts`'s reset and
 * `generateBook.ts`) both store briefs that have already been through the
 * schema, so on today's code the stake happened to match — every producer in
 * `pagesPageMap.ts` parses, and the critic and dedup merges only spread what it
 * returned. That is a fact about this month's producers, not a property of the
 * column: the alias branches exist because models emit those spellings, one new
 * optional field defaults its way into the same divergence, and rows written by
 * earlier versions of this code are not re-checked by anything. A claim that
 * can only be made about a value the writer itself normalised is not a claim
 * about the row.
 *
 * So the stake is the document, and the row is still claimed cleanly: document
 * equality is *finer* than brief equality — two spellings can parse alike, and
 * one document can never parse two ways — so a sibling's concurrent repair
 * still makes this write miss and retry against the winner's brief rather than
 * write over it. What goes back is the merge of the **parse**, which is how a
 * row that was not its own parse becomes one the first time a repair lands on
 * it, and why every CAS after that is staked on a document the schema would
 * hand back unchanged.
 *
 * **And a miss nobody caused is reported as itself.** One warning line for both
 * outcomes is a line that cannot be acted on: a real race is ordinary traffic
 * on a fanned-out chapter and wants nothing done about it, while a row that
 * refuses a claim made out of its own document is this function being wrong
 * about the row — the defect above, or the next one shaped like it. They are
 * told apart by the only evidence there is: whether the row *moved* under the
 * miss.
 * A document that reads back byte-identical was written by nobody, so nothing
 * raced, and retrying can only miss again: it gives up on the first miss rather
 * than paying two more round trips to reach the same silence. Diagnosis only —
 * both outcomes write nothing and neither is an error, so a stringify that
 * misjudged two reads of one unchanged value would cost the wording of a
 * warning and never a write.
 */
async function casUpdateChapterProductionBrief(
  client: ChapterBriefPersistenceClient,
  chapterId: string,
  repaired: PageProductionBeat
): Promise<ChapterBriefCasOutcome> {
  let stored = await readStoredChapterBrief(client, chapterId);
  for (let attempt = 0; attempt < CHAPTER_BRIEF_CAS_ATTEMPTS; attempt += 1) {
    if (!stored) {
      return "no-stored-brief";
    }
    // The parse is what the beat is merged into; `stored.document` stays
    // exactly as the row handed it over, because that is what the claim below
    // names. Neither one is written through: the merge builds a new brief, and
    // nothing it returns shares an array with either.
    const updated = replacePageBriefInChapterBrief(stored.brief, repaired);
    const claimed = await client.chapter.updateMany({
      where: { id: chapterId, productionBrief: { equals: stored.document } },
      data: { productionBrief: updated as Prisma.InputJsonValue }
    });
    if (claimed.count === 1) {
      return "written";
    }
    const next = await readStoredChapterBrief(client, chapterId);
    if (next && !storedBriefMoved(stored.document, next.document)) {
      console.warn(
        `Chapter production brief update for ${chapterId} matched no row while the stored brief was unchanged; nothing raced it, so this compare-and-swap cannot claim the row it read`
      );
      return "unclaimable";
    }
    stored = next;
  }
  console.warn(`Chapter production brief update for ${chapterId} lost the CAS race ${CHAPTER_BRIEF_CAS_ATTEMPTS} times in a row`);
  return "lost-race";
}

/**
 * Whether the row changed between two reads of it — the whole of how a lost
 * race is told from a claim that could not be made.
 *
 * Both documents came out of one `jsonb` column, whose key order Postgres
 * normalises, so two reads of one unchanged value serialize identically and a
 * sibling's repair — which always rewrites a beat — never does. It answers a
 * warning's wording rather than a write, which is why a structural comparison
 * this cheap is enough.
 */
function storedBriefMoved(before: Prisma.InputJsonValue, after: Prisma.InputJsonValue): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

/**
 * The repaired beat merged into a chapter brief, as a **new** brief.
 *
 * Pure, and that is the load-bearing part. It used to `Object.assign` the
 * result back onto its argument as well, which is invisible at a call site and
 * meant every holder of that object — a book pass's per-chapter setup, a
 * compile pass's per-chapter parse, the row state a compare-and-swap is staked
 * on — took the repair whether or not anything had decided it was earned. Its
 * two callers here take the new brief and nothing else: the repair hands it
 * back for the loop to rebind and, on acceptance, to pass out, and the CAS
 * keeps the row it read as the state it stakes.
 *
 * **Pure is about the lists, not only about the object.** A merge that returns
 * a fresh brief holding the caller's own arrays has removed the write-through
 * on the way in and left it on the way out: the two briefs share one list, and
 * whichever of the caller's copies is written to next writes into both. So
 * nothing mutable crosses this function by reference. `continuityFocus` is
 * copied on the path that appends nothing (`focusWithRepairedContinuity`);
 * `pages` is rebuilt on both branches, and each *carried* beat is rebuilt with
 * it — a beat's fields are primitives apart from `requiredContinuity`, which is
 * the same kind of list and gets the same copy. `repaired` is the one thing
 * handed straight through, because it is this repair's own object rather than
 * the caller's: it comes back fresh from the planner call and is returned
 * beside the brief as `beat`, which is the identity `runPageQualityLoop` briefs
 * the remaining rewrites from. Everything else on the brief is a number or a
 * string, so the spread below carries no list of its own.
 */
export function replacePageBriefInChapterBrief(
  chapterBrief: ChapterBrief | undefined,
  repaired: PageProductionBeat
): ChapterBrief | undefined {
  if (!chapterBrief) {
    return undefined;
  }

  const replaced = chapterBrief.pages.some((page) => page.pageIndex === repaired.pageIndex);
  return {
    ...chapterBrief,
    pages: replaced
      ? chapterBrief.pages.map((page) => (page.pageIndex === repaired.pageIndex ? repaired : carriedPageBrief(page)))
      : [...chapterBrief.pages.map(carriedPageBrief), repaired].sort((a, b) => a.pageIndex - b.pageIndex),
    continuityFocus: focusWithRepairedContinuity(chapterBrief.continuityFocus, repaired.requiredContinuity)
  };
}

/** A beat this merge only carries across, copied down to its one mutable list. */
function carriedPageBrief(page: PageProductionBeat): PageProductionBeat {
  return { ...page, requiredContinuity: [...page.requiredContinuity] };
}

/**
 * The cap belongs to what this repair *appends*, not to what a chapter brief may
 * hold — the same rule `focusWithCriticNotes` states, reached from the other
 * spender of the one budget. Its reasoning is written out there
 * (`packages/core/src/generation/pageMapCritic.ts`) and is not restated here;
 * `CHAPTER_CONTINUITY_FOCUS_LIMIT` is imported from it for the same reason, so
 * the number has one spelling and both spenders move together.
 *
 * What is different is only *who* was truncating. This merge runs per page, on
 * every brief repair recovery buys, and it sliced unconditionally: a repaired
 * beat requiring no continuity at all still cut the chapter's list to the
 * budget. `ChapterBrief.continuityFocus` has no cap of its own
 * (`packages/core/src/schemas/book.ts`), so a chapter carrying 25 map-written
 * constraints is carrying 25 the map's own producers wrote and every page of it
 * has always been drafted against — entries 21-25 went the first time any one
 * of its pages reached recovery, whether or not the repair had anything to add.
 * And they did not go only for that page: this merge is what the CAS writes
 * back, and `Chapter.productionBrief` is read as `previousChapterPageBriefs` by
 * every later drafting, continuation and replan job, so the loss outlives the
 * page that paid for it.
 *
 * So a repair that appends nothing hands the array back exactly as it arrived —
 * not re-deduped and not cut — and only entries this repair added may push the
 * list to the limit.
 *
 * **As it arrived is not the same array, though.** Returning `existing` itself
 * made the merged brief's `continuityFocus` the *input* brief's, which is
 * precisely the write-through `replacePageBriefInChapterBrief` was made pure to
 * remove, arriving back through the one field that merge does not build for
 * itself. And it arrives on the common path: `requiredContinuity` is empty on
 * most repaired beats, so most repairs append nothing. `runPageQualityLoop`
 * rebinds to the merge and hands it out on acceptance, `adoptRepairedChapterBrief`
 * assigns it to the shared `ChapterSetup.brief` and the compile's repair does
 * the same through `chapterBriefs.set` — so the pre-repair brief and the
 * post-repair one held one list between them, and the next `push` from either
 * side wrote into both. In `casUpdateChapterProductionBrief` it was worse in
 * kind if not in effect: the row state the compare-and-swap staked its
 * `expected` on shared its list with the value being written over it — the
 * stake is the row's own JSON document now, which no merge can reach at all,
 * and the parse it feeds hands out fresh arrays anyway. The sibling spender
 * of this budget copies for exactly this reason and says so at length
 * (`focusWithCriticNotes`); this helper took its early-return shape and left the
 * copy behind.
 */
function focusWithRepairedContinuity(existing: string[], required: string[]): string[] {
  if (required.length === 0) {
    return [...existing];
  }
  return uniqueStrings([...existing, ...required]).slice(0, CHAPTER_CONTINUITY_FOCUS_LIMIT);
}
