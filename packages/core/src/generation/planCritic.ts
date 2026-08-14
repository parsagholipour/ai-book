import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import type { BookPlan, ChapterPlan } from "../schemas/book.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";

export const planCriticPatchSchema = z.object({
  promisesToAdd: z.array(z.string().min(1)).default([]),
  chapterMergeNotes: z
    .array(
      z.object({
        fromIndex: z.number().int().positive(),
        intoIndex: z.number().int().positive(),
        note: z.string().optional()
      })
    )
    .default([]),
  reorderNotes: z.array(z.string().min(1)).default([]),
  repeatedBeatWarnings: z.array(z.string().min(1)).default([])
});

export type PlanCriticPatch = z.infer<typeof planCriticPatchSchema>;

/**
 * Deterministic merge of a cheap plan-critic patch. Adds unique promises,
 * folds named chapter pairs, and records beat/reorder notes as continuity
 * rules. Never calls the prose planner.
 */
export function mergePlanCriticPatch(plan: BookPlan, patch: PlanCriticPatch): BookPlan {
  const promises = uniqueStrings([...(plan.promises ?? []), ...patch.promisesToAdd]);
  let chapters = [...plan.chapters];
  // Patch entries name original chapter.index values. Keep those identities
  // until every merge has been applied, then renumber once.
  const merges = [...patch.chapterMergeNotes].filter((note) => note.fromIndex !== note.intoIndex);
  for (const merge of merges) {
    const fromPos = chapters.findIndex((chapter) => chapter.index === merge.fromIndex);
    const intoPos = chapters.findIndex((chapter) => chapter.index === merge.intoIndex);
    if (fromPos < 0 || intoPos < 0 || fromPos === intoPos) {
      continue;
    }
    const from = chapters[fromPos]!;
    const into = chapters[intoPos]!;
    const merged = mergeChapterPair(into, from, merge.note);
    chapters = chapters
      .filter((_, pos) => pos !== fromPos)
      .map((chapter) => (chapter.index === into.index ? merged : chapter));
  }
  chapters = chapters.map((chapter, index) => ({ ...chapter, index: index + 1 }));

  const continuityRules = uniqueStrings([
    ...plan.continuityRules,
    ...patch.repeatedBeatWarnings.map((warning) => `Avoid repeating this beat: ${warning}`),
    ...patch.reorderNotes
  ]);

  return { ...plan, promises, chapters, continuityRules };
}

export async function critiquePlan(options: {
  textModel: TextModelAdapter;
  plan: BookPlan;
}): Promise<PlanCriticPatch> {
  const result = await generateJsonWithRetry(options.textModel, {
    purpose: "critique-plan",
    temperature: 0,
    maxTokens: 1200,
    schema: planCriticPatchSchema,
    messages: [
      {
        role: "system",
        content: [
          "You are a mechanical plan critic.",
          "Return a JSON patch only: promisesToAdd, chapterMergeNotes, reorderNotes, repeatedBeatWarnings.",
          "Do not rewrite chapter prose. Prefer an empty patch when the plan is already specific."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            title: options.plan.title,
            premise: options.plan.premise,
            promises: options.plan.promises,
            chapters: options.plan.chapters.map((chapter) => ({
              index: chapter.index,
              title: chapter.title,
              summary: chapter.summary,
              targetPages: chapter.targetPages,
              keyBeats: chapter.keyBeats
            }))
          },
          null,
          2
        )
      }
    ]
  });
  return planCriticPatchSchema.parse(result.data);
}

function mergeChapterPair(into: ChapterPlan, from: ChapterPlan, note?: string): ChapterPlan {
  return {
    ...into,
    summary: [into.summary, `Also covers ${from.title}: ${from.summary}`.trim(), note]
      .filter((part): part is string => Boolean(part && part.trim()))
      .join(" "),
    targetPages: Math.max(1, Math.floor(into.targetPages)) + Math.max(1, Math.floor(from.targetPages)),
    keyBeats: [...into.keyBeats, `Fold in ${from.title}.`, ...from.keyBeats].slice(0, 20)
  };
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
