import { z } from "zod";
import { normalizeAlibabaModel } from "../adapters/alibabaModels.js";
import { normalizeGeminiImageModel } from "../adapters/geminiModels.js";
import { BOOK_CATEGORIES } from "../categories.js";
import { BOOK_GENERATION_STRATEGY_IDS } from "../generation/strategies/ids.js";
import { jsonValueSchema } from "./jsonCoercion.js";

/**
 * Project input: mediaSettings, createProject, and the option enums they are
 * built from. Split out of book.ts; book.ts re-exports everything here, so
 * importers of "schemas/book.js" are unaffected.
 */

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

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type MediaSettings = z.infer<typeof mediaSettingsSchema>;
export type TextModelThinkingEffort = z.infer<typeof textModelThinkingEffortSchema>;
export type ModelTier = z.infer<typeof modelTierSchema>;
export type TextModelSelection = z.infer<typeof textModelSelectionSchema>;
export type ImageModelSelection = z.infer<typeof imageModelSelectionSchema>;
export type CoverTemplateId = z.infer<typeof coverTemplateIdSchema>;
export type AudienceAgeRange = z.infer<typeof audienceAgeRangeSchema>;
export type ToneProfile = z.infer<typeof toneProfileSchema>;
