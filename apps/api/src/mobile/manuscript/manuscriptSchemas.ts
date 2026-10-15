import { AUTHOR_ASSIST_LIMITS, QUICK_AUTHOR_ASSIST_KINDS, REWRITE_PRESETS, STUDIO_KINDS, STUDIO_LAYOUTS } from "@book-maker/core";
import { z } from "zod";
import { requestIdSchema, toOpenApiRequestBody } from "../schemas.js";
import { MANUSCRIPT_CAST_LIMIT } from "./manuscriptStore.js";

/**
 * Request bodies of the Writing Studio routes, each with the JSON-schema copy
 * Fastify's OpenAPI output reads. There is no generator between the two, so
 * they change together (`src/mobile/CLAUDE.md`, "Adding a route").
 */

/** The ceilings the spec names; the app enforces the same ones before it sends. */
export const MANUSCRIPT_TITLE_MAX = 160;
export const MANUSCRIPT_CHAPTER_TITLE_MAX = 200;
export const MANUSCRIPT_CHAPTER_MARKDOWN_MAX = 200_000;
export const MANUSCRIPT_CHAPTER_NOTES_MAX = 20_000;
export const MANUSCRIPT_CHAPTER_LIMIT = 300;
/** The same cap the character photos take; a picture book is many of these. */
export const MANUSCRIPT_IMAGE_MAX_BYTES = 15 * 1024 * 1024;

const chapterStatusSchema = z.enum(["idea", "drafting", "revised", "final"]);

/**
 * A book title. `createProjectSchema` — which the worker parses every project
 * through — takes one character and up (a whole title in CJK), so the route
 * refuses only an empty one rather than storing a book no job can read.
 */
const bookTitleSchema = z.string().trim().min(1).max(MANUSCRIPT_TITLE_MAX);

export const studioProjectCreateBodySchema = z
  .object({
    // Empty means "Untitled book" rather than a validation error: the start
    // sheet's title field is optional.
    title: z.string().trim().max(MANUSCRIPT_TITLE_MAX).optional(),
    kind: z.enum(STUDIO_KINDS),
    language: z.string().trim().min(2).max(40).optional(),
    requestId: requestIdSchema
  })
  .strict();
export const studioProjectCreateOpenApiBody = toOpenApiRequestBody(studioProjectCreateBodySchema);

export const manuscriptChapterSaveBodySchema = z
  .object({
    title: z.string().max(MANUSCRIPT_CHAPTER_TITLE_MAX),
    markdown: z.string().max(MANUSCRIPT_CHAPTER_MARKDOWN_MAX),
    notes: z.string().max(MANUSCRIPT_CHAPTER_NOTES_MAX).optional(),
    status: chapterStatusSchema.optional(),
    baseRevision: z.number().int().min(1),
    checkpoint: z.enum(["before_ai", "restore"]).optional(),
    resolveConflict: z.enum(["mine", "book"]).optional()
  })
  .strict();
export const manuscriptChapterSaveOpenApiBody = toOpenApiRequestBody(manuscriptChapterSaveBodySchema);

export const manuscriptChapterCreateBodySchema = z
  .object({
    // Absent appends at the end; null opens the book with it.
    afterChapterId: z.string().trim().min(1).max(128).nullable().optional(),
    title: z.string().trim().max(MANUSCRIPT_CHAPTER_TITLE_MAX).optional(),
    requestId: requestIdSchema
  })
  .strict();
export const manuscriptChapterCreateOpenApiBody = toOpenApiRequestBody(manuscriptChapterCreateBodySchema);

export const manuscriptOrderBodySchema = z
  .object({ chapterIds: z.array(z.string().trim().min(1).max(128)).min(1).max(MANUSCRIPT_CHAPTER_LIMIT) })
  .strict();
export const manuscriptOrderOpenApiBody = toOpenApiRequestBody(manuscriptOrderBodySchema);

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const manuscriptSettingsBodySchema = z
  .object({
    title: bookTitleSchema.optional(),
    subtitle: optionalText(180),
    authorName: optionalText(120),
    dedication: optionalText(2000),
    // The same bound `studioSettingsSchema` holds the provenance record to.
    artStyle: optionalText(400),
    goalWords: z.number().int().min(1).max(2_000_000).nullable().optional(),
    layout: z.enum(STUDIO_LAYOUTS).optional(),
    // Library character ids; every one must be the caller's (400 UNKNOWN_CHARACTER).
    castCharacterIds: z.array(z.string().trim().min(1).max(128)).max(MANUSCRIPT_CAST_LIMIT).optional()
  })
  .strict();
