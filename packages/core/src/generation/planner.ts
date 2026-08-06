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
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";

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

  await options.onPhase?.("shape");
  if (options.forceFallback) {
    await options.onPhase?.("finalize");
    return normalizePlanPageTargets({ ...fallback, researchNotes }, options.input.targetPages);
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
            "Set questions to [] for every coherent request. Ask at most one question only when a missing subject, unclear reference, contradictory instruction, or unavailable required source makes the user's request impossible to understand.",
            "Never ask for optional tone, mood, conflict, ending, character names, scene details, chapter structure, exercises, calls to action, or other choices you can make while drafting the plan.",
            "Any necessary question must be plain, self-contained, tied directly to words the user supplied, and must not mention an unexplained character or detail invented by the plan.",
            ...mobileAutoPlanningGuidance(options.input),
            "For the single necessary question, include 2-4 concise premade answer options and allow a custom answer unless the question is informational only.",
            "For every recurring character, include concrete visualRules with stable silhouette, face, outfit, color palette, and distinctive details suitable for a reusable character reference sheet.",
            "Illustration prompts must use exact recurring character names whenever those characters appear.",
            ...targetLanguageGenerationGuidance(options.input.language),
            ...kidsReadingGuidanceLines(options.input),
            ...plannerToneGuidance(toneProfile)
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
      {
        ...plan,
        questions: plan.questions.slice(0, 1)
      },
      options.input.targetPages
    );
  } catch (error) {
    throw new Error(`AI planner returned an invalid plan. No fallback plan was created. ${formatErrorMessage(error)}`);
  }
}

export async function revisePlanningPackage(options: RevisePlanOptions): Promise<BookPlan> {
  const targetPages = options.targetPages ?? sumChapterTargetPages(options.currentPlan.chapters);
  const toneProfile = options.toneProfile ?? "neutral";
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
              "For recurring characters, preserve or add concrete visualRules with stable silhouette, face, outfit, color palette, and distinctive details; illustration prompts must use exact recurring character names whenever those characters appear.",
              ...targetLanguageGenerationGuidance(options.language),
              ...(options.input ? kidsReadingGuidanceLines(options.input) : []),
              ...plannerToneGuidance(toneProfile)
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
      {
        ...revised,
        questions,
        researchNotes: mergeResearchNotes(options.currentPlan.researchNotes, revised.researchNotes)
      },
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
  const sourceChapters = plan.chapters.length > pageTarget ? mergeOverflowChapters(plan.chapters, pageTarget) : plan.chapters;
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

function mergeOverflowChapters(chapters: ChapterPlan[], chapterLimit: number): ChapterPlan[] {
  const kept = chapters.slice(0, chapterLimit);
  const overflow = chapters.slice(chapterLimit);
  const last = kept[kept.length - 1];
  if (!last || overflow.length === 0) {
    return kept;
  }

  const overflowSummaries = overflow
    .map((chapter) => `${chapter.title}: ${chapter.summary}`.trim())
    .filter(Boolean);
  const overflowBeats = overflow.flatMap((chapter) => [
    `Fold in ${chapter.title}.`,
    ...chapter.keyBeats
  ]);
  const overflowIllustrationPrompts = overflow.flatMap((chapter) => chapter.illustrationPrompts ?? []);

  return [
    ...kept.slice(0, -1),
    {
      ...last,
      summary: [last.summary, overflowSummaries.length ? `Also covers ${overflowSummaries.join(" ")}` : ""]
        .filter(Boolean)
        .join(" "),
      targetPages: last.targetPages + sumChapterTargetPages(overflow),
      keyBeats: [...last.keyBeats, ...overflowBeats].slice(0, 20),
      illustrationPrompts: [...(last.illustrationPrompts ?? []), ...overflowIllustrationPrompts].slice(0, 12)
    }
  ];
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
  const mobile = jsonRecord(jsonRecord(input.mediaSettings).mobile);
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

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
