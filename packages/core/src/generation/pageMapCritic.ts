import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import type { ChapterBrief } from "../schemas/book.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import {
  FIRST_PAGE_ENDING_PRESSURE,
  LAST_PAGE_ENDING_PRESSURE,
  firstPageBriefFieldsForRange,
  pageEndingContract,
  type PageBriefBookScope
} from "./pageBriefContract.js";

/**
 * The last pass over the page map before anything is drafted, which makes it
 * the last writer of page 1's brief. `prepareChapterSetups`
 * (apps/worker/src/generation/bookState.ts) runs it immediately after the map
 * is generated, so whatever the four producers in `pagesPageMap.ts` wrote under
 * the first-page contract, a `beatPatch` for pageIndex 1 or an entry in
 * `missingEndingPressure` replaces it here. Both halves therefore state the
 * contract: the prompt, so a patch is written in compliance, and the
 * substitution below, which is our own sentence rather than a model's. Both
 * take it from `pageBriefContract.ts`, which is a module rather than a block
 * inside the map so that this pass can say what the map said without importing
 * the map.
 *
 * Neither half infers how long the book is. This pass is handed a map, and a map
 * that came back short of `targetPages` is the very failure the brief repair
 * loop exists for — so the book's last page arrives from the caller, which holds
 * `input.targetPages`. Read off the briefs in hand instead, a truncated map
 * makes its highest page the book's ending: a middle page told to resolve the
 * central promise, and a map that only reached page 1 briefed as a one-page
 * book.
 *
 * The critic half takes that `input` itself, beside the `plan`, rather than the
 * two values it needs off them. Page 1's contract asks three questions and only
 * two of them are answerable from a number: the third is whether this book's
 * opening is the pipeline's to commit at all, which lives in the *project's*
 * provenance (`isImportedManuscript`, `schemas/mediaSettings.ts`). Handed
 * `plan.openingHook` as a string, this pass could not ask it — so the gate lived
 * in the worker, one call site away from the rule it gates, which is how an
 * imported manuscript's page 1 went on being briefed to deliver a hook a later
 * plan revision invented for it. The merge below still takes a plain
 * `lastPageIndex`, because it states no rule and asks nothing about the opening.
 */

const pageMapCriticBeatPatchSchema = z.object({
  pageIndex: z.number().int().positive(),
  purpose: z.string().min(1).optional(),
  beat: z.string().min(1).optional(),
  endingPressure: z.string().min(1).optional(),
  requiredContinuity: z.array(z.string().min(1)).optional(),
  note: z.string().min(1).optional()
});

export const pageMapCriticPatchSchema = z.object({
  beatPatches: z.array(pageMapCriticBeatPatchSchema).default([]),
  duplicatePurposeWarnings: z.array(z.string().min(1)).default([]),
  missingEndingPressure: z.array(z.number().int().positive()).default([]),
  unscheduledPromises: z.array(z.string().min(1)).default([])
});

/**
 * A beat patch as the *merge* takes it, which is one field wider than the shape
 * a model may answer with.
 *
 * `requiredContinuity` is appended, because a critic patch is a note about a
 * page that keeps the assignment those entries were written for. A beat dedup
 * rewrite (`pageBeatDedup.ts`) is the other thing entirely — purpose, beat and
 * endingPressure replaced together — and the appended default then leaves the
 * old assignment's continuity standing beside the new one: page 177 of the
 * 2026-08-22 reference book was reassigned off its blockade beat and told in
 * the same brief to "Preserve mapped detail the North Sea blockade", which is
 * the drafter pointed straight back at the material the rewrite was paid to
 * leave. `replaceRequiredContinuity` is the opt-in for that case and no other,
 * so a page that only received a distinctness note keeps everything it had.
 *
 * **This flag says which array wins, never which lines are worth keeping.** The
 * entries a page carries are not all written for its beat — a character, a prop
 * or a date the whole chapter depends on lives in the same array — so a
 * replacement composed out of nothing but the new note dropped those too, on
 * every page a rewrite reached. Sorting that out is the *composer's* problem and
 * `pageBeatDedup.ts` gives it to the model writing the new assignment, which is
 * the only reader that can tell the two kinds apart; what arrives here is
 * already the array the page is meant to end up with.
 *
 * It is deliberately absent from `pageMapCriticPatchSchema`. That schema is
 * what a model's answer is parsed against and zod strips what it does not name,
 * so no critic can ask for a page's continuity to be dropped; only our own code
 * composing a patch can set it. A flag arriving with nothing to put in the
 * field's place leaves the page's entries alone — a patch that named no
 * continuity forgot the field rather than cleared it.
 *
 * `imageMoment` is the fifth field of an assignment and the last one a
 * whole-assignment rewrite had no way to move. A page's visual moment is what
 * `pageMapForWholeBookDraft` carries into the drafting prompt and what
 * `pages.ts` hands the interior-illustration prompt, so a rewrite that replaced
 * purpose, beat, endingPressure and continuity and left it standing published a
 * fresh assignment under the old page's picture: page 177 of the 2026-08-22
 * reference book was reassigned off its blockade beat and illustrated with "A
 * readable scene focused on the North Sea blockade" anyway, because `...page`
 * is spread first below and nothing after it named the field. It rides the same
 * composer-only route as the flag above for the same reason — the critic's own
 * prompt says nothing about visual moments, and a field a model may set is a
 * field every critic patch may quietly redraw a page with. Absent, the page
 * keeps whatever the map wrote, **including nothing at all**: `imageMoment` is
 * optional on `PageProductionBeat`, and a page the map left without one must
 * not gain a picture from a pass whose subject is a duplicated beat.
 */
