import { z } from "zod";
import type { ProductionMapRepairProviderCallMetadata, TextModelAdapter } from "../adapters/types.js";
import type { ChapterBrief, PageProductionBeat } from "../schemas/book.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import {
  MAX_BEAT_DEDUP_FINDINGS,
  type BeatAssignment,
  type BeatFingerprint,
  type DuplicateBeatFinding,
  fingerprint,
  scorePair
} from "./pageBeatDedupDetect.js";
import { LAST_PAGE_ENDING_PRESSURE, pageEndingContract } from "./pageBriefContract.js";
import type { PageMapCriticPatch } from "./pageMapCritic.js";

/**
 * Planner-side beat dedup: deterministic detection of near-duplicate page
 * beats across the whole page map, and one bounded model call that rewrites
 * the later page of each colliding pair to a fresh angle — before a single
 * page is drafted.
 *
 * Why it exists: a page whose brief collides with a beat an earlier page
 * already covers fails the page reviewer the same way on every rewrite, so
 * the collision is discovered only after the drafting loop and the final-QA
 * repair have both spent their whole budgets re-executing it (the 2026-08-22
 * 200-page reference book: pages 173/177 shared a blockade beat, page 191
 * repeated an earlier page's method, ~10 rewrites each, all rejected).
 * Detection cannot be left to a model pass: the page-map critic is asked to
 * spot duplicates but is one bounded call over the whole map and is off by
 * default below premium — and the per-chapter brief fan-out writes chapters
 * concurrently, so no producer ever saw the colliding pair side by side.
 *
 * **Detection and the rewrite call are bounded separately, because only one of
 * them spends anything** — which is also where this pass is split in two. The
 * sweep, the beat-specific bars and the fingerprints are `pageBeatDedupDetect.ts`
 * and spend nothing; the overlap measurement they score with is `pageOverlap.ts`,
 * shared with the page-time repetition check. Everything here is the one paid
 * call and what may reach the page map out of it. The sweep is over the whole
 * map; `MAX_BEAT_DEDUP_FINDINGS` caps what is sent to the model. Held as one
 * number — the sweep's own loop condition — the map that trips the cap stopped
 * being scanned at the twelfth collision, and the pages past that point lost
 * the free half of this pass along with the paid one: no rewrite, which is the
 * cap working, and no distinctness note, which is the cap reaching something it
 * was never about. The findings past the cap therefore travel with the rest and
 * `beatDedupPatch` writes their notes exactly as it writes the notes of a flagged
 * page whose rewrite was dropped —
 * one path, because "no rewrite arrived for this page" is one fact however it
 * came about. That one path is also what revives a match detection refused to
 * write down at all, and the detect module's docstring says why there is one.
 *
 * **The rewrites are held apart from each other too, and deterministically.**
 * Each flagged page is told to differ from *its own* earlier twin, and on a map
 * where every finding names the same earlier page — which is what a run of
 * copies produces, page 1 being the only page always safe to name — they all
 * receive the identical instruction and the identical note. One call can
 * therefore replace N collisions with a fresh one. So the prompt says outright
 * that the rewrites must differ from one another, and
 * `withoutCollidingRewrites` measures whether they did with this module's own
 * scoring: a second model call to audit the first is the spend this whole pass
 * exists to avoid.
 *
 * **And they are held apart from the pages nobody is rewriting.** That batch
 * rule compares the rewrites with each other and with nothing else, so a fresh
 * angle landing squarely on an *unflagged* page's assignment shipped into
 * drafting unmeasured. Page 31 of a 40-page map, flagged against page 17, is
 * shown its duplicate-of and its two neighbours and no other page at all — so
 * an answer restating page 9's beat reads as fresh to everything that looks at
 * it, and detection never runs again, which makes that the collision the book
 * is drafted with and this pass the thing that introduced it. Every unflagged
 * page's print is therefore scored against each accepted rewrite too, and a
 * rewrite colliding with one is dropped. Dropping is the whole penalty: the
 * page keeps the assignment it came in with and still gets its distinctness
 * note, which is exactly where it stood before the call rather than one
 * collision worse.
 *
 * **A flagged page the model left alone is part of that standing set too, so
 * the keep/drop decision and the set are one pass.** Which pages this sweep is
 * "not rewriting" is not `flaggedIndexes`: the model answers for the pages it
 * chooses, and this pass drops answers of its own. Findings for pages 10 and 20
 * with one rewrite back for page 10 left page 20 holding the very beat detection
 * flagged, and nothing ever scored page 10's fresh angle against it — so the map
 * shipped with a new near-duplicate pair on two pages nothing measures again,
 * introduced by the pass that exists to remove them, and page 20's own note said
 * nothing about page 10. The standing set therefore starts as every unflagged
 * page *plus* the original beat of every flagged page the model answered for
 * with nothing, and a rewrite dropped inside the loop hands its page back to its
 * original there and then. Which pages end up retained is only knowable after
 * the decisions, which is why the set is grown by the pass rather than computed
 * up front.
 *
 * **And why the pass cannot stop at the end of the batch.** A forward pass puts
 * an original handed back late only to the rewrites behind it, so page 5's
 * accepted angle was never re-asked about page 20's original once page 20's own
 * rewrite was dropped — the same near-duplicate as the paragraph above,
 * introduced through the guard rather than around it. So the loop is followed by
 * a settle over the rewrites already kept; `withoutCollidingRewrites` states
 * what that costs and why it terminates.
 *
 * **Under the measurability floors that batch rule falls back to text
 * equality.** `scorePair` answers `undefined` unless *both* sides clear
 * `MIN_BEAT_SHINGLES` and `MIN_BEAT_KEYWORDS`, and a model asked for twelve
 * patches against a 3200-token cap answers beneath them: "Name the cost. | The
 * cost lands." scores `undefined` against a verbatim copy of itself, so every
 * copy was kept and the pass published N copies of one angle — the exact
 * failure the batch rule exists for, firing precisely when the model is under
 * output pressure. Detection over the original map keeps waving short beats
 * through, and the two are not in tension: there the floors stop a terse
 * assignment matching every long beat that shares a noun, and a page map is not
 * a batch of answers to one prompt.
 */

