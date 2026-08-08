import { z } from "zod";
import { normalizeAlibabaModel } from "../adapters/alibabaModels.js";
import { normalizeGeminiImageModel } from "../adapters/geminiModels.js";
import { BOOK_CATEGORIES } from "../categories.js";
import { BOOK_GENERATION_STRATEGY_IDS } from "../generation/strategies/ids.js";

function unwrapJsonObject(keys: string[]) {
  return (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      const candidate = record[key];
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        return candidate;
      }
    }
    return value;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function numberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number") {
      return value;
    }
  }
  return undefined;
}

function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function arrayField(record: Record<string, unknown>, keys: string[]): unknown[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return undefined;
}

function recordField(record: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = record[key];
    if (isRecord(value)) {
      return value;
    }
  }
  return undefined;
}

function stringArrayField(record: Record<string, unknown>, keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return [value];
    }
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    }
  }
  return undefined;
}

function coerceStringArray(value: unknown): unknown {
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return value;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)])
);

const ILLUSTRATION_CADENCES = ["template-driven", "every-page", "manual"] as const;
type IllustrationCadence = (typeof ILLUSTRATION_CADENCES)[number];
export const TONE_PROFILES = ["neutral", "confident", "skeptical", "scholarly", "conversational", "narrative"] as const;

function isIllustrationCadence(value: string): value is IllustrationCadence {
  return (ILLUSTRATION_CADENCES as readonly string[]).includes(value);
}

function normalizeIllustrationCadence(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-");

  if (!normalized) {
    return undefined;
  }
  if (isIllustrationCadence(normalized)) {
    return normalized;
  }

  const words = normalized.replace(/-/g, " ");
  if (/(every|each|all|per) page|page by page|all pages/.test(words)) {
    return "every-page";
  }
  if (/manual|custom|on request|user selected|selected pages|specific pages|none|disabled/.test(words)) {
    return "manual";
  }
  if (/template|default|auto|automatic|standard|chapter|scene|milestone|periodic|selective|key moment/.test(words)) {
    return "template-driven";
  }

  return "template-driven";
}

export const illustrationCadenceSchema = z.preprocess(
  normalizeIllustrationCadence,
  z.enum(ILLUSTRATION_CADENCES).default("template-driven")
);

function summaryFromMarkdown(markdown: string | undefined): string {
  if (!markdown) {
    return "";
  }

  const plain = markdown
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (plain.length <= 240) {
    return plain;
  }

  const clipped = plain.slice(0, 240);
  const lastSpace = clipped.lastIndexOf(" ");
  const end = lastSpace > 160 ? lastSpace : 240;
  return `${clipped.slice(0, end).trim()}...`;
}

function normalizePageDraft(value: unknown): unknown {
  const unwrapped = unwrapJsonObject(["pageDraft", "draft", "page", "data", "result"])(value);
  if (!isRecord(unwrapped)) {
    return unwrapped;
  }

  const title = stringField(unwrapped, ["title", "pageTitle", "heading"]);
  const markdown = stringField(unwrapped, ["markdown", "body", "content", "text", "pageMarkdown"]);
  const summary = stringField(unwrapped, ["summary", "synopsis", "pageSummary"]);
  const imagePrompt = stringField(unwrapped, ["imagePrompt", "illustrationPrompt", "visualPrompt"]);

  return {
    title,
    markdown,
    summary: summary ?? summaryFromMarkdown(markdown),
    continuityNotes: stringArrayField(unwrapped, ["continuityNotes", "continuity"]) ?? [],
    ...(imagePrompt ? { imagePrompt } : {})
  };
}

function normalizePageProductionBeat(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  return {
    ...value,
    pageIndex: numberField(value, ["pageIndex", "pageNumber", "page", "index"]),
    chapterIndex: numberField(value, ["chapterIndex", "chapterNumber", "chapter"]) ?? 1,
    purpose: stringField(value, ["purpose", "goal", "objective"]),
    beat: stringField(value, ["beat", "action", "event", "description", "summary"]),
    requiredContinuity: arrayField(value, ["requiredContinuity", "continuity", "continuityNotes"]) ?? [],
    endingPressure: stringField(value, ["endingPressure", "nextPagePressure", "hook", "transition"]),
    imageMoment: stringField(value, ["imageMoment", "visualMoment", "imagePrompt"])
  };
}

