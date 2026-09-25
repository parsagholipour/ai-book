import { isStopOrAbortError, type BookGenerationStrategy, type BookPlan, type CreateProjectInput, type FinalBookQa, type ManuscriptQualityIssue, type TextModelAdapter } from "@book-maker/core";
import { toFinalQaPage } from "../generation/bookHelpers.js";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";
import { runBoundedChapterQualityReview } from "./compileExportChapterReview.js";

/** Both verdicts read exactly the same manuscript, before or after its one repair pass. */
export async function reviewFinalizationManuscript(options: {
  input: CreateProjectInput; plan: BookPlan; pages: ExportPageForRepair[];
  strategy: BookGenerationStrategy; textModel: TextModelAdapter; projectId: string;
  researchNotes: string[]; skipLocalChecks: boolean;
}) {
  const results = await Promise.allSettled([
    runBoundedChapterQualityReview(options),
    options.strategy.runFinalBookQa({
      input: options.input, plan: options.plan, pages: options.pages.map(toFinalQaPage), textModel: options.textModel,
      researchNotes: options.strategy.researchDepth ? options.researchNotes : undefined,
      skipLocalChecks: options.skipLocalChecks
    })
  ]);
  for (const result of results) {
    if (result.status === "rejected" && isStopOrAbortError(result.reason)) throw result.reason;
  }
  const [chapter, book] = results;
  const issues = chapter.status === "fulfilled" ? chapter.value : [unavailable("Chapter transition")];
  const finalQa: FinalBookQa = book.status === "fulfilled" ? book.value : {
    approved: false, score: 0, issues: [], requiredFixes: [], notes: "Whole-book review unavailable."
  };
  if (book.status === "rejected") issues.push(unavailable("Whole-book"));
  return { issues, finalQa };
}

function unavailable(check: string): ManuscriptQualityIssue {
  return { code: "FINAL_REVIEW_UNAVAILABLE", source: "model", severity: "warning", affectedPageIndexes: [],
    message: `${check} review could not complete after its bounded provider attempts.`,
    guidance: "Review the saved manuscript or request another review." };
}
