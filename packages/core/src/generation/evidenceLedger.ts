import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import { isWritingMode, type WritingMode } from "../schemas/styleContract.js";
import { inferWritingMode } from "./styleContract.js";

/**
 * The evidence ledger: the two optional fields an analytical or instructional
 * page assignment carries beside its beat — `claim`, the one bounded claim the
 * page establishes, and `evidenceAnchors`, the two to four concrete cases,
 * sources, dates, artefacts or figures it argues from — and the sentences that
 * tell each producer, writer and reviewer what to do with them.
 *
 * The beat-level dedup (`pageBeatDedupDetect.ts`) measures lexical overlap of
 * short purpose/beat strings, so three pages assigned adjacent facets of one
 * subject pass it and then reach for the same canonical examples and the same
 * conclusion — exactly what the manuscript audit reports afterwards as
 * `SAME_CHAPTER_TREATMENT_REPETITION`, whose signal is named entities plus
 * shared evidence terms. The ledger makes that signal a property of the
 * *assignment*: anchors are audited for overlap before drafting
 * (`productionMapAnchors.ts`), and every drafter is told which anchors its
 * page owns and which its siblings have reserved.
 *
 * It is gated by writing mode because a scene has no evidence anchors: a
 * narrative or children's book gets no rule and no field, and a plan that
 * committed to a mode keeps it over the inference from category and prompt.
 */

export const EVIDENCE_LEDGER_WRITING_MODES: readonly WritingMode[] = ["analytical-history", "instructional"];

export type EvidenceLedgerAudience = "producer" | "repair" | "critic" | "writer" | "reviewer";

export type EvidenceLedgerFields = {
  claim?: string;
  evidenceAnchors?: string[];
};

const PRODUCER_RULES = [
  "For every page also return claim, the one bounded claim the page establishes in a single sentence, and evidenceAnchors, two to four specific cases, sources, dates, artefacts, or figures the page argues from.",
  "No two pages of a chapter may share an evidence anchor or make the same claim: each page owns its anchors, and a later page advances, challenges, or applies an earlier claim with different evidence."
];

const REPAIR_RULES = [
  ...PRODUCER_RULES,
  "The repaired claim must differ from every claim on pageScope.previousChapterPageBriefs and futureChapterPageBriefs, and the repaired evidenceAnchors must not reuse any anchor those briefs carry."
];

const CRITIC_RULES = [
  "Pages carrying claim and evidenceAnchors own them: return a beat patch with a fresh claim and evidenceAnchors for a page whose claim restates a sibling's, or whose anchors a sibling of the same chapter already owns."
];

const WRITER_RULES = [
  "A page's evidenceAnchors are its own evidence: build that page's argument from them, treat anchors listed on any other page's brief as reserved for that page and mention them only in passing, and give the page a claim that differs from every sibling claim in its chapter."
];

const REVIEWER_RULES = [
  "Reject a page whose argument rests on evidenceAnchors reserved by another page's brief in pageScope, or whose claim restates a sibling brief's claim instead of advancing, challenging, or applying it."
];

const RULES_BY_AUDIENCE: Record<EvidenceLedgerAudience, readonly string[]> = {
  producer: PRODUCER_RULES,
  repair: REPAIR_RULES,
  critic: CRITIC_RULES,
  writer: WRITER_RULES,
  reviewer: REVIEWER_RULES
};

export const EVIDENCE_LEDGER_OUTPUT_CONTRACT = {
  claim: "The one bounded claim this page establishes, in one sentence.",
  evidenceAnchors: ["Two to four specific cases, sources, dates, artefacts, or figures this page argues from."]
} as const;

/** The mode a book is written in: the plan's own commitment, else the inference. */
export function evidenceLedgerWritingMode(input: CreateProjectInput, plan: BookPlan): WritingMode {
  return isWritingMode(plan.writingMode) ? plan.writingMode : inferWritingMode(input, plan);
}

export function writingModeUsesEvidenceLedger(mode: WritingMode | undefined): boolean {
  return mode !== undefined && EVIDENCE_LEDGER_WRITING_MODES.includes(mode);
}

export function usesEvidenceLedger(input: CreateProjectInput, plan: BookPlan): boolean {
  return writingModeUsesEvidenceLedger(evidenceLedgerWritingMode(input, plan));
}

/** The ledger's sentences for one prompt audience; none outside ledger modes. */
export function evidenceLedgerRules(input: CreateProjectInput, plan: BookPlan, audience: EvidenceLedgerAudience): string[] {
  return usesEvidenceLedger(input, plan) ? [...RULES_BY_AUDIENCE[audience]] : [];
}

/** The two example keys a producer's output contract shows; none outside ledger modes. */
export function evidenceLedgerOutputContract(
  input: CreateProjectInput,
  plan: BookPlan
): Partial<typeof EVIDENCE_LEDGER_OUTPUT_CONTRACT> {
  return usesEvidenceLedger(input, plan) ? EVIDENCE_LEDGER_OUTPUT_CONTRACT : {};
}

/**
 * The ledger half of an assignment, present only where the assignment carries
 * it — the guarded spread every explicit rebuild of a beat reaches for, so a
 * projection cannot drop the fields and a copy cannot invent empty ones.
 */
export function evidenceLedgerFields(page: {
  claim?: string | undefined;
  evidenceAnchors?: readonly string[] | undefined;
}): EvidenceLedgerFields {
  const claim = page.claim?.trim();
  const evidenceAnchors = (page.evidenceAnchors ?? []).map((anchor) => anchor.trim()).filter(Boolean);
  return {
    ...(claim ? { claim } : {}),
    ...(evidenceAnchors.length > 0 ? { evidenceAnchors } : {})
  };
}