function normalizeChapterBrief(value: unknown): unknown {
  const unwrapped = unwrapJsonObject(["chapterBrief", "brief", "productionBrief", "data", "result"])(value);
  if (!isRecord(unwrapped)) {
    return unwrapped;
  }

  const pageBeats = arrayField(unwrapped, ["pages", "pageBeats", "beats"]);
  if (!pageBeats) {
    return unwrapped;
  }

  const inferredChapterIndex =
    numberField(unwrapped, ["chapterIndex", "chapterNumber", "chapter"]) ??
    pageBeats.map((page) => (isRecord(page) ? numberField(page, ["chapterIndex", "chapterNumber", "chapter"]) : undefined)).find(Boolean) ??
    1;
  const firstPageIndex =
    pageBeats.map((page) => (isRecord(page) ? numberField(page, ["pageIndex", "pageNumber", "page", "index"]) : undefined)).find(Boolean) ??
    1;

  return {
    ...unwrapped,
    chapterIndex: inferredChapterIndex,
    title: stringField(unwrapped, ["title", "chapterTitle"]) ?? "",
    summary: stringField(unwrapped, ["summary", "chapterSummary"]) ?? "",
    pages: pageBeats.map((page, index) => {
      const pageRecord = isRecord(page) ? page : undefined;
      const normalized = normalizePageProductionBeat(page);
      if (!isRecord(normalized)) {
        return normalized;
      }
      return {
        ...normalized,
        chapterIndex: pageRecord
          ? numberField(pageRecord, ["chapterIndex", "chapterNumber", "chapter"]) ?? inferredChapterIndex
          : inferredChapterIndex,
        pageIndex: pageRecord
          ? numberField(pageRecord, ["pageIndex", "pageNumber", "page", "index"]) ?? firstPageIndex + index
          : firstPageIndex + index
      };
    }),
    continuityFocus: arrayField(unwrapped, ["continuityFocus", "continuity", "continuityNotes"]) ?? []
  };
}