/**
 * The free half of the pass is a module of its own; this one is its public face,
 * so nothing outside imports it directly and the barrel keeps one entry.
 */
export {
  BEAT_KEYWORD_OVERLAP_THRESHOLD,
  BEAT_SHINGLE_SIMILARITY_THRESHOLD,
  BEAT_SWEEP_PAIRS_PER_SLICE,
  MAX_BEAT_DEDUP_FINDINGS,
  MIN_BEAT_KEYWORDS,
  MIN_BEAT_SHINGLES,
  findDuplicatePageBeats,
  type DuplicateBeatFinding,
  type FindDuplicatePageBeatsOptions
} from "./pageBeatDedupDetect.js";

/**
 * A rewrite is whole or it is nothing: all three fields are required.
 * `endingPressure` was optional, and `mergePageMapCriticPatch` falls back to
 * the page's stored one when a patch omits it — so a page whose `purpose` and
 * `beat` had both been replaced kept the handoff written for the beat that no
 * longer existed, promising the next page a consequence of something that now
 * never happens. That is every page but the book's last, which
 * `withContractedEnding` substitutes for anyway. Refusing the partial patch is
 * Refusing the partial patch is cheap here: the caller composes
 * `beatDedupPatch(findings)` for notes, and Phase 02's integrity pass treats a
 * failed rewrite as a reason to regenerate the chapter rather than to ship the
 * corrupt map.
 *
 * `requiredContinuity` is the fourth field of an assignment and the one this
 * schema cannot demand. A page whose map wrote it no continuity has nothing to
 * answer for, and a model omits an empty array as readily as it emits one — so
 * requiring it here would fail the whole call, and spend its one repair attempt,
 * on the commonest map there is. It is optional in the schema and answered for
 * per page instead (`answersForMappedContinuity`): a rewrite for a page that
 * *does* carry continuity and named none of it is dropped exactly as a colliding
 * one is, and that page keeps its whole assignment and its own entries. Which of
 * those entries survive a whole-assignment rewrite is a question only the model
 * writing that assignment can answer — the alternative is guessing from the text
 * which of them were beat-derived — so this pass either gets the answer or
 * leaves the page where it found it.
 *
 * `imageMoment` is the fifth field and takes the fourth's shape for the same
 * reason. It is the one visual moment the page's illustration is drawn from, and
 * a rewrite that moved everything else left it pointed at the assignment the
 * rewrite had just removed: page 177 escaped its blockade beat and was still
 * illustrated with "A readable scene focused on the North Sea blockade", because
 * `mergePageMapCriticPatch` spreads `...page` first, `pagesPageMap.ts` carries
 * the field forward into the whole-book draft payload, and `pages.ts` hands the
 * `pageBrief` — this field included — to both the drafting prompt and the
 * interior-illustration prompt. That is the argument the paragraph above makes
 * for demanding `endingPressure`, applied to the field it forgot, and the model
 * writing the new assignment is again the only thing that can write a visual
 * moment for it. It cannot be *required* here either, and for the sharper
 * version of the same reason: `imageMoment` is optional on `PageProductionBeat`,
 * plenty of maps write none, and a page that never had one **must not gain one**
 * — a picture is a real cost and a real change to a book nobody asked this pass
 * to illustrate. So it is answered for per page (`answersForMappedImageMoment`),
 * exactly as continuity is: a rewrite for a page that carries a moment and named
 * none is dropped, and a moment volunteered for a page that carries none is
 * dropped from the rewrite rather than costing the page its fresh beat.
 */
const beatRewritePatchSchema = z.object({
  beatPatches: z
    .array(
      z.object({
        pageIndex: z.number().int().positive(),
        purpose: z.string().min(1),
        beat: z.string().min(1),
        endingPressure: z.string().min(1),
        requiredContinuity: z.array(z.string().min(1)).optional(),
        imageMoment: z.string().min(1).optional()
      })
    )
    .default([])
});

type BeatRewritePatch = z.infer<typeof beatRewritePatchSchema>["beatPatches"][number];

function truncateBeat(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length <= 140 ? trimmed : `${trimmed.slice(0, 139)}…`;
}

function distinctnessLine(finding: DuplicateBeatFinding): string {
  return `Stay distinct from page ${finding.duplicateOfPageIndex}, which already covers: ${truncateBeat(finding.earlierText)}`;
}

