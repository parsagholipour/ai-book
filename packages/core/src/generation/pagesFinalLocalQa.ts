import type { TextModelAdapter } from "../adapters/types.js";
import type { CreateProjectInput } from "../schemas/book.js";
import type { FinalQaPage, ReviewPageOptions } from "./pagesReview.js";
import {
  reviewRequiredPageQualityChecks,
  runLocalPageQualityChecks
} from "./pagesLocalQa.js";

/** Run the configurable deterministic sweep over a finished manuscript. */
export function runLocalFinalQa(input: CreateProjectInput, pages: FinalQaPage[]): string[] {
  const issues: string[] = [];
  if (pages.length !== input.targetPages) {
    issues.push(`Expected ${input.targetPages} pages but found ${pages.length}.`);
  }

  for (const page of pages) {
    const report = runLocalPageQualityChecks(finalQaPageReviewOptions(input, pages, page));
    if (!report.approved) {
      issues.push(`Page ${page.index}: ${report.issues.join(" ")}`);
    }
  }

  return issues.slice(0, 20);
}

/** Preserve provenance-only page invariants when configurable final local QA is skipped. */
export function runRequiredFinalQa(input: CreateProjectInput, pages: FinalQaPage[]): string[] {
  const issues: string[] = [];
  for (const page of pages.filter((candidate) => candidate.index === 1)) {
    const report = reviewRequiredPageQualityChecks(finalQaPageReviewOptions(input, pages, page));
    if (!report.approved) {
      issues.push(`Page ${page.index}: ${report.issues.join(" ")}`);
    }
  }
  return issues.slice(0, 20);
}

function finalQaPageReviewOptions(
  input: CreateProjectInput,
  pages: FinalQaPage[],
  page: FinalQaPage
): ReviewPageOptions {
  return {
    input,
    plan: {
      title: "",
      premise: "",
      audience: "",
      writingComplexity: input.complexity,
      voiceGuide: [""],
      antiAiRules: [""],
      questions: [],
      chapters: [],
      characters: [],
      locations: [],
      continuityRules: [],
      researchQueries: [],
      researchNotes: [],
      promises: [],
      illustrationPlan: {
        cadence: input.mediaSettings.illustrationCadence,
        globalStyle: "",
        characterReferencePrompts: [],
        pageRules: []
      }
    },
    pageIndex: page.index,
    draft: {
      title: page.title,
      markdown: page.markdown,
      summary: page.summary,
      continuityNotes: []
    },
    previousPages: pages.filter((candidate) => candidate.index < page.index).slice(-4),
    continuityNotes: [],
    textModel: {} as TextModelAdapter
  };
}
