import { isRecord } from "../schemas/jsonCoercion.js";
import {
  citationContractFields,
  type CitationContractNote
} from "./pagesShared.js";

const SOURCE_IDENTITY_ITEM = String.raw`(?:(?:an?|the|required|named|specific)\s+)*(?:diar(?:y|ies)|dispatch(?:\s+date)?|archives?|citations?|sources?|testimon(?:y|ies)|documents?|documentation|documented\s+civilian(?:\s+(?:account|testimony))?|civilian\s+(?:account|testimony))`;
const SOURCE_IDENTITY_LIST = String.raw`${SOURCE_IDENTITY_ITEM}(?:\s*(?:,|\bor\b|\band\b)\s*${SOURCE_IDENTITY_ITEM})*`;
const PAGE_SUBJECT = String.raw`(?:the\s+)?(?:page|draft|prose|response|account)`;

const LEGACY_REQUIREMENT_SETUP = new RegExp(
  String.raw`^despite\s+(?:the\s+)?(?:page\s+)?brief\s+explicitly\s+requiring\s+${SOURCE_IDENTITY_LIST}\s*,\s*`,
  "i"
);

/**
 * These patterns consume a whole clause. A legacy phrase appearing somewhere
 * inside a broader factual or continuity complaint is not positive evidence.
 */
const SOURCE_IDENTITY_ONLY_CLAUSE_PATTERNS = [
  new RegExp(
    String.raw`^(?:${PAGE_SUBJECT}\s+)?(?:does\s+not|doesn't|fails?\s+to|never|cannot)\s+(?:identify|name|provide|specify|include|cite)\s+${SOURCE_IDENTITY_LIST}(?:\s+(?:required|requested)\s+(?:by|in)\s+(?:the\s+)?(?:page\s+)?brief)?$`,
    "i"
  ),
  new RegExp(
    String.raw`^(?:${PAGE_SUBJECT}\s+)?(?:lacks?|is\s+missing|omits?)\s+${SOURCE_IDENTITY_LIST}(?:\s+(?:required|requested)\s+(?:by|in)\s+(?:the\s+)?(?:page\s+)?brief)?$`,
    "i"
  ),
  new RegExp(
    String.raw`^no\s+${SOURCE_IDENTITY_LIST}(?:\s+(?:is|are))?(?:\s+(?:identified|named|provided|specified|included|cited|available|present))?$`,
    "i"
  ),
  new RegExp(
    String.raw`^(?:${PAGE_SUBJECT}\s+)?(?:provides?|contains?|offers?|includes?)\s+no\s+${SOURCE_IDENTITY_LIST}$`,
    "i"
  ),
  new RegExp(
    String.raw`^${SOURCE_IDENTITY_LIST}(?:\s+(?:required|requested)\s+(?:by|in)\s+(?:the\s+)?(?:page\s+)?brief)?\s+(?:is|are|remains?|remain)\s+(?:not\s+(?:identified|named|provided|specified|included|cited|available|present)|unnamed|unspecified|missing|absent|unavailable)$`,
    "i"
  )
] as const;

const REPAIRABLE_DEFECT_EVIDENCE =
  /\b(?:invent\w*|fabricat\w*|composite|made[-\s]?up|factual|inaccura\w*|incorrect|wrong|imprecise|anachron\w*|chronolog\w*|repetit\w*|duplicat\w*|restag\w*|reserved\s+(?:beat|closing|material)|overpack\w*|too many (?:events|facts|ideas|beats)|too much chronology|compress\w* (?:later|subsequent) (?:developments|material|pages?)|abstract|placeholder|prompt leak|schema leak|contradict\w*|continuity|inconsisten\w*|unsupported|misrepresent\w*|contest\w*|disput\w*|conflict\w*|incoheren\w*)\b/i;
const NEGATED_REPAIRABLE_DEFECT =
  /\b(?:avoids?|contains? no|does not|doesn't|has no|no)\s+(?:invent\w*|fabricat\w*|repetit\w*|restag\w*|unsupported|factual errors?)\b/gi;

const SOURCE_IDENTITY_REFERENCE =
  /\b(?:accounts?|archives?|citations?|diar(?:y|ies)|dispatch(?:es)?|documents?|documented (?:civilian|human-scale|official|diplomatic|person|record|report|source|testimony)|interviews?|military accounts?|named (?:civilian|individual|person|record|soldier|source|testimony|witness)|newspaper reports?|notices?|photograph captions?|public announcements?|publications?|records?|reports?|source(?: context| status| type)?|testimon(?:y|ies)|witness(?:es)?)\b/i;

const SOURCE_IDENTITY_ABSENCE_OR_REQUIREMENT =
  /\b(?:could benefit from|does not (?:fulfill|identify|include|name|provide|use)|failing (?:the )?(?:page\s*)?brief|generalized,? unsourced|is not (?:actually )?(?:grounded|provided)|no (?:actual |clearly |precise |specific )?|not (?:actually )?provided|omission is acceptable|page\s*brief (?:explicitly )?(?:requested|requir\w*)|refers? vaguely|rather than presenting|requested|required (?:beat|documented|sourced)|unnamed|without (?:identifying|naming|providing|specifying))\b/i;

const SOURCE_IDENTITY_REPAIR_COMMAND =
  /^(?:consider|do not paraphrase an unnamed record|either cite|identify|name|replace|use)\b/i;

export function isSourceIdentityOnlyIssue(rawIssue: string): boolean {
  if (REPAIRABLE_DEFECT_EVIDENCE.test(rawIssue.replace(NEGATED_REPAIRABLE_DEFECT, ""))) {
    return false;
  }
  const issue = rawIssue
    .trim()
    .replace(LEGACY_REQUIREMENT_SETUP, "")
    .replace(/[.!?]+$/g, "")
    .trim();
  if (!issue) {
    return false;
  }
  const clauses = issue
    .split(/\s*(?:;|[.!?]+|,\s+(?:and|but|while|whereas|yet)\s+)\s*/i)
    .map((clause) => clause.trim())
    .filter(Boolean);
  return (
    clauses.length > 0 &&
    (clauses.every((clause) => SOURCE_IDENTITY_ONLY_CLAUSE_PATTERNS.some((pattern) => pattern.test(clause))) ||
      (SOURCE_IDENTITY_REFERENCE.test(issue) &&
        (SOURCE_IDENTITY_ABSENCE_OR_REQUIREMENT.test(issue) || SOURCE_IDENTITY_REPAIR_COMMAND.test(issue))))
  );
}

/**
 * Classifies legacy FAILED_QA reports whose only complaint asks for a source
 * identity the project cannot cite. Stored reports predate issue codes, so the
 * positive match is deliberately over the complete text of every issue.
 */
export function shouldSkipUnsatisfiableCitationRepair(
  qualityReport: unknown,
  researchNotes: readonly CitationContractNote[] | undefined
): boolean {
  if (citationContractFields(researchNotes).payload.researchNotes.length > 0 || !isRecord(qualityReport)) {
    return false;
  }
  const issues = Array.isArray(qualityReport.issues)
    ? qualityReport.issues.filter((issue): issue is string => typeof issue === "string" && issue.trim().length > 0)
    : [];
  return issues.length > 0 && issues.every(isSourceIdentityOnlyIssue);
}