/**
 * Composes the findings — and any model rewrites for them — into the same
 * patch shape `mergePageMapCriticPatch` merges, so this pass has no merge
 * implementation of its own.
 *
 * Every finding gets its distinctness note whether or not a rewrite arrived:
 * the note is the enduring constraint the drafter and the reviewer both read
 * off the brief, and the rewrite is only this pass's best attempt at a fresh
 * assignment. "No rewrite arrived" covers three different histories — the model
 * answered for another page, the answer was dropped for colliding, or the
 * finding was past `MAX_BEAT_DEDUP_FINDINGS` and was never put to the model at
 * all — and none of them is a reason to withhold a line that costs nothing.
 * Model patches for pages nothing flagged are dropped — the findings are the
 * confirmation of what this pass may touch, and a model must not widen it.
 *
 * **This is also the only place that can answer a match detection refused to
 * write down, so the refused ones are settled here.** The sweep may not pin a
 * page to a beat that is about to be replaced, so a match naming a page that won
 * a rewrite slot was held back — on the reasoning that the collision cannot
 * survive the pass. It survives whenever the rewrite does not, and that is
 * decided here rather than there: this function is reached with the surviving
 * rewrites from `dedupePageBeats`, with none at all when the provider call threw
 * (Phase 02 then regenerates the chapter rather than treating the original map
 * as clean), and each refusal was recorded against the very
 * page whose rewrite the sweep deferred to. So a finding with no rewrite hands
 * its `suppressedMatches` back — quoting the beat that page has just been
 * confirmed to keep, which is what makes them true — and a finding *with* a
 * rewrite hands back nothing, because that rewrite was scored against those
 * pages before it was accepted.
 *
 * **A settled match does not merely fill a page's empty slot; it takes the note
 * off a weaker one.** Detection holds a refusal only where it outranked whatever
 * else that page matched, so a page carrying both a finding and a surviving
 * refusal is a page whose *strongest* collision is the refused one — and while
 * its own note stood, the pair that actually needed saying reached drafting
 * undescribed and the weaker one got the line. So the note is written from the
 * surviving refusal wherever there is one and from the page's own finding
 * otherwise. Still one note per page: the sweep reports each later page once,
 * against its strongest earlier match, and this is that same rule asked again
 * with the answer detection could not have — which of the flagged pages kept
 * their beats. **A page can therefore be left with neither a rewrite nor a note
 * only if it collided with nothing at all, and the note it does carry names the
 * strongest collision it still has.** A page whose own rewrite survived keeps
 * the note that rewrite was written under, for the reason a rewriting page hands
 * nothing back: the rewrite cleared everything standing, the retained originals
 * included. A page two refusals name takes the earliest refuser's — the rule the
 * rewrite slots are handed out on, and both of them outrank the note it would
 * otherwise have had.
 *
 * A rewrite is spread whole rather than field by field, which is what makes it
 * impossible to publish a new beat under the old page's handoff: the schema
 * requires all three, so a page either keeps its whole assignment or takes a
 * whole replacement.
 *
 * `requiredContinuity` is the fourth thing the drafter reads off the brief, and
 * a whole-assignment rewrite replaces it rather than adding to it.
 * `mergePageMapCriticPatch` appends — right for a critic note on a page that
 * keeps its assignment, and wrong for this — which left page 177's "Preserve
 * mapped detail the North Sea blockade" standing beside the distinctness note it
 * was given for escaping that very beat: a fresh purpose, a fresh beat, and a
 * continuity requirement naming the material the rewrite was paid to remove, all
 * in one brief.
 *
 * **Replacing it with the distinctness note alone was the same mistake from the
 * other side.** A page's continuity is not all beat-derived: the map routinely
 * writes character, prop, date and timeline constraints there that hold for the
 * whole chapter however the page is reassigned — the dry-run map's own line is
 * one ("Keep the night clerk and a brass key consistent after page 17") — and a
 * replacement composed here dropped every one of them on any page a rewrite
 * arrived for. So the rewrite carries the surviving lines: the model that is
 * writing the new assignment is the one thing that can say which of the old
 * entries it leaves standing, and it is asked for exactly that. The distinctness
 * note is appended to its answer by us rather than trusted to it, because the
 * note is what this pass guarantees. The flag still rides the rewrite, so a page
 * that got the note alone keeps the continuity written for the assignment it
 * still has.
 *
 * `imageMoment` rides the rewrite too and is written only where the rewrite
 * carries one. By the time a patch reaches here that is already the whole
 * question: `dedupePageBeats` has dropped the rewrites that owed a moment and
 * named none, and stripped the moments volunteered for pages the map left
 * unillustrated — so an absent field here means "this page's picture does not
 * move", which is the right answer both for a page that never had one and for a
 * page that got the distinctness note alone.
 */
export function beatDedupPatch(
  findings: DuplicateBeatFinding[],
  rewrites: BeatRewritePatch[] = []
): PageMapCriticPatch {
  const rewriteByPage = new Map(rewrites.map((patch) => [patch.pageIndex, patch]));
  return {
    beatPatches: notedPages(findings, rewriteByPage).map((finding) => {
      const rewrite = rewriteByPage.get(finding.pageIndex);
      return {
        pageIndex: finding.pageIndex,
        ...(rewrite
          ? {
              purpose: rewrite.purpose,
              beat: rewrite.beat,
              endingPressure: rewrite.endingPressure,
              ...(rewrite.imageMoment ? { imageMoment: rewrite.imageMoment } : {}),
              replaceRequiredContinuity: true
            }
          : {}),
        requiredContinuity: [...(rewrite?.requiredContinuity ?? []), distinctnessLine(finding)]
      };
    }),
    duplicatePurposeWarnings: [],
    missingEndingPressure: [],
    unscheduledPromises: []
  };
}

