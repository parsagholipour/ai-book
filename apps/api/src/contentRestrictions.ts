import type { FastifyReply } from "fastify";
import { prisma } from "@book-maker/db";
import { readCopyrightRestrictionsEnabled } from "@book-maker/db/safetySettings";

import {
  assessContentRestrictions,
  type ContentRestrictionAssessment,
  type ContentRestrictionReason,
  type ContentRestrictionRefusal
} from "@book-maker/core";
export { assessContentRestrictions };
export type { ContentRestrictionAssessment, ContentRestrictionOptions, ContentRestrictionReason, ContentRestrictionRefusal } from "@book-maker/core";

/** The two codes a refusal reaches a client under. */
export type ContentRestrictionCode = "CONTENT_RESTRICTED" | "COPYRIGHT_RESTRICTED";

export async function assessCurrentContentRestrictions(
  input: string
): Promise<ContentRestrictionAssessment> {
  return assessContentRestrictions(input, {
    copyrightRestrictionsEnabled: await copyrightRestrictionsEnabled()
  });
}

export async function enforceContentRestrictions(
  reply: FastifyReply,
  input: string
): Promise<boolean> {
  const assessment = await assessCurrentContentRestrictions(input);
  if (assessment.allowed) {
    return true;
  }
  sendContentRestricted(reply, assessment);
  return false;
}

/**
 * The one body a refused screen answers with, wherever it was refused.
 *
 * `reason` is the field that says *which* refusal, and `code` cannot: it
 * collapses a deceptive official artifact and a critical-harm request into one
 * string, and those are two different things to tell a reader. It lives here
 * rather than at each call site because a route that builds the reply by hand
 * builds a different one — `PATCH /api/mobile/characters/:id` screens *inside*
 * its transaction so the refusal can roll the mention writes back, so it
 * answers from a catch, and it answered `{ code, message }` where its own
 * `POST` sibling assembled three fields for the identical assessment.
 *
 * Which no reader had ever actually received, and that is the other half of
 * this: Fastify's serializer removes whatever the response schema does not
 * name, and `mobileAuthError` names `code` and `message` only — so every 422
 * documented with it drops `reason` on the way out however carefully this
 * built it. The two halves only work together, which is why the schema below
 * sits beside this function rather than with the other OpenAPI fragments in
 * `mobile/schemas.ts`.
 *
 * `details` is where a refusal says *where* the words are — the Writing
 * Studio's publish names the chapters (`manuscript/manuscriptContentScreen.ts`)
 * — and it can never overwrite the three fields above it. A route that sends
 * details declares a 422 schema naming them too, for the same reason.
 */
export function sendContentRestricted(
  reply: FastifyReply,
  refusal: ContentRestrictionRefusal,
  details: Record<string, unknown> = {}
): FastifyReply {
  return reply.code(422).send({
    error: { ...details, code: contentRestrictionCode(refusal.reason), message: refusal.message, reason: refusal.reason }
  });
}

/**
 * Which of the two codes a reason travels under — narrowed rather than
 * `string`, because the app's editor sheet branches on it and anything it does
 * not recognise falls through to a generic snackbar. Typed wide, a typo here
 * compiles and ships.
 */
function contentRestrictionCode(reason: ContentRestrictionReason): ContentRestrictionCode {
  return reason === "copyright" ? "COPYRIGHT_RESTRICTED" : "CONTENT_RESTRICTED";
}

/**
 * Thrown where the screen runs inside a transaction, so the refusal rolls the
 * writes above it back before anything answers. It carries the whole refusal
 * rather than a code and a message flattened out of one: flattening early is
 * how the reason went missing, and the catch that answers has no other way
 * back to it.
 */
export class ContentRestrictedError extends Error {
  constructor(readonly refusal: ContentRestrictionRefusal) {
    super(refusal.message);
    this.name = "ContentRestrictedError";
  }
}

/**
 * The serializer's copy of that body, for the routes that document their 422
 * with it: `POST /api/mobile/characters` and `PATCH /api/mobile/characters/:id`
 * in `mobile/routes/characters.ts`, and `POST
 * /api/mobile/characters/:id/portrait` in `mobile/routes/characterImages.ts`,
 * and the Writing Studio's two AI-assist routes. The Studio's create, settings
 * and publish routes declare `manuscriptContentRestrictedError`, this shape plus
 * the `chapters` and `fields` they send.
 *
 * Declaring it is what lets `reason` out. fast-json-stringify removes whatever
 * the response schema does not name, so a refusal documented with
 * `mobileAuthError` arrives as `{ code, message }` however carefully
 * `sendContentRestricted` assembled the third field — a route that wants to
 * send a reason has to name *this* schema as its 422. The other screening
 * routes — projects, plans, creation drafts and sessions, project chat —
 * declare no 422 at all and are serialized whole, so their `reason` survives by
 * not being described rather than by being described right; documenting one of
 * those 422s with anything else is what would lose it.
 *
 * `reason` is optional because a 422 is not always a refusal. `PUT
 * /api/mobile/characters/:id/photo` answers `PHOTO_UNSUPPORTED` and
 * `PHOTO_UNREADABLE` at that status with nothing to carry, and is declared
 * `mobileAuthError` — so screening content there means moving it onto this
 * schema first, not assuming it already sits here. `type: "string"` rather than
 * an enum of the reasons on purpose: the serializer is the thing being
 * configured, not a validator, and a reason added without this list is better
 * documented loosely than dropped.
 */
export const contentRestrictedError = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        reason: { type: "string" }
      },
      required: ["code", "message"]
    }
  },
  required: ["error"]
} as const;

/**
 * The flag every screen here reads, through the one query the worker's import
 * restore also runs (`@book-maker/db/safetySettings`). A client with no safety
 * settings delegate — a suite's stand-in — reads as off.
 */
export async function copyrightRestrictionsEnabled(): Promise<boolean> {
  if (!(prisma as { safetySettingsRevision?: unknown }).safetySettingsRevision) {
    return false;
  }
  return readCopyrightRestrictionsEnabled(prisma);
}
