import { z } from "zod";
import { contentRestrictedError } from "../../contentRestrictions.js";
import { mobileAuthError, toOpenApiRequestBody } from "../schemas.js";

/** The longest note a share may carry, counted after trimming. */
export const SHARE_CAPTION_MAX_CHARS = 500;

/**
 * `PUT /api/mobile/projects/:id/share` — create, update in place, or re-share
 * after a revoke. The caption is parsed wide (2,000) and bounded at 500 by the
 * handler, so an over-long note answers its own `CAPTION_TOO_LONG` sentence
 * rather than a generic validation error.
 *
 * `rightsConfirmed` is required whenever the request would make a share live
 * that is not live now; `likenessConfirmed` whenever the book shows someone
 * drawn from a real photo and no live share has recorded it. `acceptExportUnlock`
 * is the author's yes to the PDF unlock price for a FULL share of a locked book —
 * without it the handler refuses rather than charging.
 */
export const shareBodySchema = z
  .object({
    mode: z.enum(["preview", "full"]),
    previewPages: z.number().int().min(1).max(10_000).optional(),
    caption: z.string().max(2_000).nullable().optional(),
    showAuthorName: z.boolean().default(false),
    rightsConfirmed: z.boolean().optional(),
    likenessConfirmed: z.boolean().optional(),
    acceptExportUnlock: z.boolean().optional()
  })
  .strict();

export type ShareBody = z.infer<typeof shareBodySchema>;

export const shareOpenApiBody = toOpenApiRequestBody(shareBodySchema);

export const shareSlugParamsSchema = z.object({ slug: z.string().min(1).max(64) });

/**
 * A 402 on the share route is one of two things, and both bodies must survive
 * the serializer: the unlock the author has not agreed to yet (`creditsRequired`)
 * and the unlock they could not afford (`INSUFFICIENT_CREDITS`'s three numbers).
 */
export const shareUnlockError = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        creditsRequired: { type: "integer" },
        requiredCredits: { type: "integer" },
        availableCredits: { type: "integer" },
        reservedCredits: { type: "integer" }
      },
      required: ["code", "message"]
    }
  },
  required: ["error"]
} as const;

/** Every refused note and every refused book text carries `reason`. */
export const shareRefusalError = contentRestrictedError;

export const shareRouteErrors = {
  400: mobileAuthError,
  401: mobileAuthError,
  402: shareUnlockError,
  404: mobileAuthError,
  409: mobileAuthError,
  422: shareRefusalError,
  429: mobileAuthError
} as const;