/**
 * Every page this patch writes a note for, and the collision each note names:
 * one entry per page, the findings in sweep order first and then the pages that
 * only a settled refusal names, in the order the refusals were recorded.
 *
 * A page carrying both takes the refusal, which is the whole of what changed
 * when detection stopped throwing refusals away — see `beatDedupPatch`'s
 * docstring. Composing them into one list rather than noting them separately is
 * the same "one path" argument the module runs on: a settled match is a finding
 * that arrived late, and there is one way of writing a finding's note.
 */
function notedPages(
  findings: DuplicateBeatFinding[],
  rewriteByPage: Map<number, BeatRewritePatch>
): DuplicateBeatFinding[] {
  const settled = settledRefusals(findings, rewriteByPage);
  const flagged = new Set(findings.map((finding) => finding.pageIndex));
  return [
    ...findings.map((finding) => settled.get(finding.pageIndex) ?? finding),
    ...[...settled.values()].filter((match) => !flagged.has(match.pageIndex))
  ];
}

/**
 * The matches detection held back, for the findings whose rewrite did not
 * arrive — keyed by the page the note belongs to.
 *
 * Three refusals are dropped here rather than written. A refusal held against a
 * page whose rewrite landed is a collision with an assignment this same patch is
 * removing, which is the rule the refusal exists for. A refusal naming a page
 * that got its own rewrite is dissolved from the other end, because that rewrite
 * had to clear everything standing — the refusing page's retained original
 * included — before `withoutCollidingRewrites` accepted it. And a page two
 * refusals name takes the first, which in findings order is the earliest page
 * that refused it; detection kept both only because both outranked whatever else
 * that page matched.
 */
function settledRefusals(
  findings: DuplicateBeatFinding[],
  rewriteByPage: Map<number, BeatRewritePatch>
): Map<number, DuplicateBeatFinding> {
  const settled = new Map<number, DuplicateBeatFinding>();
  for (const finding of findings) {
    if (rewriteByPage.has(finding.pageIndex)) {
      continue;
    }
    for (const match of finding.suppressedMatches ?? []) {
      if (rewriteByPage.has(match.pageIndex) || settled.has(match.pageIndex)) {
        continue;
      }
      settled.set(match.pageIndex, match);
    }
  }
  return settled;
}

/**
 * The findings that win one rewrite call's capped slots: the earliest ones, in
 * the order `findDuplicatePageBeats` produced them, which is page order.
 *
 * This is a bound on one provider call, never on detection. Full-map audit
 * returns every finding; the worker selects at most `MAX_BEAT_DEDUP_FINDINGS`
 * of them for a single `dedupePageBeats` call.
 */
export function selectFindingsForRewriteCall(
  findings: DuplicateBeatFinding[],
  limit = MAX_BEAT_DEDUP_FINDINGS
): DuplicateBeatFinding[] {
  return findings.slice(0, limit);
}

/**
 * One bounded model call that rewrites the flagged beats. Throws on provider
 * failure — Phase 02's integrity pass may then regenerate the chapter rather
 * than treat the original map as clean.
 *
 * Every finding is answered in the patch; only the first `MAX_BEAT_DEDUP_FINDINGS`
 * of them are put to the model. Callers that already selected a batch should pass
 * at most twelve; this slice is the last bound on the prompt.
 *
 * **Findings are this call's whole reason to exist, so an empty list is a broken
 * caller rather than a quiet no-op.**
 *
 * `lastPageIndex` is the same number the caller hands `mergePageMapCriticPatch`,
 * so both halves of this pass agree on where the book ends.
 */