function booleanField(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function normalizePageQualityReport(value: unknown): unknown {
  const unwrapped = unwrapJsonObject(["qualityReport", "report", "review", "data", "result"])(value);
  if (!isRecord(unwrapped)) {
    return unwrapped;
  }

  const approvedFromModel =
    typeof unwrapped.approved === "boolean"
      ? unwrapped.approved
      : typeof unwrapped.pass === "boolean"
        ? unwrapped.pass
        : undefined;

  const scoreFromModel = numberField(unwrapped, ["score", "qualityScore", "rating", "grade"]);
  const score =
    scoreFromModel ??
    (approvedFromModel === true ? 85 : approvedFromModel === false ? 45 : 70);

  let issues = stringArrayField(unwrapped, ["issues", "problems", "concerns", "flags"]) ?? [];
  let notes = stringField(unwrapped, ["notes", "summary", "rationale"]) ?? "";
  const feedback = stringField(unwrapped, ["feedback", "critique", "commentary", "review"]);
  if (issues.length === 0 && feedback) {
    if (approvedFromModel === false) {
      issues = [feedback];
    } else {
      notes = notes || feedback;
    }
  }

  const approved = approvedFromModel ?? score >= 75;
  const requiredRevisions =
    stringArrayField(unwrapped, [
      "requiredRevisions",
      "requiredRevision",
      "revisions",
      "fixes",
      "requiredFixes",
      "suggestions"
    ]) ?? [];

  const checksRecord = isRecord(unwrapped.checks)
    ? unwrapped.checks
    : isRecord(unwrapped.checklist)
      ? unwrapped.checklist
      : undefined;
  const checks = checksRecord
    ? {
        placeholderFree: booleanField(checksRecord, ["placeholderFree", "placeholder_free"]) ?? true,
        promptLeakFree: booleanField(checksRecord, ["promptLeakFree", "prompt_leak_free"]) ?? true,
        titleClean: booleanField(checksRecord, ["titleClean", "title_clean"]) ?? true,
        repetitionOk: booleanField(checksRecord, ["repetitionOk", "repetition_ok"]) ?? true,
        progressionOk: booleanField(checksRecord, ["progressionOk", "progression_ok"]) ?? true,
        styleNatural: booleanField(checksRecord, ["styleNatural", "style_natural", "naturalStyle", "natural_style"]) ?? true
      }
    : undefined;

  return {
    approved,
    score,
    issues,
    requiredRevisions,
    notes,
    ...(checks ? { checks } : {})
  };
}

function normalizeFinalBookQa(value: unknown): unknown {
  const unwrapped = unwrapJsonObject(["finalBookQa", "finalQa", "qa", "report", "data", "result"])(value);
  if (!isRecord(unwrapped)) {
    return unwrapped;
  }

  const approvedFromModel = typeof unwrapped.approved === "boolean" ? unwrapped.approved : undefined;
  const scoreFromModel = numberField(unwrapped, ["score", "qualityScore", "rating", "grade"]);
  const score =
    scoreFromModel ??
    (approvedFromModel === true ? 85 : approvedFromModel === false ? 45 : 70);

  let issues =
    stringArrayField(unwrapped, ["issues", "problems", "concerns", "flags", "reasons", "rejectionReasons"]) ?? [];
  let notes = stringField(unwrapped, ["notes", "summary", "rationale"]) ?? "";
  const feedback = stringField(unwrapped, ["feedback", "critique", "commentary", "review"]);
  if (issues.length === 0 && feedback) {
    if (approvedFromModel === false) {
      issues = [feedback];
    } else {
      notes = notes || feedback;
    }
  }

  const approved = approvedFromModel ?? score >= 75;
  const requiredFixes =
    stringArrayField(unwrapped, [
      "requiredFixes",
      "requiredFix",
      "requiredRevisions",
      "revisions",
      "fixes",
      "suggestions"
    ]) ?? [];

  return {
    approved,
    score,
    issues,
    requiredFixes,
    notes
  };
}

const PLAN_WRAPPER_KEYS = ["plan", "bookPlan", "planningPackage", "outline", "data", "result"] as const;
const PLANNER_RECOVERY_WRAPPER_KEYS = [...PLAN_WRAPPER_KEYS, "generationPlan"] as const;

function isPlanLikeRecord(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    (typeof value.title === "string" ||
      typeof value.premise === "string" ||
      typeof value.audience === "string" ||
      Array.isArray(value.chapters) ||
      isRecord(value.illustrationPlan))
  );
}

function mergePlanRecords(
  fallback: Record<string, unknown> | undefined,
  candidate: Record<string, unknown>
): Record<string, unknown> {
  if (!fallback) {
    return candidate;
  }

  const merged = { ...fallback };
  for (const [key, value] of Object.entries(candidate)) {
    if (value === undefined || value === null) {
      continue;
    }
    const fallbackValue = merged[key];
    // Plan revisions are patches. Objects may be emitted field-by-field, while
    // arrays are intentional atomic replacements (chapter order and question
    // deletion would otherwise be ambiguous).
    merged[key] = isRecord(fallbackValue) && isRecord(value)
      ? mergePlanRecords(fallbackValue, value)
      : value;
  }
  return merged;
}

function normalizePlanScalarArrays(value: Record<string, unknown>): Record<string, unknown> {
  return {
    ...value,
    voiceGuide: coerceStringArray(value.voiceGuide),
    antiAiRules: coerceStringArray(value.antiAiRules)
  };
}

function normalizeBookPlan(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const fallbackOutline = recordField(value, ["fallbackOutline", "fallbackPlan"]);
  const nestedPlan = recordField(value, [...PLAN_WRAPPER_KEYS]);
  const unwrapped = isPlanLikeRecord(value)
    ? value
    : isPlanLikeRecord(nestedPlan)
      ? mergePlanRecords(isPlanLikeRecord(fallbackOutline) ? fallbackOutline : undefined, nestedPlan)
    : isPlanLikeRecord(fallbackOutline)
      ? fallbackOutline
      : unwrapJsonObject([...PLAN_WRAPPER_KEYS])(value);
  if (!isRecord(unwrapped)) {
    return unwrapped;
  }

  return normalizePlanScalarArrays({
    ...unwrapped,
    writingComplexity:
      unwrapped.writingComplexity ??
      unwrapped.complexity ??
      unwrapped.writing_complexity ??
      unwrapped.writingLevel ??
      unwrapped.readingLevel
  });
}

