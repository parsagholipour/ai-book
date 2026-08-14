import type { JsonResult, ResearchAdapter, TextModelAdapter } from "../adapters/types.js";
import { targetLanguageGenerationGuidance, targetLanguagePayload } from "../prompting/language.js";
import { kidsReadingGuidanceLines, kidsReadingGuidancePayload } from "../prompting/readingLevel.js";
import { getTemplateForInput, makeFallbackPlan, type TemplateDefinition } from "../prompting/templates.js";
import { plannerToneGuidance, toneProfileFromMediaSettings } from "../prompting/tone.js";
import {
  bookPlanModelOutputSchemaWithFallback,
  bookPlanSchema,
  bookPlanSchemaWithFallback,
  type BookPlan,
  type ChapterPlan,
  type CreateProjectInput,
  type ResearchSource,
  type ToneProfile
} from "../schemas/book.js";
import { mediaSettingsMobileRecord } from "../schemas/jsonCoercion.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import { libraryCharactersFromMediaSettings } from "./libraryCharacters.js";
import { planLibraryCharacterGuidance, reconcilePlanLibraryCharacters } from "./planLibraryCharacters.js";
import { BYLINE_IS_TYPESET_RULE } from "./markdown.js";

export type CreatePlanPhase = "understand" | "shape" | "finalize";

export type CreatePlanOptions = {
  input: CreateProjectInput;
  textModel: TextModelAdapter;
  research: ResearchAdapter;
  forceFallback?: boolean;
  onPhase?: (phase: CreatePlanPhase) => void | Promise<void>;
};

export type RevisePlanOptions = {
  currentPlan: BookPlan;
  userMessage: string;
  textModel: TextModelAdapter;
  input?: CreateProjectInput | undefined;
  targetPages?: number;
  temperature?: number;
  language?: string;
  toneProfile?: ToneProfile;
  respondedQuestionPrompts?: string[] | undefined;
};

export type ExpandChapterResearchOptions = {
  input: CreateProjectInput;
  plan: BookPlan;
  research: ResearchAdapter;
  cap: number;
};

