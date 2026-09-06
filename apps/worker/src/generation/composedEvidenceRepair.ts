import type { ChapterCaseEvidenceReview } from "@book-maker/core";

/** A prose-review finding: the exact chapter span and why its evidence does not carry it. */
export type EvidenceResidual = { quote: string; reason: string };

export type ChapterEvidenceRepair = {
  markdown: string;
  /** Findings on the chapter as composed. */
  findings: number;
  /** Targeted edits spent. */
  repairs: number;
  /** Findings still standing on the text that ships. */
  unresolved: EvidenceResidual[];
  /** Findings the reviewer could not re-quote and were dropped as unactionable. */
  dropped: number;
};

/** Two targeted edits: the first narrows, the second deletes. A third round was measured as another paraphrase. */
export const EVIDENCE_REPAIR_ROUNDS = 2;

/** `reviewChapterCaseEvidence` formats a finding as “quote”: reason; this is the inverse. */
export function parseEvidenceFinding(issue: string): EvidenceResidual {
  const match = /^“([\s\S]+)”: ([\s\S]*)$/.exec(issue);
  return match ? { quote: match[1]!, reason: match[2]! } : { quote: issue, reason: "" };
}

export function evidenceRepairNotes(issues: readonly string[], last: boolean): string[] {
  return [
    `Unsupported case claims. Each note below quotes an exact span of this chapter that asserts more than its evidence passage supports. ${last ? "Delete the unsupported detail outright, even at the cost of the sentence; do not rephrase it into a hedge." : "Narrow the span to what the passage states, or delete the unsupported detail."} Change nothing else in the chapter.`,
    ...issues
  ];
}

/**
 * Review, then repair at most `EVIDENCE_REPAIR_ROUNDS` times, keeping a repaired text only when it
 * carries fewer findings than the text it replaced. Whatever still stands is returned, never thrown:
 * the residuals are recorded on the chapter and flagged at compile time, and the book publishes for review.
 */
export async function repairChapterEvidence(options: {
  markdown: string;
  review: (markdown: string) => Promise<ChapterCaseEvidenceReview>;
  edit: (markdown: string, notes: string[]) => Promise<string>;
  degenerate: (markdown: string) => boolean;
}): Promise<ChapterEvidenceRepair> {
  let markdown = options.markdown;
  let review = await options.review(markdown);
  const findings = review.issues.length;
  let dropped = review.dropped.length;
  let repairs = 0;
  while (review.issues.length && repairs < EVIDENCE_REPAIR_ROUNDS) {
    repairs += 1;
    const repaired = await options.edit(markdown, evidenceRepairNotes(review.issues, repairs === EVIDENCE_REPAIR_ROUNDS));
    if (options.degenerate(repaired)) break;
    const next = await options.review(repaired);
    dropped += next.dropped.length;
    if (next.issues.length && next.issues.length >= review.issues.length) continue;
    markdown = repaired;
    review = next;
  }
  return { markdown, findings, repairs, unresolved: review.issues.map(parseEvidenceFinding), dropped };
}
