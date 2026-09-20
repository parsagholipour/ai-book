import { arithmeticFindings, type ArithmeticFinding } from "@book-maker/core";
import { repairChapterEvidence, type ChapterEvidenceRepair } from "./composedEvidenceRepair.js";

/**
 * The arithmetic a chapter prints is checked without a model (`arithmeticFindings`) and repaired
 * through the same two-round targeted-edit loop as the case-evidence review, with the exact
 * computation as the correction's evidence. Whatever still fails is returned for the chapter
 * report and the compile-time card, never thrown.
 */
export type ArithmeticCorrection = { instructions: string[]; computations: string[] };

export function arithmeticIssue(finding: ArithmeticFinding): string { return `“${finding.quote}”: ${finding.reason}`; }

export function arithmeticRepairNotes(issues: readonly string[], last: boolean): string[] {
  return [
    `Wrong arithmetic. Each note below quotes a numeric statement of this chapter exactly as it stands and gives the value that would make it true. ${last ? "Replace every wrong number with the value given, and if a chain of steps cannot be made to hold, delete the intermediate steps and keep only the correct final result." : "Correct the wrong numbers so that every step of the calculation holds; recompute the steps that follow from a corrected value."} Change nothing else in the chapter.`,
    ...issues
  ];
}

export async function repairChapterArithmetic(options: {
  markdown: string;
  edit: (markdown: string, correction: ArithmeticCorrection) => Promise<string>;
  degenerate: (markdown: string) => boolean;
}): Promise<ChapterEvidenceRepair | undefined> {
  if (arithmeticFindings(options.markdown).length === 0) return undefined;
  return repairChapterEvidence({
    markdown: options.markdown,
    review: async (markdown) => ({ issues: arithmeticFindings(markdown).map(arithmeticIssue), dropped: [] }),
    edit: (markdown, notes) => options.edit(markdown, { instructions: notes, computations: arithmeticFindings(markdown).map((finding) => finding.reason) }),
    degenerate: options.degenerate,
    notes: arithmeticRepairNotes
  });
}