export async function createPlanningPackage(options: CreatePlanOptions): Promise<BookPlan> {
  await options.onPhase?.("understand");
  const template = getTemplateForInput(options.input);
  const fallback = makeFallbackPlan(options.input);
  const researchNotes = await researchForPlan(options.input, template, fallback.researchQueries, options.research);
  const toneProfile = toneProfileFromMediaSettings(options.input.mediaSettings);
  const librarySnapshots = libraryCharactersFromMediaSettings(options.input.mediaSettings);

  await options.onPhase?.("shape");
  if (options.forceFallback) {
    await options.onPhase?.("finalize");
    // Reconciled too, so a MOCK_AI run exercises the same seeding path a real
    // one does: the template fallback plans no characters at all, and without
    // this an @-mentioned character simply vanishes in development.
    return normalizePlanPageTargets(
      reconcilePlanLibraryCharacters({ ...fallback, researchNotes }, librarySnapshots),
      options.input.targetPages
    );
  }

  const planningSchema = bookPlanModelOutputSchemaWithFallback({ ...fallback, researchNotes });
  let result: JsonResult<Omit<BookPlan, "researchNotes">>;
  try {
    result = await generateJsonWithRetry(options.textModel, {
      purpose: "plan-book",
      temperature: Math.min(0.8, options.input.temperature),
      maxTokens: 8000,
      schema: planningSchema,
      messages: [
        {
          role: "system",
          content: [
            "You are a senior human book editor and book packager.",
            "Create a practical generation plan for a long-form Markdown book.",
            "The plan must be specific enough for page-by-page generation without sounding machine-written.",
            "Return the plan fields at the JSON root; do not nest them under plan, data, or result.",
            "Plan real book chapters, not one titled chapter or section per generated page.",
            `The sum of chapter targetPages must equal exactly ${options.input.targetPages}.`,
            "Do not create more chapters than targetPages, because every chapter must contain at least one page.",
            "For factual, scientific, historical, or research-grounded books, build the plan around source-backed claims and explicit uncertainty; do not invent studies, journals, institutes, experts, statistics, citations, or numeric findings.",
            "Treat researchContext as input-only evidence. Use it to ground the plan, but do not include a researchNotes field or reproduce its source records in your response; the server attaches them after planning.",
            "Preserve concrete user intent. Treat the request as complete once the requested book and its subject are understandable, and make sensible creative decisions yourself.",
            BYLINE_IS_TYPESET_RULE,
            "Set questions to [] for every coherent request. Ask at most one question only when a missing subject, unclear reference, contradictory instruction, or unavailable required source makes the user's request impossible to understand.",
            "Never ask for optional tone, mood, conflict, ending, character names, scene details, chapter structure, exercises, calls to action, or other choices you can make while drafting the plan.",
            "Any necessary question must be plain, self-contained, tied directly to words the user supplied, and must not mention an unexplained character or detail invented by the plan.",
            ...mobileAutoPlanningGuidance(options.input),
            "For the single necessary question, include 2-4 concise premade answers only when a few complete answers really cover it, and make every option a full answer usable as-is. When the answer is a value only the reader can supply - a name, a title, a place, a number, a date - set options to [] and let them type it. Never write an option that only describes how the reader will answer. Allow a custom answer unless the question is informational only.",
            'Declare how many answers you accept in answerKind: "choice" when exactly one option can be true, "multi" (up to 6 options) when the reader can honestly combine several and you can honour every pick, "open" with no options otherwise. The app draws the picker from answerKind, so never say "choose one or more" in the prompt and never list the options inside the prompt text.',
            "For every recurring character, include concrete visualRules with stable silhouette, face, outfit, color palette, and distinctive details suitable for a reusable character reference sheet.",
            "Seed promises with the book's open dramatic or explanatory commitments the later pages must pay off. Use [] when the book has none.",
            "Illustration prompts must use exact recurring character names whenever those characters appear.",
            ...targetLanguageGenerationGuidance(options.input.language),
            ...kidsReadingGuidanceLines(options.input),
            ...plannerToneGuidance(toneProfile),
            // Last deliberately. Three earlier rules argue against a saved
            // character, each in a way recency decides: "write all book-facing
            // strings in <language>" (which translated the name), "for every
            // recurring character include concrete visualRules" (which invented
            // the look), and the kids vocabulary rule (which simplifies an
            // unfamiliar name). The library rules must be the later half of
            // every one of those pairs.
            ...planLibraryCharacterGuidance(librarySnapshots)
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              userInput: options.input,
              toneProfile,
              language: targetLanguagePayload(options.input.language),
              readingGuidance: kidsReadingGuidancePayload(options.input),
              template,
              fallbackOutline: planWithoutResearchNotes(fallback),
              researchContext: researchContextForPlanPrompt(researchNotes)
            },
            null,
            2
          )
        }
      ]
    });
  } catch (error) {
    throw new Error(`AI planner failed. No fallback plan was created. ${formatErrorMessage(error)}`);
  }

  await options.onPhase?.("finalize");
  try {
    const plan = bookPlanSchema.parse({
      ...result.data,
      researchNotes
    });
    return normalizePlanPageTargets(
      reconcilePlanLibraryCharacters(
        {
          ...plan,
          questions: plan.questions.slice(0, 1)
        },
        librarySnapshots
      ),
      options.input.targetPages
    );
  } catch (error) {
    throw new Error(`AI planner returned an invalid plan. No fallback plan was created. ${formatErrorMessage(error)}`);
  }
}