export const manuscriptSettingsOpenApiBody = toOpenApiRequestBody(manuscriptSettingsBodySchema);

export const manuscriptPublishBodySchema = z
  .object({ requestId: requestIdSchema, dryRun: z.boolean().optional() })
  .strict();
export const manuscriptPublishOpenApiBody = toOpenApiRequestBody(manuscriptPublishBodySchema);

const chapterIdSchema = z.string().trim().min(1).max(128);

/**
 * `POST /manuscript/assist`. The text bounds are the runner's own
 * (`AUTHOR_ASSIST_LIMITS`), so the route refuses exactly what the runner
 * would, before a message slot is taken.
 */
export const manuscriptQuickAssistBodySchema = z
  .object({
    kind: z.enum(QUICK_AUTHOR_ASSIST_KINDS),
    chapterId: chapterIdSchema,
    selection: z.string().max(AUTHOR_ASSIST_LIMITS.selectionChars).optional(),
    before: z.string().max(AUTHOR_ASSIST_LIMITS.beforeChars).optional(),
    after: z.string().max(AUTHOR_ASSIST_LIMITS.afterChars).optional(),
    preset: z.enum(REWRITE_PRESETS).optional(),
    instruction: z.string().max(AUTHOR_ASSIST_LIMITS.instructionChars).optional(),
    requestId: requestIdSchema
  })
  .strict();
export const manuscriptQuickAssistOpenApiBody = toOpenApiRequestBody(manuscriptQuickAssistBodySchema);

export const LONG_ASSIST_KINDS = ["illustrate", "draft_chapter", "chapter_feedback", "consistency", "outline"] as const;

/** The drafter's own range (`clampTargetWords`), so the price is for the draft that is written. */
export const DRAFT_TARGET_WORDS_MIN = 300;
export const DRAFT_TARGET_WORDS_MAX = 4000;

/** `POST /manuscript/assists`. */
export const manuscriptAssistCreateBodySchema = z
  .object({
    kind: z.enum(LONG_ASSIST_KINDS),
    chapterId: chapterIdSchema.optional(),
    prompt: z.string().trim().max(1200).optional(),
    passage: z.string().max(4000).optional(),
    // Draft notes, or — for an outline — what the book is about.
    notes: z.string().max(AUTHOR_ASSIST_LIMITS.draftNotesChars).optional(),
    targetWords: z.number().int().min(DRAFT_TARGET_WORDS_MIN).max(DRAFT_TARGET_WORDS_MAX).optional(),
    requestId: requestIdSchema
  })
  .strict();
export const manuscriptAssistCreateOpenApiBody = toOpenApiRequestBody(manuscriptAssistCreateBodySchema);

export const manuscriptAssistListQuerySchema = z.object({
  open: z.enum(["1", "0", "true", "false"]).optional(),
  chapterId: chapterIdSchema.optional()
});

export const manuscriptAssistParamsSchema = z.object({ id: z.string().min(1), aid: z.string().min(1) });

/** `POST /manuscript/cover/generate` and `POST /manuscript/from-plan`: a requestId and nothing else. */
export const manuscriptRequestBodySchema = z.object({ requestId: requestIdSchema }).strict();
export const manuscriptRequestOpenApiBody = toOpenApiRequestBody(manuscriptRequestBodySchema);

export const manuscriptImageQuerySchema = z.object({
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(3).max(160).optional()
});

export const manuscriptChapterParamsSchema = z.object({ id: z.string().min(1), cid: z.string().min(1) });
export const manuscriptVersionParamsSchema = z.object({
  id: z.string().min(1),
  cid: z.string().min(1),
  vid: z.string().min(1)
});

export type ManuscriptChapterSaveBody = z.infer<typeof manuscriptChapterSaveBodySchema>;
export type ManuscriptChapterCreateBody = z.infer<typeof manuscriptChapterCreateBodySchema>;
export type ManuscriptSettingsBody = z.infer<typeof manuscriptSettingsBodySchema>;
export type ManuscriptQuickAssistBody = z.infer<typeof manuscriptQuickAssistBodySchema>;
export type ManuscriptAssistCreateBody = z.infer<typeof manuscriptAssistCreateBodySchema>;