export type PageMapCriticBeatPatch = z.infer<typeof pageMapCriticBeatPatchSchema> & {
  replaceRequiredContinuity?: boolean;
  imageMoment?: string;
};

export type PageMapCriticPatch = Omit<z.infer<typeof pageMapCriticPatchSchema>, "beatPatches"> & {
  beatPatches: PageMapCriticBeatPatch[];
};

/**
 * Applies the critic's patch to the map it critiqued.
 *
 * `lastPageIndex` is the book's last page — `input.targetPages`, which pages are
 * numbered 1..n against, so the index and the count are the same number. It is
 * required rather than derived from `briefs` for the reason at the top of this
 * file: the substitution below is the one place our own code writes an ending
 * pressure, and it may only call a page the ending when the *book* ends there.
 */
export function mergePageMapCriticPatch(
  briefs: ChapterBrief[],
  patch: PageMapCriticPatch,
  lastPageIndex: number
): ChapterBrief[] {
  const patchByPage = new Map(patch.beatPatches.map((item) => [item.pageIndex, item]));
  const missingEnding = new Set(patch.missingEndingPressure);
  return briefs.map((brief) => ({
    ...brief,
    pages: brief.pages.map((page) => {
      const beatPatch = patchByPage.get(page.pageIndex);
      const endingPressure =
        beatPatch?.endingPressure ??
        (missingEnding.has(page.pageIndex) && !page.endingPressure.trim()
          ? substitutedEndingPressure(page.pageIndex, lastPageIndex)
          : page.endingPressure);
      return {
        ...page,
        ...(beatPatch?.purpose ? { purpose: beatPatch.purpose } : {}),
        ...(beatPatch?.beat ? { beat: beatPatch.beat } : {}),
        ...(beatPatch?.imageMoment ? { imageMoment: beatPatch.imageMoment } : {}),
        endingPressure,
        requiredContinuity: patchedContinuity(page.requiredContinuity, beatPatch)
      };
    }),
    continuityFocus: focusWithCriticNotes(brief.continuityFocus, patch)
  }));
}

/**
 * How many entries a pass **appending** to a chapter's `continuityFocus` may
 * grow it to. The whole brief is serialized into every page's drafting prompt,
 * and the lists appended from here — one `Schedule payoff:` line per unscheduled
 * promise, plus every duplicate-purpose warning — are written for the *book* and
 * added to **every** chapter, so a critic with a long promise list is the one
 * writer here that can grow all of them at once.
 *
 * **It caps what a pass adds, never what a brief may hold.**
 * `ChapterBrief.continuityFocus` has no cap of its own (`schemas/book.ts`), so a
 * list arriving longer than this is entries the map's own producers wrote and
 * the drafter has always been given — truncating it is lossy rather than
 * redundant, which is why `focusWithCriticNotes` leaves an untouched list alone
 * and only the appending path measures itself against this number. The limit
 * therefore belongs to the side spending the budget, and it is exported because
 * there are two of them: this merge, and the worker's brief repair
 * (`replacePageBriefInChapterBrief`, `apps/worker/src/generation/pageReviewRecovery.ts`),
 * which appends a repaired page's own continuity onto the chapter's. Spelled
 * twice it is a number two workspaces can drift apart on; the name says
 * "chapter" rather than "critic" for the same reason.
 */
export const CHAPTER_CONTINUITY_FOCUS_LIMIT = 20;

/**
 * The cap belongs to the notes, not to the merge.
 *
 * A brief this patch adds nothing to comes back with the entries it arrived with —
 * untouched, not re-deduped and not truncated. That distinction cost nothing
 * while `QUALITY_FEATURE_DEFAULTS.pageMapCritic` was `["ultra", "premium"]` and
 * this merge only ever ran behind `critiquePageMap`. `beatDedup` defaults to all
 * four tiers and composes its patch in this shape (`beatDedupPatch`,
 * `pageBeatDedup.ts`) with both note lists empty, and `dedupeBriefBeats` merges
 * over **every** chapter brief the moment one collision is found anywhere in the
 * map — so an unconditional `slice` started silently deleting the 21st constraint
 * onward from every chapter of a fast or balanced book, as a side effect of a
 * pass whose only intent was to rewrite two page beats. `ChapterBrief.continuityFocus`
 * has no cap of its own (`schemas/book.ts`), so those entries are ones the map's
 * own producers wrote and the drafter has always been given.
 *
 * **Untouched is not the same object, though.** Handing the caller's own array
 * back made the merged brief's `continuityFocus` the *input* brief's array, so
 * the pre- and post-merge maps shared one list and any later `push` — a brief
 * repair's, a fallback path's — would have written through to both. That was
 * theoretical while every path here appended; it is the common path now that
 * `beatDedup` merges an empty-note patch on every tier. A copy costs nothing at
 * this size, and it is the same write-through
 * `replacePageBriefInChapterBrief` (`apps/worker/src/generation/pageReviewRecovery.ts`)
 * was made pure to remove. The pages beside it are already safe by construction:
 * every field a page carries is a primitive except `requiredContinuity`, and
 * `patchedContinuity` answers with a fresh array on both of its branches.
 *
 * The appending path is deliberately unchanged: where notes are added the whole
 * list is still deduped and cut to `CHAPTER_CONTINUITY_FOCUS_LIMIT`, including
 * the entries the brief came in with. That is a prompt budget being enforced by
 * the thing spending it, which is where it belongs.
 */