function normalizeBookPlanWithFallback(fallback: BookPlan) {
  return (value: unknown): unknown => {
    if (!isRecord(value)) {
      return value;
    }

    const fallbackRecord = fallback as unknown as Record<string, unknown>;
    const outer = { ...value };
    const nestedPlan = recordField(value, [...PLANNER_RECOVERY_WRAPPER_KEYS]);
    for (const key of PLANNER_RECOVERY_WRAPPER_KEYS) {
      delete outer[key];
    }

    const candidate = isPlanLikeRecord(nestedPlan)
      ? mergePlanRecords(mergePlanRecords(fallbackRecord, outer), nestedPlan)
      : isPlanLikeRecord(value)
        ? mergePlanRecords(fallbackRecord, value)
        : mergePlanRecords(fallbackRecord, outer);

    return normalizeBookPlan(candidate);
  };
}

function normalizeImageModelSelectionInput(value: unknown): unknown {
  if (typeof value === "string") {
    const model = value.trim();
    return model ? { provider: "gemini", model } : value;
  }
  return value;
}

export const categorySchema = z.enum(BOOK_CATEGORIES);
export const subcategorySchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") {
      return value;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  },
  z.string().max(80).optional()
);
export const bookGenerationStrategyIdSchema = z.enum(BOOK_GENERATION_STRATEGY_IDS);
export const bookGenerationStrategySelectionSchema = z.enum(["auto", ...BOOK_GENERATION_STRATEGY_IDS]);
export const textModelThinkingEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "max"]);
export const modelTierSchema = z.enum(["fast", "balanced", "premium"]);
export const textModelSelectionSchema = z.object({
  provider: z.enum(["deepseek", "deepinfra", "gemini", "alibaba", "openai-compatible"]),
  model: z.string().min(1).max(120),
  thinkingBudget: z.number().int().min(-1).max(32768).optional(),
  thinkingEnabled: z.boolean().optional(),
  thinkingEffort: textModelThinkingEffortSchema.optional()
});
export const imageModelSelectionSchema = z.preprocess(
  normalizeImageModelSelectionInput,
  z
    .object({
      provider: z.enum(["gemini", "alibaba"]),
      model: z.string().min(1).max(120)
    })
    .transform((selection) => ({
      provider: selection.provider,
      model:
        selection.provider === "gemini"
          ? normalizeGeminiImageModel(selection.model)
          : normalizeAlibabaModel(selection.model)
    }))
);
export const coverTemplateIdSchema = z.enum([
  "auto",
  "kids",
  "science",
  "fiction",
  "minimal",
  "business",
  "self-help",
  "romance"
]);
/**
 * Where a book's cover artwork comes from. Read it with `coverArtSourceFor`
 * rather than off the settings directly — the legacy `includeCover` flag is
 * still the only thing older rows carry.
 */
export const coverArtSourceSchema = z.enum(["ai", "design", "none"]);
export const toneProfileSchema = z.enum(TONE_PROFILES).default("neutral");
export const AUDIENCE_AGE_RANGES = ["2-4", "4-6", "6-8"] as const;
export const audienceAgeRangeSchema = z.enum(AUDIENCE_AGE_RANGES);

