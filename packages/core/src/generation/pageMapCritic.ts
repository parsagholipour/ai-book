import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import type { ChapterBrief } from "../schemas/book.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";

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

export function mergePageMapCriticPatch(briefs: ChapterBrief[], patch: PageMapCriticPatch): ChapterBrief[] {
  const patchByPage = new Map(patch.beatPatches.map((item) => [item.pageIndex, item]));
  const missingEnding = new Set(patch.missingEndingPressure);
  return briefs.map((brief) => ({
    ...brief,
    pages: brief.pages.map((page) => {
      const beatPatch = patchByPage.get(page.pageIndex);
      const endingPressure =
        beatPatch?.endingPressure ??
        (missingEnding.has(page.pageIndex) && !page.endingPressure.trim()
          ? "Carry a concrete consequence into the next page."
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

export async function critiquePageMap(options: {
  textModel: TextModelAdapter;
  briefs: ChapterBrief[];
  promises: string[];
}): Promise<PageMapCriticPatch> {
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
          "Do not regenerate the map. Prefer an empty patch when the beats already progress."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            promises: options.promises,
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
