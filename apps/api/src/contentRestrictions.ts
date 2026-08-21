import type { FastifyReply } from "fastify";
import { prisma } from "@book-maker/db";

export type ContentRestrictionReason =
  | "deceptive_official_artifact"
  | "critical_illegal_harm"
  | "copyright";

/** The refusal half of an assessment — the only half anything ever answers with. */
export type ContentRestrictionRefusal = {
  allowed: false;
  reason: ContentRestrictionReason;
  message: string;
};

export type ContentRestrictionAssessment = { allowed: true } | ContentRestrictionRefusal;

/** The two codes a refusal reaches a client under. */
export type ContentRestrictionCode = "CONTENT_RESTRICTED" | "COPYRIGHT_RESTRICTED";

/**
 * A deliberately narrow, local preflight. Ambiguous requests are allowed and
 * provider safety remains in force. Copyright checks are an operator option;
 * the two critical-harm checks are always active.
 */
export function assessContentRestrictions(
  input: string,
  options: { copyrightRestrictionsEnabled: boolean }
): ContentRestrictionAssessment {
  const text = normalize(input);
  if (!text) {
    return { allowed: true };
  }

  if (requestsDeceptiveOfficialArtifact(text)) {
    return {
      allowed: false,
      reason: "deceptive_official_artifact",
      message: "Tomeza cannot create a fake official document intended to pass as genuine."
    };
  }
  if (requestsCriticalIllegalHarm(text)) {
    return {
      allowed: false,
      reason: "critical_illegal_harm",
      message: "Tomeza cannot help create content that facilitates severe illegal harm."
    };
  }
  if (options.copyrightRestrictionsEnabled && requestsCopyrightedSubstitution(text)) {
    return {
      allowed: false,
      reason: "copyright",
      message:
        "Copyright restrictions are enabled. Use material you own or have permission to use, and request an original treatment instead."
    };
  }
  return { allowed: true };
}

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
 */
export function sendContentRestricted(
  reply: FastifyReply,
  refusal: ContentRestrictionRefusal
): FastifyReply {
  return reply.code(422).send({
    error: { code: contentRestrictionCode(refusal.reason), message: refusal.message, reason: refusal.reason }
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
 * /api/mobile/characters/:id/portrait` in `mobile/routes/characterImages.ts`.
 * Those are the only ones today.
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

export async function copyrightRestrictionsEnabled(): Promise<boolean> {
  const delegate = optionalSafetySettingsDelegate();
  if (!delegate) {
    return false;
  }
  const current = await delegate.findFirst({
    orderBy: { version: "desc" },
    select: { copyrightRestrictionsEnabled: true }
  });
  return current?.copyrightRestrictionsEnabled === true;
}

function requestsDeceptiveOfficialArtifact(text: string): boolean {
  const artifact =
    /\b(?:passport|visa|driver(?:'s)? licen[cs]e|national id|government id|birth certificate|bank statement|medical prescription|court order|police report)\b/;
  const deception =
    /\b(?:forge|counterfeit|fake|falsif(?:y|ied)|pass (?:off )?as (?:real|genuine)|look (?:real|genuine)|bypass verification|use for verification)\b/;
  return artifact.test(text) && deception.test(text);
}

function requestsCriticalIllegalHarm(text: string): boolean {
  const childSexualExploitation =
    /\b(?:child sexual abuse material|csam|sexual(?:ly)? exploit(?:ation|ing)? (?:a |the )?(?:child|minor)|explicit sexual content (?:with|involving) (?:a |the )?(?:child|minor))\b/;
  if (childSexualExploitation.test(text)) {
    return true;
  }

  const operational =
    /\b(?:step[- ]by[- ]step|detailed instructions?|operational plan|how (?:can|do|to)|best way to|evade (?:police|security)|maximize casualties)\b/;
  const severeHarm =
    /\b(?:build (?:a )?bomb|make (?:an )?explosive|mass shooting|terrorist attack|poison (?:a )?(?:water supply|crowd)|assassinat(?:e|ion)|kill a large number|mass casualty)\b/;
  return operational.test(text) && severeHarm.test(text);
}

function requestsCopyrightedSubstitution(text: string): boolean {
  const verbatim =
    /\b(?:copy|reproduce|provide|output|transcribe|translate|rewrite)\b.{0,80}\b(?:entire|full|complete|exact|verbatim|word[- ]for[- ]word)\b.{0,80}\b(?:book|novel|chapter|story|article|song|lyrics|screenplay|text)\b/;
  const reverseVerbatim =
    /\b(?:entire|full|complete|exact|verbatim|word[- ]for[- ]word)\b.{0,80}\b(?:book|novel|chapter|story|article|song|lyrics|screenplay|text)\b.{0,80}\b(?:copy|reproduce|provide|output|transcribe|translate|rewrite)\b/;
  const continuation =
    /\b(?:continue|write (?:the )?next (?:chapter|book|scene)|finish)\b.{0,100}\b(?:copyrighted|published|bestselling|existing)\b.{0,50}\b(?:book|novel|series|story|screenplay)\b/;
  const namedStyleImitation =
    /\b(?:exactly imitate|copy the (?:writing )?style|indistinguishable from|write exactly like)\b.{0,100}\b(?:author|writer|novelist|poet|songwriter)\b/;
  const explicitRightsEvasion =
    /\b(?:copyrighted|rights[- ]protected)\b.{0,100}\b(?:without permission|without a licen[cs]e|avoid copyright|bypass copyright)\b/;
  return (
    verbatim.test(text) ||
    reverseVerbatim.test(text) ||
    continuation.test(text) ||
    namedStyleImitation.test(text) ||
    explicitRightsEvasion.test(text)
  );
}

function normalize(input: string): string {
  return input.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 50_000);
}

type SafetySettingsDelegate = {
  findFirst(args: Record<string, unknown>): Promise<{
    copyrightRestrictionsEnabled: boolean;
  } | null>;
};

function optionalSafetySettingsDelegate(): SafetySettingsDelegate | undefined {
  return (prisma as unknown as { safetySettingsRevision?: SafetySettingsDelegate })
    .safetySettingsRevision;
}
