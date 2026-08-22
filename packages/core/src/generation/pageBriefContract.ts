import { openingContractForRange, type OpeningContractSource, type OpeningHookPayload } from "./pagesShared.js";

/**
 * The vocabulary of the page-brief contract: the two ending pressures, the
 * ranking that decides which one a page's brief is written under, and the rule
 * lines a brief producer states to a model. It owns the sentences and the
 * ranking. It briefs nothing itself and makes no model call.
 *
 * It sits beside `pagesPageMap.ts` rather than inside it because the import
 * graph reads the wrong way round otherwise. Five producers state this
 * contract and only three of them live in that file: `critiquePageMap` and
 * `mergePageMapCriticPatch` (`pageMapCritic.ts`) run *after* the map is
 * finished and get the last word over it, so a vocabulary kept in the map
 * module made the later pass import the whole map generator — three model
 * calls, their schemas, their fallbacks and the chunking threshold — to reach
 * four sentences. Both the map and its critic now import this, and neither
 * imports the other.
 *
 * The file-size budget is the same reason wearing different clothes. This block
 * was the last thing `pagesPageMap.ts` had room for under the 900-line ceiling,
 * and the change after it would have had to buy its space out of the docstrings
 * below — which is exactly how a contract that lives in prose starts drifting
 * from the one the code states.
 */

/**
 * Three different paths brief page 1 and a book gets exactly one of them: the
 * whole-book map, the per-chapter briefs `generateChunkedPageMap` fans out, and
 * the deterministic `fallbackPageBeatFromChapter` at the bottom of
 * `pagesPageMap.ts`. So the first-page contract is stated in all three. Stated
 * only in the fallback it reached almost no real book — that runs solely when a
 * short book's model call comes back as unparseable JSON, and every book over
 * `CHUNKED_PAGE_MAP_THRESHOLD` pages is briefed a chapter at a time with no
 * fallback behind it at all. `repairPageBrief` is the fourth, and the only one
 * that is not an alternative to the others: it rewrites whichever brief they
 * wrote, so a page-1 brief that fails QA loses the contract entirely unless the
 * repair restates it — on the one page the contract exists for, and only after
 * the reader's opening has already been judged bad once.
 *
 * The fifth is `critiquePageMap` / `mergePageMapCriticPatch` in
 * `pageMapCritic.ts`, and it gets the *last* word: `prepareChapterSetups` runs
 * it over the finished map before a single page is drafted, so a `beatPatch`
 * for page 1 replaces the very purpose, beat and endingPressure these rules
 * were stated to constrain — and its `missingEndingPressure` substitution is
 * our own deterministic sentence, not a model's. A contract restated a fifth
 * time in prose is a contract that drifts, so all five state it from the
 * constants in this module — and reach the rule text only through
 * {@link firstPageBriefFieldsForRange}, this module's one entry point, which is
 * why those rules are module-private where the two pressures are not.
 */
export const FIRST_PAGE_ENDING_PRESSURE =
  "End the first page with a specific tension or open question the second page must answer.";

/** Its opposite, and the sentence every producer lands the book's last page on. */
export const LAST_PAGE_ENDING_PRESSURE =
  "Resolve the book's central promise with a concrete final consequence.";

export type PageEndingContract = "opening" | "ending" | "handoff";

/**
 * Which of the two contracts a page's ending pressure is written under, and the
 * one place they are ranked. `targetPages` may be 1 — the mobile schema's
 * `minimum` — so page 1 is routinely the book's last page as well, and the two
 * say opposite things about the same field. The ending is tested first and wins
 * outright: a page told to leave an open question for the second page of a
 * one-page book is briefed against a page that does not exist. Every producer
 * asks this and none decides it itself — the deterministic pair
 * (`fallbackPageBeatFromChapter`, the substitution in `pageMapCritic.ts`) to
 * pick the sentence it writes, the three prompt-side producers to pick the rule
 * they state. Resolved in the deterministic pair alone, it briefed the same
 * one-page book to open or to close depending on which path wrote page 1.
 */
export function pageEndingContract(pageIndex: number, lastPageIndex: number): PageEndingContract {
  return pageIndex === lastPageIndex ? "ending" : pageIndex === 1 ? "opening" : "handoff";
}

const FIRST_PAGE_IDENTITY_RULE =
  "Global page 1 is the book's first page and the reader's first impression: its purpose and beat must open inside the concrete subject with a specific tension, question, image, or claim, never throat-clearing, a welcome, a definition of the topic, or meta framing such as 'In this book'.";

const FIRST_PAGE_NEXT_PAGE_RULE =
  "Global page 1's endingPressure must leave a specific tension or open question the second page has to answer.";

/**
 * The `"ending"` reading of that second rule, quoting
 * {@link LAST_PAGE_ENDING_PRESSURE} rather than restating it: a one-page book is
 * asked to land the same thing whether a prompt or the fallback briefed it.
 */
const SOLE_PAGE_ENDING_RULE = `Global page 1 is also this book's last page, so no second page exists to answer anything and its endingPressure must close the book instead: ${LAST_PAGE_ENDING_PRESSURE}`;

/**
 * The plan's own commitment to how the book opens. It travels as its own
 * payload field rather than pre-pasted into the beat, because a brief is a
 * production assignment the writer reads next: the hook has to survive as an
 * instruction, and `buildPageInstruction` already forbids the draft echoing
 * its wording.
 */
const OPENING_HOOK_BRIEF_RULE =
  "openingHook is the plan's commitment to how this book opens; global page 1's purpose and beat must assign it, phrased as a production instruction rather than copied as prose.";