export async function dedupePageBeats(options: {
  textModel: TextModelAdapter;
  briefs: ChapterBrief[];
  findings: DuplicateBeatFinding[];
  promises: string[];
  lastPageIndex: number;
  providerCallMetadata?: ProductionMapRepairProviderCallMetadata;
}): Promise<PageMapCriticPatch> {
  const rewriting = selectFindingsForRewriteCall(options.findings);
  if (rewriting.length === 0) {
    throw new Error("dedupePageBeats needs at least one finding; a clean sweep must not reach the rewrite call.");
  }
  const chapters = groupFlaggedPagesByChapter({
    briefs: options.briefs,
    findings: rewriting,
    lastPageIndex: options.lastPageIndex
  });
  const result = await generateJsonWithRetry(options.textModel, {
    purpose: "dedupe-page-beats",
    ...(options.providerCallMetadata ? { providerCallMetadata: options.providerCallMetadata } : {}),
    temperature: 0,
    // Room for `MAX_BEAT_DEDUP_FINDINGS` full patches, and a full patch is five
    // fields now that the continuity a rewrite keeps is quoted back with it and
    // the page's visual moment is rewritten beside its beat. A cap the response
    // cannot fit truncates the JSON of exactly the map that needed the pass
    // most, and then spends the whole retry budget re-truncating it.
    maxTokens: 4800,
    schema: beatRewritePatchSchema,
    messages: [
      {
        role: "system",
        content: [
          "You repair a book's page map.",
          "Deterministic checks found pages whose assigned beats near-duplicate an earlier page's beat.",
          "The flagged pages are grouped under the chapter they belong to; every page in a group is written against that group's chapterTitle and chapterSummary.",
          "For each flagged page, rewrite its purpose and beat to a fresh, specific angle that advances its chapter and does not restate the earlier page's beat.",
          // `promises` has ridden in the payload beside the chapters since this
          // call borrowed the key from `critiquePageMap`, whose own prompt
          // names them — and this one said nothing about it, so a book with a
          // long promise list spent prompt budget on unlabelled JSON inside the
          // one call whose response cap this module worries about. Naming it
          // beats dropping it: the flagged page is being reassigned whatever
          // happens, and the plan's promises are the one pool of book-level
          // material a fresh angle can take up without inventing anything.
          // Keeping the key also leaves the payload shape exactly as the
          // hand-written reader below walks it.
          "The payload's promises are the payoffs the plan committed this book to: prefer a fresh angle that advances one of them where it fits the page's chapter, and never write one that contradicts them.",
          "The rewrites must also be distinct from one another, not only from the earlier beats they were flagged against: several flagged pages often name the same earlier page, and two rewrites landing on one fresh angle is the same collision again.",
          "Write in the same language as the beats you are given, keep each page's role in its chapter's sequence, and do not contradict the adjacent beats.",
          `A page marked isLastPageOfBook ends the book, so its endingPressure must close it: ${LAST_PAGE_ENDING_PRESSURE}`,
          "Every other page's endingPressure hands a concrete consequence to the page after it.",
          "Return purpose, beat and endingPressure together for every flagged page: a new beat left under the old handoff promises the next page the consequence of something that no longer happens.",
          "Each flagged page arrives with its current requiredContinuity: return the entries that still hold for the assignment you are writing and leave out the ones that only mattered to the beat you replaced — a character, a prop, a date or a fact the rest of the chapter depends on stays true however the page is reassigned.",
          "Return requiredContinuity for every flagged page whose payload carries entries, empty if none of them survive, and invent nothing for it: the note telling the page to stay distinct from its duplicate is added for you.",
          "A flagged page arriving with an imageMoment is illustrated from that one visual moment, which was written for the beat you are replacing: return a fresh imageMoment drawn from the assignment you are writing, a single readable scene and not a summary of the page.",
          "Return no imageMoment for a flagged page whose payload carries none — that page is not illustrated and must not become illustrated here.",
          "Return a patch for every flagged page and for no other page."
        ].join(" ")
      },
      {
        // This shape has a reader outside the type system: the
        // `dedupe-page-beats` branch of `packages/core/src/adapters/fake.ts`
        // walks `chapters[].flaggedPages[]` by hand — `pageIndex` to answer with
        // one patch per flagged page, `requiredContinuity` and `imageMoment` to
        // answer the two per-page questions this prompt asks. Nothing links the
        // two ends — no shared type, no compiler error, no test across the seam.
        // Re-nested or renamed here alone, that branch falls back to
        // `beatPatches: []`: a dry run answering a request that named specific
        // pages with a rewrite for none of them, which is the exact failure it
        // was written to fix. A renamed *field* is quieter still and just as
        // wrong — the fake answers with no moment, every rewrite for an
        // illustrated page is refused, and the pass silently degrades to notes.
        // They move together.
        role: "user",
        content: JSON.stringify({ promises: options.promises, chapters }, null, 2)
      }
    ]
  });
  // Already `beatRewritePatchSchema`'s output: `generateJsonWithRetry` hands the
  // adapter the schema, which is what parses — and what its retry loop
  // re-prompts on when the parse fails.
  const parsed = result.data;
  const flaggedIndexes = new Set(rewriting.map((finding) => finding.pageIndex));
  const pages = options.briefs.flatMap((brief) => brief.pages);
  // Every page no rewrite was asked for, fingerprinted here rather than carried
  // over from detection: a finding names two pages, and what a rewrite has to
  // stay clear of is the whole rest of the map. A finding past the cap belongs
  // in here rather than beside the flagged pages: nothing is going to move that
  // page, so a fresh angle landing on its beat is the same collision arriving
  // from the pass that exists to remove it.
  //
  // Handed over unevaluated, because this is the whole cost of a guard that
  // routinely has nothing to guard — `withoutCollidingRewrites` states the rule
  // and is the only thing that calls it.
  const unflagged = (): BeatFingerprint[] =>
    pages.filter((page) => !flaggedIndexes.has(page.pageIndex)).map(fingerprint);
  // The flagged pages as the map still holds them. Every one of these is a page
  // that keeps exactly this assignment unless a rewrite for it survives, which
  // is what makes it both the standing beat `withoutCollidingRewrites` may have
  // to score against and the continuity a rewrite has to answer for.
  const flaggedPages = new Map(
    pages.filter((page) => flaggedIndexes.has(page.pageIndex)).map((page) => [page.pageIndex, page])
  );
  const rewrites = parsed.beatPatches
    .filter((patch) => {
      const page = flaggedPages.get(patch.pageIndex);
      return (
        flaggedIndexes.has(patch.pageIndex) &&
        answersForMappedContinuity(patch, page) &&
        answersForMappedImageMoment(patch, page)
      );
    })
    .map((patch) => withoutUnmappedImageMoment(patch, flaggedPages.get(patch.pageIndex)));
  return beatDedupPatch(
    options.findings,
    withoutCollidingRewrites(rewrites, unflagged, flaggedPages).map((patch) =>
      withContractedEnding(patch, options.lastPageIndex)
    )
  );
}

