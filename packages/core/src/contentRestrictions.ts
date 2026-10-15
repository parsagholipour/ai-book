export type ContentRestrictionReason =
  | "deceptive_official_artifact"
  | "critical_illegal_harm"
  | "copyright"
  /** The operator's sexual-content filter, decided by a model screen rather than a rule here. */
  | "sexual_content"
  | "minor_sexual_content";

/**
 * The refusal the sexual-content filter's model screen answers with
 * (`apps/api/src/contentSafetyScreen.ts`). Its sentences live here beside the
 * others so a reason owns one sentence; on the wire both travel as
 * `CONTENT_RESTRICTED`, which every app build already renders.
 */
export function sexualContentRefusal(violation: "sexual" | "child_safety"): ContentRestrictionRefusal {
  return violation === "child_safety"
    ? {
        allowed: false,
        reason: "minor_sexual_content",
        message:
          "Tomeza never writes sexual or romantic-physical content involving anyone under 18. Keep every young character's relationships age-appropriate and try again."
      }
    : {
        allowed: false,
        reason: "sexual_content",
        message: "Tomeza doesn't write sexually explicit content. Ask for the story without explicit scenes and try again."
      };
}

/** The refusal half of an assessment — the only half anything ever answers with. */
export type ContentRestrictionRefusal = {
  allowed: false;
  reason: ContentRestrictionReason;
  message: string;
};

export type ContentRestrictionAssessment = { allowed: true } | ContentRestrictionRefusal;

export type ContentRestrictionOptions = {
  copyrightRestrictionsEnabled: boolean;
  /**
   * The words are a page the book prints as the reader typed them — a
   * dedication, an About the Author, a byline — not a request to a model.
   *
   * Most of the rules below are request detectors: a subject *plus* the shape
   * of asking for it ("fake" with "passport"; "how to" or "step-by-step" with
   * "terrorist attack"). Over printed text the asking half is just English: "To
   * the victims of the Manchester Arena terrorist attack, and to the city that
   * showed us how to grieve" and "To Oma, whose fake passport got us out in
   * 1939" were refused as requests. A printed page cannot be a forged document
   * or a set of instructions somebody asked for, so printed text skips both
   * request-shaped rules and keeps the child-exploitation names, which have no
   * request half — the phrase alone is the refusal, and printing it on a
   * shared page is the harm — and the operator's copyright rule, which is the
   * operator's to switch on or off whatever the text is.
   */
  printed?: boolean;
};

/**
 * A deliberately narrow, local preflight. Ambiguous requests are allowed and
 * provider safety remains in force. Copyright checks are an operator option;
 * the two critical-harm checks are always active (over printed text, only the
 * child-exploitation names — `ContentRestrictionOptions.printed`).
 */
export function assessContentRestrictions(
  input: string,
  options: ContentRestrictionOptions
): ContentRestrictionAssessment {
  const text = normalize(input);
  if (!text) {
    return { allowed: true };
  }
  const printed = options.printed === true;

  if (!printed && requestsDeceptiveOfficialArtifact(text)) {
    return {
      allowed: false,
      reason: "deceptive_official_artifact",
      message: "Tomeza cannot create a fake official document intended to pass as genuine."
    };
  }
  if (namesChildSexualExploitation(text) || (!printed && requestsSevereHarmOperations(text))) {
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

function requestsDeceptiveOfficialArtifact(text: string): boolean {
  const artifact =
    /\b(?:passport|visa|driver(?:'s)? licen[cs]e|national id|government id|birth certificate|bank statement|medical prescription|court order|police report)\b/;
  const deception =
    /\b(?:forge|counterfeit|fake|falsif(?:y|ied)|pass (?:off )?as (?:real|genuine)|look (?:real|genuine)|bypass verification|use for verification)\b/;
  return artifact.test(text) && deception.test(text);
}

/** A critical-harm rule with no request half: the phrase alone is the refusal. */
function namesChildSexualExploitation(text: string): boolean {
  const childSexualExploitation =
    /\b(?:child sexual abuse material|csam|sexual(?:ly)? exploit(?:ation|ing)? (?:a |the )?(?:child|minor)|explicit sexual content (?:with|involving) (?:a |the )?(?:child|minor))\b/;
  return childSexualExploitation.test(text);
}

/** A critical-harm rule that is a request: an operational ask beside a severe harm. */
function requestsSevereHarmOperations(text: string): boolean {
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

