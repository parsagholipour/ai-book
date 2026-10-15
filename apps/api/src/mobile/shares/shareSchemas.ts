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
 * drawn from a real photo and no live share has recorded it.
 * `acceptExportUnlock` is accepted and ignored: it was the author's yes to the
 * PDF unlock price of a FULL share, and no book carries an unlock any more
 * (2026-10-15), but installed builds still send it.
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

/** Every refused note and every refused book text carries `reason`. */
export const shareRefusalError = contentRestrictedError;

export const shareRouteErrors = {
  400: mobileAuthError,
  401: mobileAuthError,
  403: mobileAuthError,
  404: mobileAuthError,
  409: mobileAuthError,
  422: shareRefusalError,
  429: mobileAuthError
} as const;