/**
 * A rewrite replaces the whole assignment, so it has to say what becomes of the
 * assignment's fourth field — but only where there is something to say. A page
 * the map wrote no continuity for has nothing to sort out and its silence is the
 * honest answer; a page carrying entries and answered for with no
 * `requiredContinuity` key at all has left this pass with the choice the
 * `beatDedupPatch` docstring is about, which is a stale line pointed at material
 * the rewrite was paid to leave or a book-level constraint dropped for a beat
 * change. Neither is ours to make on a guess, so the rewrite is dropped and the
 * page keeps everything it came in with — the same penalty a colliding rewrite
 * pays, and the same outcome the whole call degrades to.
 */
function answersForMappedContinuity(patch: BeatRewritePatch, page: PageProductionBeat | undefined): boolean {
  return patch.requiredContinuity !== undefined || (page?.requiredContinuity.length ?? 0) === 0;
}

/**
 * The same question about the assignment's fifth field, and only the half of it
 * that costs the page something to get wrong.
 *
 * A page carrying an `imageMoment` is illustrated from it, so a rewrite silent
 * about it is the `mergePageMapCriticPatch` spread publishing a fresh purpose,
 * beat and handoff under a picture of the beat that is gone — the reader shown a
 * scene the page no longer contains. Nothing downstream can notice: the field is
 * carried forward verbatim by `pagesPageMap.ts` and read by both the drafting
 * prompt and the illustration prompt, neither of which knows what the page used
 * to be assigned. So the rewrite pays a colliding rewrite's penalty and the page
 * keeps its whole assignment, picture included.
 *
 * The other direction is not a refusal. A moment volunteered for a page the map
 * left unillustrated is a field this pass may simply not carry — the answer is
 * knowable without guessing, unlike the continuity question, and dropping the
 * whole rewrite over it would cost that page its fresh beat to punish a model
 * for over-answering. `withoutUnmappedImageMoment` takes the field off instead.
 */
function answersForMappedImageMoment(patch: BeatRewritePatch, page: PageProductionBeat | undefined): boolean {
  return patch.imageMoment !== undefined || mappedImageMoment(page) === undefined;
}

/**
 * Strips a visual moment written for a page the map gave none — see above. The
 * key is destructured off rather than spread back as `undefined`, because those
 * are two different objects to anything that presence-tests: `{ imageMoment:
 * undefined }` still answers true to `"imageMoment" in patch`, which is how the
 * sibling `answersForMappedImageMoment` asks the question one line up the same
 * pipeline. `beatDedupPatch` truth-tests and so cannot see the difference today,
 * which is exactly the kind of accident the repo's `exactOptionalPropertyTypes`
 * rule is for: an optional property means "may be absent", never "may be
 * `undefined`".
 */
function withoutUnmappedImageMoment(patch: BeatRewritePatch, page: PageProductionBeat | undefined): BeatRewritePatch {
  if (patch.imageMoment === undefined || mappedImageMoment(page) !== undefined) {
    return patch;
  }
  const { imageMoment: _unmapped, ...withoutMoment } = patch;
  return withoutMoment;
}

/**
 * What the map actually assigned this page as its visual moment. The field is
 * optional on `PageProductionBeat` *and* reaches it through a normalizer that
 * takes whatever string the model put under `imageMoment`, `visualMoment` or
 * `imagePrompt` (`schemas/book.ts`), so an empty one is a page with no picture
 * rather than a page with a blank one — and treating it as a picture would ask
 * every rewrite for a moment that replaces nothing.
 */
function mappedImageMoment(page: PageProductionBeat | undefined): string | undefined {
  const moment = page?.imageMoment?.trim();
  return moment ? moment : undefined;
}

/** One flagged page as the rewrite prompt reads it, minus its chapter context. */
type FlaggedPagePayload = {
  pageIndex: number;
  purpose: string;
  beat: string;
  endingPressure: string;
  /** What the map requires of this page today, for the model to sort out. */
  requiredContinuity: string[];
  /**
   * The visual moment the page is illustrated from, present only when the map
   * wrote one. Absent is the payload saying "this page has no picture", which is
   * what the prompt's second imageMoment sentence and
   * `answersForMappedImageMoment` both read it as — an empty string here would
   * ask for a replacement for a picture that does not exist.
   */
  imageMoment?: string;
  isLastPageOfBook: boolean;
  duplicateOf: { pageIndex: number; purpose: string; beat: string };
  adjacentBeats: { pageIndex: number; beat: string }[];
};

/**
 * One chapter's context and every page flagged inside it. `chapterIndex` is
 * null for a finding naming a page the map does not hold.
 */
type FlaggedChapterPayload = {
  chapterIndex: number | null;
  chapterTitle: string;
  chapterSummary: string;
  flaggedPages: FlaggedPagePayload[];
};

/**
 * A chapter's title and summary are emitted once, with its flagged pages under
 * it, rather than repeated inside every entry. `MAX_BEAT_DEDUP_FINDINGS`
 * collisions in one chapter used to send that chapter's summary twelve times —
 * in the prompt of exactly the map dense enough to trip the cap, and against a
 * response budget sized for a full patch per finding.
 *
 * Groups keep the order their first finding arrived in, which is page order,
 * so the payload is as deterministic as the sweep that produced it. A finding
 * naming a page the map does not hold groups under its own empty chapter
 * rather than borrowing someone else's context.
 */
