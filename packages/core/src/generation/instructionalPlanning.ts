import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import { targetLanguageGenerationGuidance, targetLanguagePayload } from "../prompting/language.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import { chapterEpisodeSchema, type BookEpisodes } from "../schemas/episodes.js";
import { instructionalSettingSchema, type InstructionalSetting } from "../schemas/instructional.js";
import { isRecord } from "../schemas/jsonCoercion.js";
import { TOOLKIT_FORMS } from "./chapterFormPalette.js";
import {
  PLAN_CHAPTER_FORMS_PURPOSE,
  assignedSectionCount,
  capFigures,
  compositionShapeIssues,
  compositionVarietyIssues,
  fallbackChapterComposition,
  figureCapFor,
  normalizeChapterCompositions,
  settleFormVariety,
  sustainedSectionShare,
  type ChapterComposition,
  type ChapterFormsResult,
  type PlanChapterFormsOptions
} from "./chapterForms.js";
import { FIXED_EXAMPLE_CAST_RULE, exampleCastFrom } from "./exampleCast.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import {
  FIXED_TOOLKIT_RULE,
  RESEARCH_LEAD_CONTRACT,
  TOOLKIT_FIGURE_FORM_PLAN_RULE,
  asResearchLeadKind,
  deliverableCarriesLength,
  homeUncoveredRequirements,
  requirementCoverageIssues,
  requirementRefs,
  researchLeadSystemLines,
  sharedRequirements,
  toolkitBookKind,
  toolkitFormPlanRules,
  toolkitFrom,
  toolkitOutputContract
} from "./instructionalBook.js";

/**
 * The two planning calls of a toolkit book (`instructionalBook.ts`), made under
 * the purposes the other books use — `plan-episodes` and `plan-chapter-forms`
 * — so they route, cost and show in the console exactly as those stages do.
 */

const PLAN_EPISODES_PURPOSE = "plan-episodes";

const researchLeadsSchema = z.object({
  setting: instructionalSettingSchema.optional().catch(undefined),
  chapters: z.array(z.object({ index: z.number().int().positive(), episodes: z.array(chapterEpisodeSchema).default([]) })).min(1)
});

export type ResearchLeadsResult = {
  episodes?: BookEpisodes | undefined;
  setting?: InstructionalSetting | undefined;
  failure?: string | undefined;
};

/**
 * A toolkit book's episodes are research leads — facts its chapters will use —
 * with the one country its rules belong to. Same purpose and the same dossier
 * downstream; never a scene, never a focus.
 */
export async function planResearchLeads(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  textModel: TextModelAdapter;
  /** ISO date the leads are planned on, so a rule's year is the reader's. Defaults to now. */
  today?: string | undefined;
}): Promise<ResearchLeadsResult> {
  try {
    const result = await generateJsonWithRetry(options.textModel, {
      purpose: PLAN_EPISODES_PURPOSE,
      temperature: Math.min(0.6, options.input.temperature),
      maxTokens: 12_000,
      schema: researchLeadsSchema,
      messages: [
        {
          role: "system",
          content: [...researchLeadSystemLines(options.plan.title), ...targetLanguageGenerationGuidance(options.input.language)].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              language: targetLanguagePayload(options.input.language),
              userPrompt: options.input.prompt,
              book: { title: options.plan.title, premise: options.plan.premise, audience: options.plan.audience },
              today: options.today ?? new Date().toISOString().slice(0, 10),
              chapters: options.plan.chapters.map((chapter) => ({
                index: chapter.index,
                title: chapter.title,
                summary: chapter.summary,
                keyBeats: chapter.keyBeats,
                targetPages: chapter.targetPages
              })),
              outputContract: RESEARCH_LEAD_CONTRACT
            },
            null,
            2
          )
        }
      ]
    });
    const known = new Set(options.plan.chapters.map((chapter) => chapter.index));
    const chapters = result.data.chapters
      .filter((chapter) => known.has(chapter.index))
      .map((chapter) => ({ index: chapter.index, episodes: chapter.episodes.map((episode) => ({ ...episode, kind: asResearchLeadKind(episode.kind) })) }));
    if (chapters.length === 0) return { failure: "no chapter of the plan received research leads" };
    return { episodes: { chapters }, ...(result.data.setting ? { setting: result.data.setting } : {}) };
  } catch (error) {
    if (error instanceof Error && /stop|abort/i.test(error.name + error.message)) throw error;
    return { failure: error instanceof Error ? error.message : String(error) };
  }
}