export async function revisePlanningPackage(options: RevisePlanOptions): Promise<BookPlan> {
  const targetPages = options.targetPages ?? sumChapterTargetPages(options.currentPlan.chapters);
  const toneProfile = options.toneProfile ?? "neutral";
  // A revision is a patch whose arrays replace wholesale, so `characters` is
  // re-decided in full by a model that used to be told nothing about the
  // library at all: "make it shorter" after approval was enough to rewrite the
  // reader's saved character out of their own book.
  const librarySnapshots = libraryCharactersFromMediaSettings(options.input?.mediaSettings);
  // Questions are an explicit semantic decision on every revision. If the
  // model omits them, default to none instead of restoring legacy questions.
  const revisionSchema = bookPlanSchemaWithFallback({ ...options.currentPlan, questions: [] });
  try {
    const result = await generateJsonWithRetry(options.textModel, {
      purpose: "revise-plan",
      temperature: options.temperature ?? 0.4,
      maxTokens: 8000,
      schema: revisionSchema,
      messages: [
        {
          role: "system",
          content:
            [
              `Revise this book generation plan. Return a JSON object with revised plan fields at the JSON root, not nested under plan, data, or result. You may omit unchanged fields because the server preserves them from the current plan. Do not re-emit unchanged researchNotes; existing research notes are preserved server-side. Apply the user's requested changes directly and preserve useful existing decisions. Plan real book chapters, not one titled chapter or section per generated page. The sum of chapter targetPages must equal exactly ${targetPages}; do not create more chapters than targetPages. For factual, scientific, historical, or research-grounded books, preserve source-backed claims and uncertainty; do not invent studies, journals, institutes, experts, statistics, citations, or numeric findings. When the user answers planning questions, bake the answered decisions into the plan and remove or update questions that are now resolved. Treat skipped questions as no preference: decide those details yourself and remove them from questions. Never re-ask a question the user already answered or skipped, even reworded. Set questions to [] whenever the user's book and subject are understandable. Ask at most one plain, self-contained question only for a missing subject, unclear reference, contradictory instruction, or unavailable required source. Never ask for optional tone, mood, conflict, ending, character names, scene details, chapter structure, exercises, calls to action, or other plan details you can decide yourself.`,
              "Any question you keep needs 2-4 premade answers only when a few complete answers really cover it, and every option must be a full answer usable as-is. When the answer is a value only the reader can supply - a name, a title, a place, a number, a date - set options to [] and let them type it. Never write an option that only describes how the reader will answer.",
              'Declare how many answers you accept in answerKind: "choice" when exactly one option can be true, "multi" (up to 6 options) when the reader can honestly combine several and you can honour every pick, "open" with no options otherwise. The app draws the picker from answerKind, so never say "choose one or more" in the prompt and never list the options inside the prompt text. A multi question can come back with several answers in one line; bake all of them into the plan.',
              BYLINE_IS_TYPESET_RULE,
              "For recurring characters, preserve or add concrete visualRules with stable silhouette, face, outfit, color palette, and distinctive details; illustration prompts must use exact recurring character names whenever those characters appear.",
              ...targetLanguageGenerationGuidance(options.language),
              ...(options.input ? kidsReadingGuidanceLines(options.input) : []),
              ...plannerToneGuidance(toneProfile),
              // Last for the same reason as in initial planning: the rules it
              // has to outrank are all above it.
              ...planLibraryCharacterGuidance(librarySnapshots)
            ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              currentPlan: compactPlanForRevisionPrompt(options.currentPlan),
              userMessage: options.userMessage,
              respondedQuestionPrompts: options.respondedQuestionPrompts?.length
                ? options.respondedQuestionPrompts
                : undefined,
              toneProfile,
              language: targetLanguagePayload(options.language),
              readingGuidance: options.input ? kidsReadingGuidancePayload(options.input) : undefined,
              libraryCharacters: librarySnapshots.length > 0 ? librarySnapshots : undefined,
              pageBudget: {
                targetPages
              }
            },
            null,
            2
          )
        }
      ]
    });
    const revised = revisionSchema.parse(result.data);
    const questions = removeRespondedQuestions(
      revised.questions,
      options.respondedQuestionPrompts
    ).slice(0, 1);
    return normalizePlanPageTargets(
      reconcilePlanLibraryCharacters(
        {
          ...revised,
          questions,
          researchNotes: mergeResearchNotes(options.currentPlan.researchNotes, revised.researchNotes)
        },
        librarySnapshots
      ),
      targetPages
    );
  } catch (error) {
    throw new Error(`AI plan revision failed. No revised plan was created. ${formatErrorMessage(error)}`);
  }
}

function removeRespondedQuestions(
  questions: BookPlan["questions"],
  respondedPrompts: string[] | undefined
): BookPlan["questions"] {
  const respondedKeys = new Set((respondedPrompts ?? []).map(questionPromptKey).filter(Boolean));
  if (respondedKeys.size === 0) {
    return questions;
  }
  return questions.filter((question) => !respondedKeys.has(questionPromptKey(question.prompt)));
}

