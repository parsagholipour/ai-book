import {
  arithmeticFindings, inferWritingMode, isNarrativeWritingMode, proseArithmeticFindings,
  type ArithmeticFinding, type BookPlan, type CreateProjectInput, type TextModelAdapter
} from "@book-maker/core";
import { repairChapterEvidence, type ChapterEvidenceRepair } from "./composedEvidenceRepair.js";
import { isStopRequestedError } from "../runtime/jobTypes.js";

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
  /** The prose's arithmetic (`proseArithmeticFindings`): a failure there is no findings, never a failed chapter. */
  proseFindings?: ((markdown: string) => Promise<ArithmeticFinding[]>) | undefined;
}): Promise<ChapterEvidenceRepair | undefined> {
  const disputed = new Map<string, ArithmeticFinding>();
  const findingsOf = async (markdown: string): Promise<ArithmeticFinding[]> => {
    let prose: ArithmeticFinding[] = [];
    try {
      prose = (await options.proseFindings?.(markdown)) ?? [];
    } catch (error) {
      if (isStopRequestedError(error)) throw error;
    }
    for (const finding of prose) {
      if (finding.reviewOnly) disputed.set(finding.quote, finding);
    }
    return [...arithmeticFindings(markdown), ...prose.filter(finding => !finding.reviewOnly)];
  };
  const first = await findingsOf(options.markdown);
  const initialDisputes = disputed.size;
  if (first.length === 0) return disputed.size ? {
    markdown: options.markdown, findings: disputed.size, repairs: 0,
    unresolved: [...disputed.values()], dropped: 0
  } : undefined;
  // The first review is the check just made; every later one reads the edited text.
  let latest = first;
  let reviewed: string | undefined = options.markdown;
  const repair = await repairChapterEvidence({
    markdown: options.markdown,
    review: async (markdown) => {
      latest = markdown === reviewed ? latest : await findingsOf(markdown);
      reviewed = undefined;
      return { issues: latest.map(arithmeticIssue), dropped: [] };
    },
    edit: (markdown, notes) => options.edit(markdown, { instructions: notes, computations: latest.map((finding) => finding.reason) }),
    degenerate: options.degenerate,
    notes: arithmeticRepairNotes
  });
  const remaining = [...disputed.values()].filter(finding => repair.markdown.includes(finding.quote)
    && !repair.unresolved.some(unresolved => unresolved.quote === finding.quote));
  return { ...repair, findings: repair.findings + initialDisputes, unresolved: [...repair.unresolved, ...remaining] };
}

/**
 * The prose's own arithmetic for a book that argues or instructs, proposed by
 * a model and kept only where code agrees (`proseArithmeticFindings`); none
 * for a story, and none with the `proseArithmeticCheck` gate off.
 */
export function proseArithmeticChecker(options: { input: CreateProjectInput; plan: BookPlan; textModel: TextModelAdapter; enabled: boolean }) {
  if (!options.enabled || isNarrativeWritingMode(inferWritingMode(options.input, options.plan))) return undefined;
  return (markdown: string) => proseArithmeticFindings({ markdown, textModel: options.textModel, language: options.input.language });
}