function focusWithCriticNotes(existing: string[], patch: PageMapCriticPatch): string[] {
  const notes = [
    ...patch.unscheduledPromises.map((promise) => `Schedule payoff: ${promise}`),
    ...patch.duplicatePurposeWarnings
  ];
  if (notes.length === 0) {
    return [...existing];
  }
  return uniqueStrings([...existing, ...notes]).slice(0, CHAPTER_CONTINUITY_FOCUS_LIMIT);
}

export async function critiquePageMap(
  options: PageBriefBookScope & {
    textModel: TextModelAdapter;
    briefs: ChapterBrief[];
    promises: string[];
  }
): Promise<PageMapCriticPatch> {
  // The critic is handed the whole book twice over — the map it critiques, and
  // the `input`/`plan` that map was written from — so it asks the contract the
  // same way the four producers in `pagesPageMap.ts` do, over the book's own
  // page range rather than the map's. That keeps every half together here too:
  // the rule, the payload key it names, the first-page/last-page ranking, and
  // the exemption that silences an import's hook. A patch for page 1 of a
  // one-page book is written under the same ending contract the substitution
  // below would have supplied.
  const firstPage = firstPageBriefFieldsForRange(options, 1, options.input.targetPages);
  const result = await generateJsonWithRetry(options.textModel, {
    purpose: "critique-page-map",
    temperature: 0,
    maxTokens: 1400,
    schema: pageMapCriticPatchSchema,
    messages: [
      {
        role: "system",
        content: [
          "You critique a whole-book page map.",
          "Return beat patches for duplicate purpose, missing endingPressure, or a promise that is never scheduled.",
          "Do not regenerate the map. Prefer an empty patch when the beats already progress.",
          "A beat patch for pageIndex 1 replaces the book's opening assignment, so it must satisfy the same first-page contract the map was written under:",
          ...firstPage.rules
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            promises: options.promises,
            ...firstPage.payload,
            pages: options.briefs.flatMap((brief) =>
              brief.pages.map((page) => ({
                pageIndex: page.pageIndex,
                chapterIndex: page.chapterIndex,
                purpose: page.purpose,
                beat: page.beat,
                endingPressure: page.endingPressure
              }))
            )
          },
          null,
          2
        )
      }
    ]
  });
  // Already this schema's output: `generateJsonWithRetry` passes `schema` to the
  // adapter, which is what parses — and what its retry loop re-prompts on when
  // the parse fails.
  return result.data;
}

/**
 * The sentence the merge writes when the critic reports a page as missing its
 * ending pressure. `missingEndingPressure` is a list of page indexes and
 * nothing else, so this text is ours — page 1 taking the generic line was the
 * first-page contract being overwritten by our own code rather than by a model,
 * on the one page it exists for.
 *
 * Which is why all three branches are `pageEndingContract`'s, not just the
 * first-page one. Withholding the opening sentence from a page 1 that is also
 * the last page only got the book half out of the collision: the generic line
 * underneath hands *every* last page — page 12 of a twelve-page book as much as
 * the one-page book's only page — a consequence to carry into a page that does
 * not exist. A brief is the last thing the drafter reads, so that is a book
 * asked to end on a page turn.
 */
function substitutedEndingPressure(pageIndex: number, lastPageIndex: number): string {
  switch (pageEndingContract(pageIndex, lastPageIndex)) {
    case "ending":
      return LAST_PAGE_ENDING_PRESSURE;
    case "opening":
      return FIRST_PAGE_ENDING_PRESSURE;
    default:
      return "Carry a concrete consequence into the next page.";
  }
}

/** Appending is the default; see `PageMapCriticBeatPatch` for the one patch that replaces. */
function patchedContinuity(existing: string[], beatPatch: PageMapCriticBeatPatch | undefined): string[] {
  const patched = beatPatch?.requiredContinuity ?? [];
  return beatPatch?.replaceRequiredContinuity && patched.length > 0
    ? uniqueStrings(patched)
    : uniqueStrings([...existing, ...patched]);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(trimmed);
  }
  return unique;
}
