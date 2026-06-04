import type { JsonResult, ResearchAdapter, TextModelAdapter } from "../adapters/types.js";
import { targetLanguageGenerationGuidance, targetLanguagePayload } from "../prompting/language.js";
import { getTemplateForInput, makeFallbackPlan, type TemplateDefinition } from "../prompting/templates.js";
import { plannerToneGuidance, toneProfileFromMediaSettings } from "../prompting/tone.js";
import { bookPlanSchema, type BookPlan, type ChapterPlan, type CreateProjectInput, type ResearchSource, type ToneProfile } from "../schemas/book.js";
import { generateJsonWithJailbreak } from "./generateWithJailbreak.js";

export type CreatePlanOptions = {
  input: CreateProjectInput;
  textModel: TextModelAdapter;
  research: ResearchAdapter;
  forceFallback?: boolean;
};

export type RevisePlanOptions = {
  currentPlan: BookPlan;
  userMessage: string;
  textModel: TextModelAdapter;
  targetPages?: number;
  temperature?: number;
  lessCensored?: boolean;
  language?: string;
  toneProfile?: ToneProfile;
};

export type ExpandChapterResearchOptions = {
  input: CreateProjectInput;
  plan: BookPlan;
  research: ResearchAdapter;
  cap: number;
};

export async function createPlanningPackage(options: CreatePlanOptions): Promise<BookPlan> {
  const template = getTemplateForInput(options.input);
  const fallback = makeFallbackPlan(options.input);
  const researchNotes = await researchForPlan(options.input, template, fallback.researchQueries, options.research);
  const toneProfile = toneProfileFromMediaSettings(options.input.mediaSettings);

  if (options.forceFallback) {
    return normalizePlanPageTargets({ ...fallback, researchNotes }, options.input.targetPages);
  }

  let result: JsonResult<BookPlan>;
  try {
    result = await generateJsonWithJailbreak(options.textModel, {
      purpose: "plan-book",
      lessCensored: options.input.mediaSettings.lessCensored === true,
      jailbreakRole: "planner",
      temperature: Math.min(0.8, options.input.temperature),
      maxTokens: 8000,
      schema: bookPlanSchema,
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
            "Preserve concrete user intent and ask only questions that materially improve the result.",
            "For each question, include 2-4 concise premade answer options and allow a custom answer unless the question is informational only.",
            "For every recurring character, include concrete visualRules with stable silhouette, face, outfit, color palette, and distinctive details suitable for a reusable character reference sheet.",
            "Illustration prompts must use exact recurring character names whenever those characters appear.",
            ...targetLanguageGenerationGuidance(options.input.language),
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
              template,
              fallbackOutline: fallback,
              researchNotes
            },
            null,
            2
          )
        }
      ]
    });
  } catch (error) {
    if (shouldUsePlanningFallback(error)) {
      return normalizePlanPageTargets({ ...fallback, researchNotes }, options.input.targetPages);
    }
    throw new Error(`AI planner failed. No fallback plan was created. ${formatErrorMessage(error)}`);
  }

  try {
    const plan = bookPlanSchema.parse({
      ...result.data,
      researchNotes: [...researchNotes, ...result.data.researchNotes]
    });
    return normalizePlanPageTargets(plan, options.input.targetPages);
  } catch (error) {
    if (shouldUsePlanningFallback(error)) {
      return normalizePlanPageTargets({ ...fallback, researchNotes }, options.input.targetPages);
    }
    throw new Error(`AI planner returned an invalid plan. No fallback plan was created. ${formatErrorMessage(error)}`);
  }
}

export async function revisePlanningPackage(options: RevisePlanOptions): Promise<BookPlan> {
  const targetPages = options.targetPages ?? sumChapterTargetPages(options.currentPlan.chapters);
  const toneProfile = options.toneProfile ?? "neutral";
  try {
    const result = await generateJsonWithJailbreak(options.textModel, {
      purpose: "revise-plan",
      lessCensored: options.lessCensored === true,
      jailbreakRole: "planner",
      temperature: options.temperature ?? 0.4,
      maxTokens: 8000,
      schema: bookPlanSchema,
      messages: [
        {
          role: "system",
          content:
            [
              `Revise this book generation plan. Keep the same JSON schema and return the plan fields at the JSON root, not nested under plan, data, or result. Apply the user's requested changes directly and preserve useful existing decisions. Plan real book chapters, not one titled chapter or section per generated page. The sum of chapter targetPages must equal exactly ${targetPages}; do not create more chapters than targetPages. For factual, scientific, historical, or research-grounded books, preserve source-backed claims and uncertainty; do not invent studies, journals, institutes, experts, statistics, citations, or numeric findings. When the user answers planning questions, bake the answered decisions into the plan and remove or update questions that are now resolved. Treat skipped questions as no preference.`,
              "For recurring characters, preserve or add concrete visualRules with stable silhouette, face, outfit, color palette, and distinctive details; illustration prompts must use exact recurring character names whenever those characters appear.",
              ...targetLanguageGenerationGuidance(options.language),
              ...plannerToneGuidance(toneProfile)
            ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              currentPlan: options.currentPlan,
              userMessage: options.userMessage,
              toneProfile,
              language: targetLanguagePayload(options.language),
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
    return normalizePlanPageTargets(bookPlanSchema.parse(result.data), targetPages);
  } catch (error) {
    throw new Error(`AI plan revision failed. No revised plan was created. ${formatErrorMessage(error)}`);
  }
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

  return [
    ...kept.slice(0, -1),
    {
      ...last,
      summary: [last.summary, overflowSummaries.length ? `Also covers ${overflowSummaries.join(" ")}` : ""]
        .filter(Boolean)
        .join(" "),
      targetPages: last.targetPages + sumChapterTargetPages(overflow),
      keyBeats: [...last.keyBeats, ...overflowBeats].slice(0, 20)
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

function shouldUsePlanningFallback(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === "DeepSeekJsonValidationError" ||
    error.name === "DeepSeekJsonParseError" ||
    error.name === "ZodError" ||
    /\b(?:JSON validation|schema validation|invalid JSON|Model did not return a JSON object)\b/i.test(error.message)
  );
}