/** A stop must escape every best-effort catch; recognised by name so core stays free of worker imports. */
function isStopLike(error: unknown): boolean {
  return error instanceof Error && /stop/i.test(error.name);
}

/**
 * The form plan of a toolkit book: `planChapterForms`' one call, repair and
 * rotation, with the toolkit's rules, palette and contract. The reply also
 * carries the book's cast, caveats, rules and (a workbook) running case; the
 * brief's asks are checked for a home in code before any prose exists, and a
 * chapter's long section is moved onto a deliverable.
 */
export async function planInstructionalForms(options: PlanChapterFormsOptions): Promise<ChapterFormsResult> {
  const kind = options.toolkit?.kind ?? toolkitBookKind(options.input) ?? "guide";
  const palette = TOOLKIT_FORMS;
  const fixedIndexes = new Set((options.fixed ?? []).map((composition) => composition.chapterIndex));
  const open = options.ranges.filter((range) => !fixedIndexes.has(range.chapter.index));
  const fixedCast = Array.isArray(options.exampleCast) && options.exampleCast.length > 0 ? [...options.exampleCast] : undefined;
  const requirements = requirementRefs(options.requirements);
  const chapterIndexes = options.ranges.map((range) => range.chapter.index);
  const setting = options.toolkit?.setting ?? options.setting;
  if (open.length === 0) {
    return { compositions: [...(options.fixed ?? [])], issues: [], source: "model", ...(fixedCast ? { cast: fixedCast } : {}), ...(options.toolkit ? { toolkit: options.toolkit } : {}) };
  }
  const research = options.episodes?.chapters.map((chapter) => ({
    chapterIndex: chapter.index,
    leads: chapter.episodes.map(({ title, why }) => ({ fact: title, use: why }))
  }));
  const capped = (compositions: ChapterComposition[]): ChapterComposition[] =>
    capFigures(compositions, { maxPerBook: options.figures ? figureCapFor(options.ranges.length) : 0, keep: fixedIndexes });
  const merge = (planned: ChapterComposition[]): ChapterComposition[] =>
    options.ranges.map(
      (range) =>
        (options.fixed ?? []).find((composition) => composition.chapterIndex === range.chapter.index) ??
        planned.find((composition) => composition.chapterIndex === range.chapter.index) ??
        fallbackChapterComposition(range, palette, range.chapter.index)
    );
  const normalize = (reply: unknown) => deliverableCarriesLength(normalizeChapterCompositions(reply, open, palette, { toolkit: true }));

  const request = (repair: { compositions: ChapterComposition[]; issues: string[] } | undefined) =>
    generateJsonWithRetry(options.textModel, {
      purpose: PLAN_CHAPTER_FORMS_PURPOSE,
      temperature: Math.min(0.7, options.input.temperature),
      // A toolkit reply names every section's heading, contents and ids, and a workbook's running case.
      maxTokens: Math.min(32000, 4000 + open.length * 1500),
      schema: z.unknown(),
      messages: [
        {
          role: "system",
          content: [
            ...toolkitFormPlanRules(kind),
            ...(fixedCast ? [FIXED_EXAMPLE_CAST_RULE] : []),
            ...(options.toolkit ? [FIXED_TOOLKIT_RULE] : []),
            ...(options.figures ? [TOOLKIT_FIGURE_FORM_PLAN_RULE] : []),
            ...(repair
              ? ["Your previous plan is in previousPlan and failed the checks listed in issues. Return a corrected complete plan for the same chapters that resolves every issue while keeping headings, subjects and ownership where the issues allow."]
              : []),
            ...targetLanguageGenerationGuidance(options.input.language)
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              language: targetLanguagePayload(options.input.language),
              book: {
                title: options.plan.title,
                premise: options.plan.premise,
                audience: options.plan.audience,
                kind,
                ...(options.stance ? { thesisNeverRestatedByALanding: options.stance.thesis, positions: options.stance.positions } : {}),
                promises: options.plan.promises,
                continuityRules: options.plan.continuityRules
              },
              palette: palette.map((form) => ({ form: form.id, rule: form.rule })),
              chapters: open.map((range) => ({
                chapterIndex: range.chapter.index,
                title: range.chapter.title,
                summary: range.chapter.summary,
                keyBeats: range.chapter.keyBeats,
                pages: range.endPage - range.startPage + 1,
                ...(range.words !== undefined ? { words: range.words } : {}),
                sectionCount: assignedSectionCount(range.chapter.index, range.endPage - range.startPage + 1, range.words),
                sustainedShare: sustainedSectionShare(range.words)
              })),
              ...(setting ? { setting } : {}),
              ...(research?.length ? { research } : {}),
              ...(requirements.length ? { requirements } : {}),
              ...(fixedCast ? { exampleCast: fixedCast } : {}),
              ...(options.toolkit ? { toolkit: options.toolkit } : {}),
              ...(options.fixed && options.fixed.length > 0
                ? {
                    alreadyWrittenChapters: options.fixed.map((composition) => ({
                      chapterIndex: composition.chapterIndex,
                      forms: composition.sections.map((section) => section.form),
                      owns: composition.sections.flatMap((section) => section.owns),
                      covers: composition.sections.flatMap((section) => section.covers ?? [])
                    }))
                  }
                : {}),
              ...(repair ? { previousPlan: repair.compositions, issues: repair.issues } : {}),
              outputContract: toolkitOutputContract(kind, Boolean(options.figures))
            },
            null,
            2
          )
        }
      ]
    });

  const thesis = options.stance?.thesis;
  const coverageOf = (compositions: ChapterComposition[]) => requirementCoverageIssues(compositions, requirements);
  let cast = fixedCast;
  let toolkit = options.toolkit;
  const finish = (compositions: ChapterComposition[], source: ChapterFormsResult["source"], homed: string[] = []): ChapterFormsResult => {
    const coverage = coverageOf(compositions);
    return {
      compositions: capped(compositions),
      issues: [...compositionVarietyIssues(compositions, palette, { thesis }), ...coverage],
      source,
      ...(cast ? { cast } : {}),
      toolkit: toolkit ?? { kind, ...(setting ? { setting } : {}), caveats: [], rules: [] },
      coverage: { issues: coverage, homed, shared: sharedRequirements(compositions, requirements) }
    };
  };
  const homeByCode = (compositions: ChapterComposition[]) =>
    homeUncoveredRequirements(compositions, requirements, options.ranges.map((range) => range.chapter));

  let planned: ChapterComposition[];
  try {
    const reply = (await request(undefined)).data;
    planned = normalize(reply);
    if (!fixedCast) cast = exampleCastFrom(reply);
    toolkit ??= toolkitFrom(reply, kind, setting, chapterIndexes);
  } catch (error) {
    if (isStopLike(error)) throw error;
    const fallback = settleFormVariety(merge(open.map((range) => fallbackChapterComposition(range, palette, range.chapter.index))), palette);
    const homed = homeByCode(fallback);
    return finish(homed.compositions, "fallback", homed.homed);
  }
  let merged = merge(planned);
  let issues = [...compositionVarietyIssues(merged, palette, { thesis }), ...coverageOf(merged)];
  const repair = options.repair !== false;
  const shape = compositionShapeIssues(merged);
  if (issues.length === 0 && (shape.length === 0 || !repair)) return finish(merged, "model");
  if (repair) {
    try {
      const reply = (await request({ compositions: planned, issues: [...issues, ...shape] })).data;
      const repaired = merge(normalize(reply));
      const repairedIssues = [...compositionVarietyIssues(repaired, palette, { thesis }), ...coverageOf(repaired)];
      if (repairedIssues.length + compositionShapeIssues(repaired).length < issues.length + shape.length) {
        merged = repaired;
        issues = repairedIssues;
        if (!fixedCast) cast = exampleCastFrom(reply) ?? cast;
        if (!options.toolkit && isRecord(reply)) toolkit = toolkitFrom(reply, kind, setting, chapterIndexes);
      }
      if (issues.length === 0) return finish(merged, "repaired");
    } catch (error) {
      if (isStopLike(error)) throw error;
    }
  }
  // No rotation: a toolkit section's form is what it delivers, and rotating an objection into an exercise
  // left the subject behind (2026-10-01 replay). The variety issues stay on the result as diagnostics;
  // a requirement still without a home is homed by code.
  const homed = homeByCode(merged);
  return finish(homed.compositions, "model", homed.homed);
}