function groupFlaggedPagesByChapter(options: {
  briefs: ChapterBrief[];
  findings: DuplicateBeatFinding[];
  lastPageIndex: number;
}): FlaggedChapterPayload[] {
  const pagesByIndex = new Map(options.briefs.flatMap((brief) => brief.pages).map((page) => [page.pageIndex, page]));
  const briefByChapter = new Map(options.briefs.map((brief) => [brief.chapterIndex, brief]));
  const groups = new Map<number | null, FlaggedChapterPayload>();
  for (const finding of options.findings) {
    const page = pagesByIndex.get(finding.pageIndex);
    const earlier = pagesByIndex.get(finding.duplicateOfPageIndex);
    const chapterIndex = page?.chapterIndex ?? null;
    const chapter = chapterIndex === null ? undefined : briefByChapter.get(chapterIndex);
    let group = groups.get(chapterIndex);
    if (!group) {
      group = {
        chapterIndex,
        chapterTitle: chapter?.title ?? "",
        chapterSummary: chapter?.summary ?? "",
        flaggedPages: []
      };
      groups.set(chapterIndex, group);
    }
    const neighbors = (chapter?.pages ?? []).filter(
      (candidate) => Math.abs(candidate.pageIndex - finding.pageIndex) === 1
    );
    const imageMoment = mappedImageMoment(page);
    group.flaggedPages.push({
      pageIndex: finding.pageIndex,
      purpose: page?.purpose ?? "",
      beat: page?.beat ?? "",
      endingPressure: page?.endingPressure ?? "",
      requiredContinuity: page?.requiredContinuity ?? [],
      ...(imageMoment ? { imageMoment } : {}),
      isLastPageOfBook: finding.pageIndex === options.lastPageIndex,
      duplicateOf: {
        pageIndex: finding.duplicateOfPageIndex,
        purpose: earlier?.purpose ?? "",
        beat: earlier?.beat ?? ""
      },
      adjacentBeats: neighbors.map((candidate) => ({ pageIndex: candidate.pageIndex, beat: candidate.beat }))
    });
  }
  return [...groups.values()];
}

/**
 * The batch's own duplicate check, measured with the same `scorePair` that
 * flagged the pages in the first place — no second model call, which is the
 * spend this whole pass exists to avoid.
 *
 * The prompt asks for rewrites distinct from one another; this is what makes it
 * true. A run of near-copies produces findings that all name the same earlier
 * page (page 1 is the only page always safe to name), so every flagged page is
 * handed the identical instruction and the identical distinctness note, and one
 * call can swap N collisions for a fresh one that nothing measures again.
 *
 * Every rewrite is scored against **the book it is joining**, because a fresh
 * angle is only fresh with respect to that book: the model is shown one earlier
 * page and two neighbours, so the other 197 pages are the ones it can collide
 * with unknowingly, and nothing measures the map again after this. That book is
 * one growing set rather than two lists, and the rule is a page's *standing*
 * assignment, not its flag:
 *
 * - every `unflagged` page, which no answer can move;
 * - the original beat of every flagged page the model returned nothing for,
 *   which is a page keeping exactly the beat detection flagged — `flaggedIndexes`
 *   excluded it on the assumption it was being reassigned, and it is not;
 * - each rewrite already accepted;
 * - and the original beat of each rewrite already **dropped**, added the moment
 *   it is dropped, because that page is retained from then on and the rest of
 *   the batch has to clear it too.
 *
 * The last two are why this is one pass: retained is a fact about the decisions,
 * so a set computed before them cannot hold it. A rewrite is never scored
 * against its own page's original — that entry only exists once the rewrite is
 * gone.
 *
 * **"The rest of the batch" was one-directional, and that is the second half of
 * the rule.** A retained original reached only the rewrites *after* it, because
 * the loop that adds it is the loop that reads it; a rewrite already accepted
 * was never asked again. Rewrites come back for pages 5 and 20, page 5's is
 * accepted, page 20's is then dropped for colliding with something standing —
 * and if page 5's fresh angle is page 20's original, the map ships the very
 * near-duplicate this pass exists to remove, on a pair nothing measures again,
 * put there by the pass itself. So the loop is followed by a **settle**: each
 * original a drop handed back is scored against the rewrites still kept, and one
 * that collides is dropped in turn, which hands *its* original back and queues
 * it too. Dropping is sticky — a rewrite dropped is never reconsidered because
 * the answer it collided with later went away — which is what makes this
 * terminate rather than oscillate: the retained set only grows, the kept set
 * only shrinks, and both are bounded by the batch.
 *
 * **What the settle costs is bounded by the batch and not by the book**, which
 * is why it stays synchronous while the sweep that feeds it does not. Its queue
 * takes one entry per page ever dropped, each entry costs one pass over the
 * rewrites still kept, and every entry it adds is a page leaving that set — so
 * the count is under `MAX_BEAT_DEDUP_FINDINGS`² and peaks well below it, at
 * **66** scored pairs for a batch of twelve whose first drop cascades through
 * all eleven others. Measured at 1.4 us a pair on this box: 0.09 ms, against the
 * forward pass's own `rewrites × standing` — ~7.2k pairs and ~10 ms at the
 * 600-page ceiling — and against `BEAT_SWEEP_PAIRS_PER_SLICE`, whose 2000 pairs
 * the settle cannot fill even on the map that saturates the cap. It fingerprints
 * nothing the forward pass did not: a page's original is tokenized once, at the
 * moment it is handed back, which is where the loop already tokenized it.
 *
 * **The set is built only once there is something to hold apart, which is why
 * the unflagged half arrives unevaluated.** Fingerprinting tokenizes, so that
 * half is one pass over every other page in the book, synchronously, on the
 * worker's event loop — and when no rewrite survives the filtering above,
 * nothing reads a single entry of it. That is not the rare path: a model that
 * refuses answers `beatPatches: []`, and a batch whose every patch failed
 * `answersForMappedContinuity` or `answersForMappedImageMoment` arrives here
 * empty the same way — so a 600-page map tripping three collisions ran 597 beats
 * through `overlapTokens` and then scored nothing against them. The empty guard
 * therefore sits in front of the thunk, and the call that does have a rewrite
 * pays exactly what it paid before: one pass, once, at the moment the set is
 * first needed. Nothing else moves — an empty result composes
 * `beatDedupPatch(findings, [])` as it always did, so every finding still gets
 * its distinctness note and every match detection refused to write down is still
 * revived from there.
 *
 * The **lowest page index survives**, for the reason the sweep rewrites the
 * later page of a pair: the earlier page is the one the rest of the book is
 * written after, so a later page giving way costs the book less. A dropped page
 * — whichever side dropped it — keeps its original assignment and still gets
 * the distinctness note `beatDedupPatch` writes whether or not a rewrite
 * arrived, which is the honest outcome: the note is what this pass guarantees
 * and a fresh beat is only what it attempts, so refusing one leaves the page
 * where the call found it rather than one collision worse.
 */