export type FirstPageBriefFields = {
  /** The contract lines; empty on every call that does not brief page 1. */
  rules: string[];
  /** The `openingHook` key those lines name, spread into the same prompt's payload. */
  payload: OpeningHookPayload;
};

/**
 * The book a brief producer writes inside: the plan it briefs from, the `input`
 * whose `targetPages` is the book's last page, and — since the hook half of the
 * contract is gated on provenance — the same `input` that says whether this
 * book's opening is the pipeline's to commit. Every producer's options already
 * satisfy it, and each passes itself straight through, the way
 * `PageInstructionSource` (`pagesShared.ts`) takes one — handing over the book
 * rather than a second range is what keeps {@link pageEndingContract} out of
 * four call sites that would then have to agree about it.
 *
 * It is `OpeningContractSource` **by definition rather than by coincidence**:
 * the brief side reads its hook off the same `openingContractForRange` the page
 * prompts do, so a scope that satisfied one and not the other would be a book
 * the gate could not be asked about. Aliasing is what makes that a compiler
 * check rather than a sentence in a comment.
 */
export type PageBriefBookScope = OpeningContractSource;

/**
 * The first-page contract as a *brief* producer states it — the rules **and**
 * the `openingHook` key one of them names, from one call.
 *
 * The page-map layer's twin of `buildPageInstruction` (`pagesShared.ts`), and
 * for the same reason: `OPENING_HOOK_BRIEF_RULE` tells the model to assign a
 * payload field, so a prompt carrying that sentence has to send the field too or
 * the brief assigns a hook nobody was shown. All four producers used to spell
 * the range test, the rule and the key for themselves, and one shipped a round
 * with the sentence and no key — as all three prompt-side ones later shipped the
 * next-page rule to a book with no next page. Returning every half together is
 * what makes a fifth producer unable to get it partly right.
 *
 * The two audiences keep their own sentence on purpose. This one *assigns* the
 * hook in page 1's production notes; `openingContractFields` (`pagesShared.ts`)
 * tells the writer to *deliver* it in page 1's prose. What they share is the
 * gate under both: {@link openingContractForRange}.
 *
 * **The contract's two halves are gated differently here, and only here.** The
 * hook half goes through that gate exactly as every prompt in the pipeline does.
 * A fresh import has no `openingHook` at all — `synthesizeImportedBookPlan`
 * (`ingestion/manuscriptImport.ts`) sets none — and one appears only once that
 * plan is revised, so an import's hook is a sentence a model invented from a
 * premise field having never read page 1. Assigning it in page 1's *brief* is
 * commissioning a rewrite of the author's own first sentence, and it arrives at
 * a writer prompt that is gated too and therefore carries no `openingHook` key:
 * the page is told to deliver a hook nothing ever shows it. Ungated, that was
 * the one remaining door — an imported book replanned once, then redrafted by
 * `GENERATE_BOOK`.
 *
 * The opening *ban* it states beside that (`FIRST_PAGE_IDENTITY_RULE`) stays
 * ungated, and that is the one deliberate asymmetry left here.
 * `isImportedManuscript` protects an author's own text from being rejected and
 * rewritten, and a brief is a production assignment for prose about to be
 * generated — a repair's replacement page included — so the ban over-applies to
 * an import's page 1 without ever reaching a sentence the author wrote. The two
 * halves part company because they cost different things when they over-apply:
 * the ban costs a regenerated page some freedom it was never going to use, and
 * the hook costs the author their opening. Every other statement of the ban goes
 * through `openingContractFields`, which applies the exemption; if a brief ever
 * needs it too, read `statesOpeningQuality` off the contract this function
 * already builds rather than adding a second predicate.
 */
export function firstPageBriefFieldsForRange(
  scope: PageBriefBookScope,
  pageStart: number,
  pageEnd: number
): FirstPageBriefFields {
  // One call answers both questions — does this producer brief global page 1,
  // and may it assign this book's own opening — because asking them separately
  // is what left the brief side taking `plan.openingHook` raw after every prompt
  // in the pipeline had been routed through the exemption.
  const contract = openingContractForRange(scope, pageStart, pageEnd);
  if (!contract.writesFirstPage) {
    return { rules: [], payload: {} };
  }
  return firstPageBriefFields(contract.openingHook, scope.input.targetPages);
}

/**
 * The sentences themselves, once both of the questions above are answered.
 *
 * **Module-private, because those answers may not come from outside.** A
 * producer handed a bare `openingHook` is a producer whose provenance gate lives
 * at its call site, which is precisely how the hook half went on reaching
 * imported manuscripts after the prompts were gated. `critiquePageMap`
 * (`pageMapCritic.ts`) was that producer — it took `plan.openingHook` and
 * `input.targetPages` as two loose values from the worker — and it now takes the
 * book, like the other four.
 *
 * `lastPageIndex` is the book's own last page (`input.targetPages`), never the
 * highest index in the map being briefed: a map that came back short is the
 * failure the brief repair loop exists for, and its highest page is then a
 * middle page that would be told to resolve the book's central promise.
 */
function firstPageBriefFields(openingHook: string | undefined, lastPageIndex: number): FirstPageBriefFields {
  return {
    rules: [
      FIRST_PAGE_IDENTITY_RULE,
      pageEndingContract(1, lastPageIndex) === "ending" ? SOLE_PAGE_ENDING_RULE : FIRST_PAGE_NEXT_PAGE_RULE,
      ...(openingHook ? [OPENING_HOOK_BRIEF_RULE] : [])
    ],
    payload: openingHook ? { openingHook } : {}
  };
}