export const mediaSettingsSchema = z.object({
  fullIllustrations: z.boolean().default(true),
  illustrationCadence: illustrationCadenceSchema,
  includeCover: z.boolean().default(true),
  /**
   * Supersedes `includeCover`, which only says whether the cover was drawn by a
   * model. Unset falls back to it, so `false` means a designed cover rather
   * than no cover at all — see `coverArtSourceFor`.
   */
  coverArtSource: coverArtSourceSchema.optional(),
  coverTemplate: coverTemplateIdSchema.default("auto"),
  finalReview: z.boolean().default(true),
  /**
   * Print the reader-facing Sources list at the end of the book. Unset leaves
   * the automatic per-category decision in place; false suppresses it. Read it
   * with `includeSourcesPreference` from the live project row, not from a plan
   * snapshot — see that helper.
   */
  includeSources: z.boolean().optional(),
  imageStyle: z.string().optional(),
  imageModel: imageModelSelectionSchema.optional(),
  generationStrategy: bookGenerationStrategySelectionSchema.optional(),
  textModel: textModelSelectionSchema.optional(),
  /**
   * Quality tier that routes prose vs mechanical generation phases to
   * different models. Explicit textModel/imageModel selections take
   * precedence; unset keeps the legacy single-model behavior.
   */
  modelTier: modelTierSchema.optional(),
  audienceAgeRange: audienceAgeRangeSchema.optional(),
  toneProfile: toneProfileSchema,
  /**
   * Draft sequential-strategy pages in parallel waves and reconcile continuity
   * in the final review. Defaults to on for non-fiction categories and off for
   * fiction (STORY / KIDS) when unset.
   */
  parallelPageGeneration: z.boolean().optional(),
  /**
   * Best-of-N drafting (pro quality toggle): sample this many page drafts at
   * staggered temperatures and let a judge model pick the strongest one.
   * 1 (default) keeps single-draft generation.
   */
  draftCandidates: z.coerce.number().int().min(1).max(3).optional(),
  mobile: jsonValueSchema.optional()
});

/**
 * Ceiling for a project prompt, whether a client typed it or the server
 * composed it. The worker budgets its own planner additions against this, so
 * anything that builds a prompt reads it from here rather than restating it.
 */
export const PROJECT_PROMPT_MAX_LENGTH = 20000;

export const createProjectSchema = z.object({
  title: z.string().min(2).max(160).optional(),
  subtitle: z.string().max(180).optional(),
  authorName: z.string().max(120).optional(),
  coverTagline: z.string().max(180).optional(),
  prompt: z.string().min(10).max(PROJECT_PROMPT_MAX_LENGTH),
  category: categorySchema.default("STORY"),
  subcategory: subcategorySchema,
  targetPages: z.coerce.number().int().min(1).max(600).default(40),
  complexity: z.coerce.number().int().min(1).max(10).default(5),
  temperature: z.coerce.number().min(0).max(2).default(0.8),
  language: z.string().min(2).max(40).default("en"),
  templateSlug: z.string().optional(),
  mediaSettings: mediaSettingsSchema.default({
    fullIllustrations: true,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral"
  })
});

export const chapterPlanSchema = z.object({
  index: z.number().int().positive(),
  title: z.string(),
  summary: z.string(),
  targetPages: z.number().int().positive(),
  keyBeats: z.array(z.string()).default([]),
  illustrationPrompts: z.array(z.string()).optional()
});

function normalizeCharacter(value: unknown): unknown {
  if (typeof value === "string" && value.trim()) {
    return {
      name: value.trim(),
      role: "Supporting character",
      description: "Recurring character in the plan.",
      traits: [],
      visualRules: []
    };
  }
  if (!isRecord(value)) {
    return value;
  }

  const role = stringField(value, [
    "role",
    "storyRole",
    "characterRole",
    "narrativeRole",
    "function",
    "archetype",
    "relationship"
  ]);
  const description = stringField(value, ["description", "summary", "bio", "profile", "backstory", "notes"]);

  return {
    ...value,
    name: stringField(value, ["name", "characterName", "fullName"]) ?? "Unnamed character",
    role: role?.trim() || "Supporting character",
    description: description?.trim() || "Recurring character in the plan.",
    traits: stringArrayField(value, ["traits", "personality", "personalityTraits", "qualities"]) ?? [],
    visualRules: stringArrayField(value, ["visualRules", "visual_rules", "appearance", "visualDescription", "visual", "design"]) ?? []
  };
}

export const characterSchema = z.preprocess(
  normalizeCharacter,
  z.object({
    name: z.string(),
    role: z.string(),
    description: z.string(),
    traits: z.array(z.string()).default([]),
    visualRules: z.array(z.string()).default([])
  })
);

export const locationSchema = z.object({
  name: z.string(),
  description: z.string(),
  rules: z.array(z.string()).default([])
});

