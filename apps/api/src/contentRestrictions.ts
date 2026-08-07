import type { FastifyReply } from "fastify";
import { prisma } from "@book-maker/db";

export type ContentRestrictionReason =
  | "deceptive_official_artifact"
  | "critical_illegal_harm"
  | "copyright";

export type ContentRestrictionAssessment =
  | { allowed: true }
  | { allowed: false; reason: ContentRestrictionReason; message: string };

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
  reply.code(422).send({
    error: {
      code: assessment.reason === "copyright" ? "COPYRIGHT_RESTRICTED" : "CONTENT_RESTRICTED",
      message: assessment.message,
      reason: assessment.reason
    }
  });
  return false;
}

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