function questionPromptKey(prompt: string): string {
  return prompt.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function compactPlanForRevisionPrompt(plan: BookPlan): Omit<BookPlan, "researchNotes"> & {
  researchNotesSummary: Array<{
    query: string;
    title: string;
    summaryPreview: string;
    publishedAt?: string | undefined;
  }>;
  researchNoteCount: number;
} {
  const { researchNotes: _researchNotes, ...rest } = plan;
  return {
    ...rest,
    researchNoteCount: plan.researchNotes.length,
    researchNotesSummary: plan.researchNotes.slice(0, 8).map((source) => ({
      query: source.query,
      title: source.title,
      summaryPreview: source.summary.slice(0, 240),
      ...(source.publishedAt ? { publishedAt: source.publishedAt } : {})
    }))
  };
}

export function normalizePlanPageTargets(plan: BookPlan, targetPages: number): BookPlan {
  const pageTarget = Math.max(1, Math.floor(targetPages));
  // Above the size where chapter apparatus actually prints (~8 pages), a
  // chapter that averages under two pages is a heading over a paragraph. The
  // prompt already forbids one-chapter-per-page plans; this is the guarantee —
  // the old guard only merged when chapters *exceeded* the page count, so a
  // plan with exactly one chapter per page sailed through untouched. Short
  // books keep their one-page chapters deliberately: they are a writing
  // scaffold, and `chapterPresentationFor` already sizes the printed
  // apparatus to the finished book.
  const chapterLimit = pageTarget >= 8 ? Math.max(1, Math.floor(pageTarget / 2)) : pageTarget;
  const sourceChapters =
    plan.chapters.length > chapterLimit ? mergeAdjacentChapters(plan.chapters, chapterLimit) : plan.chapters;
  const chapterCount = Math.max(1, Math.min(sourceChapters.length, pageTarget));
  const chapters = sourceChapters.slice(0, chapterCount);
  const targetPageCounts = distributeTargetPages(chapters, pageTarget);

  return {
    ...plan,
    chapters: chapters.map((chapter, index) => ({
      ...chapter,
      index: index + 1,
      targetPages: targetPageCounts[index] ?? 1
    }))
  };
}

/**
 * Merges the smallest adjacent pair until the plan fits the limit. Adjacent,
 * not overflow-into-last: folding every extra chapter into the final one
 * turned a twelve-beat outline into five thin chapters and one bloated tail,
 * while pairwise merging keeps the narrative order and the sizes balanced.
 */
function mergeAdjacentChapters(chapters: ChapterPlan[], chapterLimit: number): ChapterPlan[] {
  const merged = [...chapters];
  while (merged.length > Math.max(1, chapterLimit)) {
    let bestIndex = 0;
    let bestSize = Number.POSITIVE_INFINITY;
    for (let index = 0; index + 1 < merged.length; index += 1) {
      const size =
        Math.max(1, Math.floor(merged[index]!.targetPages)) + Math.max(1, Math.floor(merged[index + 1]!.targetPages));
      if (size < bestSize) {
        bestSize = size;
        bestIndex = index;
      }
    }
    merged.splice(bestIndex, 2, mergeChapterPair(merged[bestIndex]!, merged[bestIndex + 1]!));
  }
  return merged;
}

function mergeChapterPair(first: ChapterPlan, second: ChapterPlan): ChapterPlan {
  return {
    ...first,
    summary: [first.summary, `Also covers ${second.title}: ${second.summary}`.trim()].filter(Boolean).join(" "),
    targetPages: Math.max(1, Math.floor(first.targetPages)) + Math.max(1, Math.floor(second.targetPages)),
    keyBeats: [...first.keyBeats, `Fold in ${second.title}.`, ...second.keyBeats].slice(0, 20),
    illustrationPrompts: [...(first.illustrationPrompts ?? []), ...(second.illustrationPrompts ?? [])].slice(0, 12)
  };
}

function distributeTargetPages(chapters: ChapterPlan[], targetPages: number): number[] {
  const count = chapters.length;
  const currentTotal = sumChapterTargetPages(chapters);
  if (count === 0) {
    return [];
  }
  if (count <= targetPages && currentTotal === targetPages) {
    return chapters.map((chapter) => Math.max(1, Math.floor(chapter.targetPages)));
  }

  const allocation = Array.from({ length: count }, () => 1);
  let remaining = targetPages - count;
  if (remaining <= 0) {
    return allocation;
  }

  const extraWeights = chapters.map((chapter) => Math.max(0, Math.floor(chapter.targetPages) - 1));
  const totalExtraWeight = extraWeights.reduce((sum, weight) => sum + weight, 0);
  const weights = totalExtraWeight > 0 ? extraWeights : chapters.map(() => 1);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const fractionalExtras = weights.map((weight, index) => {
    const exact = (remaining * weight) / totalWeight;
    const floor = Math.floor(exact);
    allocation[index] = allocation[index]! + floor;
    return { index, remainder: exact - floor };
  });

  remaining = targetPages - allocation.reduce((sum, pages) => sum + pages, 0);
  fractionalExtras
    .sort((first, second) => second.remainder - first.remainder || first.index - second.index)
    .slice(0, remaining)
    .forEach(({ index }) => {
      allocation[index] = allocation[index]! + 1;
    });

  return allocation;
}

function sumChapterTargetPages(chapters: ChapterPlan[]): number {
  return chapters.reduce((sum, chapter) => sum + Math.max(1, Math.floor(chapter.targetPages)), 0);
}

function mergeResearchNotes(first: ResearchSource[], second: ResearchSource[]): ResearchSource[] {
  const seen = new Set<string>();
  const merged: ResearchSource[] = [];
  for (const source of [...first, ...second]) {
    const key = [source.query, source.title, source.url ?? "", source.summary].join("\0");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(source);
  }
  return merged;
}

function planWithoutResearchNotes(plan: BookPlan): Omit<BookPlan, "researchNotes"> {
  const { researchNotes: _researchNotes, ...rest } = plan;
  return rest;
}

function researchContextForPlanPrompt(researchNotes: ResearchSource[]): Array<{
  query: string;
  sources: Array<Omit<ResearchSource, "query">>;
}> {
  const sourcesByQuery = new Map<string, Array<Omit<ResearchSource, "query">>>();
  for (const researchNote of researchNotes) {
    const { query, ...source } = researchNote;
    const sources = sourcesByQuery.get(query) ?? [];
    sources.push(source);
    sourcesByQuery.set(query, sources);
  }
  return [...sourcesByQuery].map(([query, sources]) => ({ query, sources }));
}

export async function expandChapterResearch(options: ExpandChapterResearchOptions): Promise<ResearchSource[]> {
  const cap = Math.max(0, Math.floor(options.cap));
  if (cap === 0) {
    return [];
  }

  const queries = [
    ...options.plan.chapters.map((chapter) =>
      [options.input.prompt, chapter.title, chapter.summary, ...chapter.keyBeats].filter(Boolean).join(" ")
    ),
    ...options.plan.researchQueries
  ];
  const uniqueQueries = [...new Set(queries.map((query) => query.trim()).filter(Boolean))].slice(0, cap);
  const results = await Promise.allSettled(
    uniqueQueries.map((query) => options.research.search({ query, purpose: "chapter-research" }))
  );

  return results
    .flatMap((result) => {
      if (result.status !== "fulfilled") {
        return [];
      }
      return result.value.sources.map((source) => ({
        query: result.value.query,
        title: source.title,
        url: source.url,
        summary: source.summary,
        publishedAt: source.publishedAt
      }));
    })
    .slice(0, cap);
}

async function researchForPlan(
  input: CreateProjectInput,
  template: TemplateDefinition,
  fallbackQueries: string[],
  adapter: ResearchAdapter
): Promise<ResearchSource[]> {
  const needsResearch =
    template.defaultConfig.researchPolicy === "always" ||
    /\b(current|recent|latest|today|real|scientific|historical|medicine|law|finance)\b/i.test(input.prompt);

  if (!needsResearch) {
    return [];
  }

  const queries = [...new Set([input.prompt, ...fallbackQueries])].slice(0, 3);
  const results = await Promise.allSettled(queries.map((query) => adapter.search({ query, purpose: "plan-research" })));

  return results.flatMap((result) => {
    if (result.status !== "fulfilled") {
      return [];
    }
    return result.value.sources.map((source) => ({
      query: result.value.query,
      title: source.title,
      url: source.url,
      summary: source.summary,
      publishedAt: source.publishedAt
    }));
  });
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown error.";
}

function mobileAutoPlanningGuidance(input: CreateProjectInput): string[] {
  const mobile = mediaSettingsMobileRecord(input.mediaSettings);
  if (mobile.bookTypeChoice !== "auto") {
    return [];
  }
  return [
    "This mobile project kept Book type as Auto until planning.",
    "Decide the real book shape from the user's creation chat, source notes, and manual settings. Valid shapes include children's fable, short story, workbook, practical guide, client tool, offer guide, and lead magnet.",
    "The CUSTOM category and general-book template are only a neutral routing shell; do not treat them as the user's requested genre.",
    "If the chat implies a specific form, such as a children's fable or a workbook, plan that form directly."
  ];
}