export const illustrationPlanSchema = z.object({
  cadence: illustrationCadenceSchema,
  globalStyle: z.string(),
  coverPrompt: z.string().optional(),
  characterReferencePrompts: z.array(z.string()).default([]),
  pageRules: z.array(z.string()).default([])
});

function normalizeResearchSource(value: unknown): unknown {
  if (typeof value === "string") {
    return {
      query: "planner-note",
      title: "Planner research note",
      summary: value.trim()
    };
  }
  if (!isRecord(value)) {
    return value;
  }

  const query = stringField(value, ["query", "searchQuery", "topic"]);
  const title = stringField(value, ["title", "source", "name"]);
  const summary = stringField(value, ["summary", "note", "notes", "body", "description", "content", "text"]);
  const url = stringField(value, ["url", "link", "sourceUrl"]);
  const publishedAt = stringField(value, ["publishedAt", "published_at", "date"]);

  return {
    ...value,
    query: query?.trim() || "planner-note",
    title: title?.trim() || "Planner research note",
    url: url?.trim() || undefined,
    summary: summary?.trim() || title?.trim() || "",
    publishedAt: publishedAt?.trim() || undefined
  };
}

export const researchSourceSchema = z.preprocess(
  normalizeResearchSource,
  z.object({
    query: z.string(),
    title: z.string(),
    url: z.string().url().optional(),
    summary: z.string(),
    publishedAt: z.string().optional()
  })
);

/**
 * How many of the offered answers the reader may pick. A question the reader can
 * honestly answer with several options ("which of these themes?") used to arrive
 * as `choice`, so the app sent the first tap and dropped the rest; the model
 * worked around it by listing the options inside the prompt text and asking for
 * a typed answer. `multi` is that question declared honestly.
 *
 * Fewer than two options is `open` whatever the model says: one choice is not a
 * choice, so the reader types the value instead of tapping an invented answer.
 */
function planQuestionAnswerKind(value: Record<string, unknown>, options: string[]): "choice" | "multi" | "open" {
  if (options.length < 2) {
    return "open";
  }
  const declared = stringField(value, ["answerKind", "answerType"])?.trim().toLowerCase();
  const multiple = booleanField(value, ["multiSelect", "multiple", "allowMultiple", "selectMultiple"]);
  return multiple === true || declared === "multi" || declared === "multiple" ? "multi" : "choice";
}

export const planQuestionSchema = z.preprocess(
  (value) => {
    if (typeof value === "string") {
      return {
        prompt: value,
        options: [],
        answerKind: "open",
        allowCustom: true
      };
    }
    if (!isRecord(value)) {
      return value;
    }

    const options = stringArrayField(value, ["options", "suggestedAnswers", "answers", "choices", "premadeAnswers"]) ?? [];
    const answerKind = planQuestionAnswerKind(value, options);
    return {
      ...value,
      prompt: stringField(value, ["prompt", "question", "text"]),
      options,
      answerKind,
      // An open question with `allowCustom: false` renders no options and no
      // text box on either picker — unanswerable except by Skip — so open
      // always allows typing, whatever the model said.
      allowCustom: answerKind === "open" ? true : booleanField(value, ["allowCustom", "customAnswer", "custom"]) ?? true
    };
  },
  z.object({
    prompt: z.string(),
    options: z.array(z.string()).default([]),
    answerKind: z.enum(["choice", "multi", "open"]).default("open"),
    allowCustom: z.boolean().default(true)
  })
);

const bookPlanObjectSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  premise: z.string(),
  audience: z.string(),
  writingComplexity: z.coerce.number().int().min(1).max(10),
  voiceGuide: z.array(z.string()).min(1),
  antiAiRules: z.array(z.string()).min(1),
  questions: z.array(planQuestionSchema).default([]),
  chapters: z.array(chapterPlanSchema).min(1),
  characters: z.array(characterSchema).default([]),
  locations: z.array(locationSchema).default([]),
  continuityRules: z.array(z.string()).default([]),
  researchQueries: z.array(z.string()).default([]),
  researchNotes: z.array(researchSourceSchema).default([]),
  illustrationPlan: illustrationPlanSchema
});

