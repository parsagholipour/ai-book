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

export const pageMapCriticPatchSchema = z.object({
  beatPatches: z
    .array(
      z.object({
        pageIndex: z.number().int().positive(),
        purpose: z.string().min(1).optional(),
        beat: z.string().min(1).optional(),
        endingPressure: z.string().min(1).optional(),
        requiredContinuity: z.array(z.string().min(1)).optional(),
        note: z.string().min(1).optional()
      })
    )
    .default([]),
  duplicatePurposeWarnings: z.array(z.string().min(1)).default([]),
  missingEndingPressure: z.array(z.number().int().positive()).default([]),
  unscheduledPromises: z.array(z.string().min(1)).default([])
});

export type PageMapCriticPatch = z.infer<typeof pageMapCriticPatchSchema>;

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
        endingPressure,
        requiredContinuity: uniqueStrings([
          ...page.requiredContinuity,
          ...(beatPatch?.requiredContinuity ?? [])
        ])
      };
    }),
    continuityFocus: uniqueStrings([
      ...brief.continuityFocus,
      ...patch.unscheduledPromises.map((promise) => `Schedule payoff: ${promise}`),
      ...patch.duplicatePurposeWarnings
    ]).slice(0, 20)
  }));
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
  return pageMapCriticPatchSchema.parse(result.data);
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
