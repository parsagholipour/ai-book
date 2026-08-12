import { MAX_APPEARANCE_LENGTH } from "@book-maker/core";
import { z } from "zod";
import { requestIdSchema } from "./schemas.js";

/**
 * Bodies for the library-character routes (`routes/characters.ts`), split out
 * of `schemas.ts` for the file-size budget. The OpenAPI fragments beside each
 * Zod schema feed Fastify's docs and must move together with them.
 */

export const LIBRARY_CHARACTER_LIMIT_PER_USER = 100;
export const LIBRARY_CHARACTER_NAME_MAX = 80;
export const LIBRARY_CHARACTER_DESCRIPTION_MAX = 2_000;
/**
 * Shared with the snapshot reader in core rather than restated: the same string
 * is capped here on the way in and again on the way out of
 * `mediaSettings.mobile.characters`, and a wider cap here would be silently
 * truncated there — mid-sentence, in the one field truncation is unsafe in.
 */
export const LIBRARY_CHARACTER_APPEARANCE_MAX = MAX_APPEARANCE_LENGTH;
export const LIBRARY_CHARACTER_FIELDS_MAX = 12;

/**
 * What the character looks like, in words. Empty clears it — and clearing is a
 * real choice rather than a no-op, because an absent appearance is what tells
 * every model downstream to describe nothing and defer to the reference image.
 */
const appearanceSchema = z.string().trim().max(LIBRARY_CHARACTER_APPEARANCE_MAX);

export const libraryCharacterFieldSchema = z
  .object({
    key: z.string().trim().min(1).max(40),
    value: z.string().trim().min(1).max(300)
  })
  .strict();

export const mobileCharacterCreateBodySchema = z
  .object({
    name: z.string().trim().min(1).max(LIBRARY_CHARACTER_NAME_MAX),
    description: z.string().trim().max(LIBRARY_CHARACTER_DESCRIPTION_MAX).default(""),
    appearance: appearanceSchema.default(""),
    fields: z.array(libraryCharacterFieldSchema).max(LIBRARY_CHARACTER_FIELDS_MAX).default([])
  })
  .strict();

export const mobileCharacterUpdateBodySchema = z
  .object({
    name: z.string().trim().min(1).max(LIBRARY_CHARACTER_NAME_MAX).optional(),
    description: z.string().trim().max(LIBRARY_CHARACTER_DESCRIPTION_MAX).optional(),
    appearance: appearanceSchema.optional(),
    fields: z.array(libraryCharacterFieldSchema).max(LIBRARY_CHARACTER_FIELDS_MAX).optional(),
    /**
     * Turns down the description read off the photo. It is a change on its own
     * — a user who dismisses a suggestion and edits nothing else must not get
     * "send at least one field".
     */
    dismissSuggestion: z.boolean().optional()
  })
  .strict()
  .refine(
    (body) =>
      body.name !== undefined ||
      body.description !== undefined ||
      body.appearance !== undefined ||
      body.fields !== undefined ||
      body.dismissSuggestion !== undefined,
    { message: "Send at least one field to update." }
  );

export const mobileCharacterPortraitBodySchema = z
  .object({
    requestId: requestIdSchema.optional()
  })
  .strict();

export const characterPhotoQuerySchema = z.object({
  filename: z.string().trim().min(1).max(300),
  mimeType: z.string().trim().max(160).optional()
});

/**
 * The path of a retained picture. Both ids are opaque to the client — the
 * filename is never one of them, and the lookup adds the owner as a third
 * predicate, so neither id can reach another user's file.
 */
export const characterImageParamsSchema = z.object({
  id: z.string().trim().min(1).max(64),
  imageId: z.string().trim().min(1).max(64)
});

const characterFieldOpenApi = {
  type: "object",
  additionalProperties: false,
  properties: {
    key: { type: "string", minLength: 1, maxLength: 40 },
    value: { type: "string", minLength: 1, maxLength: 300 }
  },
  required: ["key", "value"]
} as const;

export const mobileCharacterCreateOpenApiBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: LIBRARY_CHARACTER_NAME_MAX },
    description: { type: "string", maxLength: LIBRARY_CHARACTER_DESCRIPTION_MAX },
    appearance: { type: "string", maxLength: LIBRARY_CHARACTER_APPEARANCE_MAX },
    fields: { type: "array", items: characterFieldOpenApi, maxItems: LIBRARY_CHARACTER_FIELDS_MAX }
  },
  required: ["name"]
} as const;

export const mobileCharacterUpdateOpenApiBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: LIBRARY_CHARACTER_NAME_MAX },
    description: { type: "string", maxLength: LIBRARY_CHARACTER_DESCRIPTION_MAX },
    appearance: { type: "string", maxLength: LIBRARY_CHARACTER_APPEARANCE_MAX },
    fields: { type: "array", items: characterFieldOpenApi, maxItems: LIBRARY_CHARACTER_FIELDS_MAX },
    dismissSuggestion: { type: "boolean" }
  }
} as const;

export const mobileCharacterPortraitOpenApiBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    requestId: { type: "string", minLength: 8, maxLength: 64 }
  }
} as const;