export const bookPlanSchema = z.preprocess(normalizeBookPlan, bookPlanObjectSchema);

export function bookPlanSchemaWithFallback(fallback: BookPlan) {
  return z.preprocess(normalizeBookPlanWithFallback(fallback), bookPlanObjectSchema);
}

/**
 * Initial planning treats research as trusted server-owned context. Omitting it
 * from the model-facing schema prevents structured-output providers from
 * reproducing the source package in their response; the planner attaches the
 * original notes after this schema has parsed the creative plan fields.
 */
export function bookPlanModelOutputSchemaWithFallback(fallback: BookPlan) {
  return z.preprocess(
    normalizeBookPlanWithFallback(fallback),
    bookPlanObjectSchema.omit({ researchNotes: true })
  );
}

export const pageDraftSchema = z.preprocess(
  normalizePageDraft,
  z.object({
    title: z.string(),
    markdown: z
      .string()
      .refine((value) => value.trim().length > 0, { message: "Page markdown must not be empty." }),
    summary: z.string(),
    continuityNotes: z.array(z.string()).default([]),
    imagePrompt: z.string().optional()
  })
);

export const pageProductionBeatSchema = z.preprocess(
  normalizePageProductionBeat,
  z.object({
    pageIndex: z.number().int().positive(),
    chapterIndex: z.number().int().positive(),
    purpose: z.string(),
    beat: z.string(),
    requiredContinuity: z.array(z.string()).default([]),
    endingPressure: z.string(),
    imageMoment: z.string().optional()
  })
);

export const chapterBriefSchema = z.preprocess(
  normalizeChapterBrief,
  z.object({
    chapterIndex: z.number().int().positive(),
    title: z.string(),
    summary: z.string(),
    pages: z.array(pageProductionBeatSchema).min(1),
    continuityFocus: z.array(z.string()).default([])
  })
);

export const pageQualityReportSchema = z.preprocess(
  normalizePageQualityReport,
  z.object({
    approved: z.boolean(),
    score: z.number().int().min(0).max(100),
    issues: z.array(z.string()).default([]),
    requiredRevisions: z.array(z.string()).default([]),
    notes: z.string().default(""),
    checks: z
      .object({
        placeholderFree: z.boolean(),
        promptLeakFree: z.boolean(),
        titleClean: z.boolean(),
        repetitionOk: z.boolean(),
        progressionOk: z.boolean(),
        styleNatural: z.boolean()
      })
      .default({
        placeholderFree: true,
        promptLeakFree: true,
        titleClean: true,
        repetitionOk: true,
        progressionOk: true,
        styleNatural: true
      })
  })
);

export const finalBookQaSchema = z.preprocess(
  normalizeFinalBookQa,
  z.object({
    approved: z.boolean(),
    score: z.number().int().min(0).max(100),
    issues: z.array(z.string()).default([]),
    requiredFixes: z.array(z.string()).default([]),
    notes: z.string().default("")
  })
);

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type MediaSettings = z.infer<typeof mediaSettingsSchema>;
export type TextModelThinkingEffort = z.infer<typeof textModelThinkingEffortSchema>;
export type ModelTier = z.infer<typeof modelTierSchema>;
export type TextModelSelection = z.infer<typeof textModelSelectionSchema>;
export type ImageModelSelection = z.infer<typeof imageModelSelectionSchema>;
export type CoverTemplateId = z.infer<typeof coverTemplateIdSchema>;
export type AudienceAgeRange = z.infer<typeof audienceAgeRangeSchema>;
export type ToneProfile = z.infer<typeof toneProfileSchema>;
export type BookPlan = z.infer<typeof bookPlanSchema>;
export type ChapterPlan = z.infer<typeof chapterPlanSchema>;
export type PageDraft = z.infer<typeof pageDraftSchema>;
export type ResearchSource = z.infer<typeof researchSourceSchema>;
export type PageProductionBeat = z.infer<typeof pageProductionBeatSchema>;
export type ChapterBrief = z.infer<typeof chapterBriefSchema>;
export type PageQualityReport = z.infer<typeof pageQualityReportSchema>;
export type FinalBookQa = z.infer<typeof finalBookQaSchema>;