function withoutCollidingRewrites(
  rewrites: BeatRewritePatch[],
  unflagged: () => BeatFingerprint[],
  flaggedPages: Map<number, BeatAssignment>
): BeatRewritePatch[] {
  if (rewrites.length === 0) {
    return [];
  }
  const answered = new Set(rewrites.map((patch) => patch.pageIndex));
  const standing = [
    ...unflagged(),
    ...[...flaggedPages]
      .filter(([pageIndex]) => !answered.has(pageIndex))
      .map(([, assignment]) => fingerprint(assignment))
  ];
  /**
   * Originals a drop has just put back into the map, in drop order — the
   * settle's queue. Appended to while it is being walked, which is how a drop
   * the settle itself makes gets put to the rewrites still kept. `retain` goes
   * on writing the original into `standing` too, which the settle no longer
   * reads: one function answers "this page is back on its own beat" for both
   * phases, and a `standing` that stopped being the whole of what the map holds
   * would be the next reader's trap.
   */
  const retained: BeatFingerprint[] = [];
  const retain = (pageIndex: number): void => {
    const original = flaggedPages.get(pageIndex);
    if (!original) {
      return;
    }
    const print = fingerprint(original);
    standing.push(print);
    retained.push(print);
  };
  let kept: { patch: BeatRewritePatch; print: BeatFingerprint }[] = [];
  for (const patch of [...rewrites].sort((first, second) => first.pageIndex - second.pageIndex)) {
    const print = fingerprint(patch);
    if (standing.some((other) => rewritesCollide(print, other))) {
      retain(patch.pageIndex);
      continue;
    }
    kept.push({ patch, print });
    standing.push(print);
  }
  // The settle. Each entry costs one pass over what is still kept, and every
  // entry it adds is a page leaving `kept` for good — so this walks at most one
  // queue entry per rewrite and terminates whatever the batch looks like.
  for (let settling = 0; settling < retained.length; settling += 1) {
    const original = retained[settling]!;
    const survivors: typeof kept = [];
    for (const entry of kept) {
      if (rewritesCollide(entry.print, original)) {
        retain(entry.patch.pageIndex);
        continue;
      }
      survivors.push(entry);
    }
    kept = survivors;
  }
  return kept.map((entry) => entry.patch);
}

/**
 * `scorePair` with a floor under it. Both of its bars are measured over a
 * minimum-length text, and a model answering `MAX_BEAT_DEDUP_FINDINGS` patches
 * against this call's response cap answers under that minimum — at which point
 * `scorePair` is `undefined` for every pair, twelve verbatim copies included,
 * and the guard that exists to catch exactly that waves them all through. Below
 * the floors the texts are therefore compared outright, folded for case,
 * punctuation and spacing so "Name the cost." and "Name the cost" are the one
 * angle they plainly are. This is the rewrites' rule only: detection over the
 * original map is where the floors buy the thresholds their meaning.
 */
function rewritesCollide(candidate: BeatFingerprint, other: BeatFingerprint): boolean {
  return scorePair(candidate, other) !== undefined || candidate.normalized === other.normalized;
}

/**
 * The prompt asks for the ending contract; this makes it true. `endingPressure`
 * is the one patched field with a rule stated nowhere in this module's own
 * output, and the book's last page is the likeliest page to be patched here —
 * it is the later half of every pair it belongs to. A last page told to carry
 * a consequence forward is a book asked to end on a page turn, which is the
 * failure `pageMapCritic.ts`'s substitution exists to prevent, so the same
 * sentence wins here too. Page 1 never reaches this — `findDuplicatePageBeats`
 * drops it — so only the ending contract has to be enforced.
 */
function withContractedEnding(patch: BeatRewritePatch, lastPageIndex: number): BeatRewritePatch {
  if (pageEndingContract(patch.pageIndex, lastPageIndex) !== "ending") {
    return patch;
  }
  return { ...patch, endingPressure: LAST_PAGE_ENDING_PRESSURE };
}
