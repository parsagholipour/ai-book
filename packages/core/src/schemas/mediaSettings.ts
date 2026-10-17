import { z } from "zod";
import { normalizeAlibabaModel } from "../adapters/alibabaModels.js";
import { normalizeGeminiImageModel } from "../adapters/geminiModels.js";
import { BOOK_CATEGORIES } from "../categories.js";
import { BOOK_GENERATION_STRATEGY_IDS } from "../generation/strategies/ids.js";
import { jsonRecord, jsonValueSchema, mediaSettingsMobileRecord } from "./jsonCoercion.js";

/**
 * Project input: mediaSettings, createProject, and the option enums they are
 * built from. Split out of book.ts; book.ts re-exports everything here, so
 * importers of "schemas/book.js" are unaffected.
 */

const ILLUSTRATION_CADENCES = ["template-driven", "every-page", "every-third-page", "manual"] as const;
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
export const bookGenerationStrategySelectionSchema = z.enum(["auto", ...BOOK_GENERATION_STRATEGY_IDS]);
export const textModelThinkingEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const modelTierSchema = z.enum(["fast", "balanced", "premium", "ultra"]);
export const textModelSelectionSchema = z.object({
  provider: z.enum(["deepseek", "deepinfra", "openrouter", "gemini", "alibaba", "openai", "openai-compatible"]),
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
  /**
   * Retired 2026-10-16: controls nothing. It used to ask for the compile's old
   * final review (and, through it, deferred pictures, the short-book path and
   * compact picture-book planning). The compile's one review is now the defect
   * screen, decided by the `finalBookQa` gate and the book's kind
   * (`usesCompileDefectScreen` in the worker). Stored rows keep the key; nothing
   * writes or reads it.
   */
  finalReview: z.boolean().optional(),
  /**
   * Print the reader-facing Sources list at the end of the book. Unset leaves
   * the automatic source-forward decision in place (SCIENCE, HEALTH, BIOGRAPHY,
   * HISTORY); false suppresses it; true prints it when citations exist. Read it
   * with `includeSourcesPreference` from the live project row, not from a plan
   * snapshot — see that helper.
   */
  includeSources: z.boolean().optional(),
  imageStyle: z.string().optional(),
  imageModel: imageModelSelectionSchema.optional(),
  generationStrategy: bookGenerationStrategySelectionSchema.optional(),
  /** Saved generation choice; keeps the original customer minimum across resumes. */
  generationPageCount: z.object({ requestedPages: z.number().int().positive(), selectedPages: z.number().int().positive() }).optional(),
  textModel: textModelSelectionSchema.optional(),
  /**
   * Quality tier used by the live operator-controlled text route. `textModel`
   * is retained only so older snapshots remain readable; it does not override
   * Quality-tab routing. Explicit imageModel selections still take precedence.
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
  // One character is a whole title in Chinese or Japanese (雪, 道), so the
  // floor is one; every surface that takes a title from a reader matches it,
  // since a stored title below this floor is a book no job can parse.
  title: z.string().min(1).max(160).optional(),
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

/**
 * Whether these `mediaSettings` describe a manuscript the reader brought in
 * rather than a book this pipeline wrote.
 *
 * Page 1 of an imported manuscript is the author's own opening sentence, and
 * the gate above is not advisory: a page it fails is FAILED_QA and a target of
 * the compile's repair, which model-redrafts the page in place. Nothing
 * generated that page — the writer instruction this check is the deterministic
 * twin of was never given to anyone for it — so a book that genuinely opens
 * "Have you ever wondered why your tap water tastes different in August?" would
 * have had the author's first line rewritten for breaking a rule it was never
 * held to. Provenance is `mediaSettings.mobile.import`, written when the import
 * creates the project and carried through `planInputSnapshot` into every plan
 * version's input snapshot, which is what `compileExport` reconstructs `input`
 * from. Only the opening gate is skipped; the rest of local QA still runs, and
 * the final page's `hasVagueEnding` is left exactly as it was.
 *
 * **The model reviewers ask this too** (`pagesReview.ts`), because an
 * exemption spelled only here handed the author's opening to the model that was
 * instructed to reject it, which is worse than no exemption at all.
 *
 * It takes the raw `mediaSettings` rather than a `CreateProjectInput` because
 * its consumers sit on both sides of that type: the page gates read it off an
 * input, while `projectSourceFromMediaSettings`
 * (`apps/api/src/mobile/projectSerializers.ts`) labels a book `"imported"` or
 * `"generated"` for the app straight off a project row, and used to read that
 * record with its own character-identical copy of this expression. One
 * predicate is the only way the app's label and the author's protection cannot
 * drift apart, and core is the leaf of the dependency graph, so this is the
 * direction the graph already allows. It lives here rather than beside either
 * consumer for that reason: provenance is a fact about `mediaSettings`, and a
 * page-QA module owning it made an app serializer import the prose gates.
 */
export function isImportedManuscript(mediaSettings: unknown): boolean {
  return Object.keys(jsonRecord(mediaSettingsMobileRecord(mediaSettings).import)).length > 0;
}

export const STUDIO_LAYOUTS = ["flow", "picture"] as const;
export const STUDIO_KINDS = ["story", "nonfiction", "picture", "other"] as const;
export type StudioLayout = (typeof STUDIO_LAYOUTS)[number];
export type StudioKind = (typeof STUDIO_KINDS)[number];

/**
 * Provenance of a book written in the Writing Studio, stored at
 * `mediaSettings.mobile.studio` when the Studio creates the project. Like the
 * import record it rides `planInputSnapshot` into every plan version, which is
 * how `compileExport` knows the author owns the text.
 */
export const studioSettingsSchema = z.object({
  layout: z.enum(STUDIO_LAYOUTS),
  kind: z.enum(STUDIO_KINDS),
  artStyle: z.string().max(400).optional(),
  createdAt: z.string(),
  /**
   * `"takeover"`: a generated book its owner moved into the Studio. Tolerant on
   * read — an unknown value must never fail the whole record, which would turn
   * the book back into a generated one.
   */
  origin: z.enum(["takeover"]).optional().catch(undefined)
});
export type StudioSettings = z.infer<typeof studioSettingsSchema>;

/** The Studio provenance record, or null for any other book. */
export function studioSettingsFromMediaSettings(mediaSettings: unknown): StudioSettings | null {
  const parsed = studioSettingsSchema.safeParse(mediaSettingsMobileRecord(mediaSettings).studio);
  return parsed.success ? parsed.data : null;
}

/** Whether this book was written in the Writing Studio. */
export function isStudioManuscript(mediaSettings: unknown): boolean {
  return studioSettingsFromMediaSettings(mediaSettings) !== null;
}

/**
 * Whether the author owns this book's text — it was imported or written in the
 * Studio rather than generated by this pipeline.
 *
 * Every rule that exists to protect an author's words from the generation
 * gates reads this, not `isImportedManuscript`: the opening-page rules, the PDF
 * page-count fitting, coverage review, the picture-book review paths, the
 * leak checks in the compiled markdown. `isImportedManuscript` stays for what is
 * really about the import (its style profile, the app's "imported" label).
 */
export function isAuthorManuscript(mediaSettings: unknown): boolean {
  return isImportedManuscript(mediaSettings) || isStudioManuscript(mediaSettings);
}

/** The Studio layout, or null when the book was not written in the Studio. */
export function studioLayoutFromMediaSettings(mediaSettings: unknown): StudioLayout | null {
  return studioSettingsFromMediaSettings(mediaSettings)?.layout ?? null;
}
