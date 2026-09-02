import { updateJobProgress } from "../runtime/jobLifecycle.js";
import { isStopRequestedError, type IndexedPageDraft } from "../runtime/jobTypes.js";
import { reviewPageWithQualityGates } from "./pageReview.js";
import { loadQualityContext } from "./qualitySettings.js";
import {
  hasSmartUnslopCandidates,
  type BookGenerationStrategy,
  type BookPlan,
  type CreateProjectInput,
  type PageQualityReport,
  type PriorPageContext,
  type TextModelAdapter,
  composedPageQualityReport,
  strategyComposesChapters
} from "@book-maker/core";

export type ReviewedWholeBookPage = {
  draft: IndexedPageDraft;
  qualityReport: PageQualityReport;
  revision: number;
};

/** Keep whole-book generation's established local-only check and one-rewrite cap. */
export async function reviewWholeBookDraftPages(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  strategy: BookGenerationStrategy;
  textModel: TextModelAdapter;
  pages: IndexedPageDraft[];
  generationJobId?: string | undefined;
}): Promise<ReviewedWholeBookPage[]> {
  const quality = await loadQualityContext(options.input);
  const reviewed: ReviewedWholeBookPage[] = [];
  const previousPages: PriorPageContext[] = [];

  for (const pageDraft of options.pages) {
    let draft: IndexedPageDraft = pageDraft;
    let revision = 1;
    let report = await reviewPageWithQualityGates({
      strategy: options.strategy,
      quality,
      allowModelReview: false,
      reviewOptions: {
        input: options.input,
        plan: options.plan,
        pageIndex: pageDraft.index,
        draft,
        previousPages,
        continuityNotes: [],
        textModel: options.textModel
      }
    });
    if (strategyComposesChapters(options.strategy)) {
      report = composedPageQualityReport(report);
    }

    if (!report.approved && quality.enabled("pageQaRewrite")) {
      await updateJobProgress(options.generationJobId, {
        message: `Page ${pageDraft.index} failed local quality checks; revising.`
      });
      try {
        const revisedDraft = await options.strategy.revisePageDraft({
          input: options.input,
          plan: options.plan,
          pageIndex: pageDraft.index,
          qaCandidateNumber: 2,
          draft,
          report,
          previousPages,
          continuityNotes: [],
          textModel: options.textModel
        });
        const revisedReport = await reviewPageWithQualityGates({
          strategy: options.strategy,
          quality,
          allowModelReview: false,
          allowSmartUnslop: !hasSmartUnslopCandidates(report as PageQualityReport),
          reviewOptions: {
            input: options.input,
            plan: options.plan,
            pageIndex: pageDraft.index,
            draft: revisedDraft,
            previousPages,
            continuityNotes: [],
            textModel: options.textModel
          }
        });
        if (revisedReport.score >= report.score) {
          draft = { ...revisedDraft, index: pageDraft.index };
          report = revisedReport;
          revision = 2;
        }
      } catch (error) {
        if (isStopRequestedError(error)) {
          throw error;
        }
      }
    }

    reviewed.push({ draft, qualityReport: report, revision });
    previousPages.push({ index: draft.index, title: draft.title, markdown: draft.markdown, summary: draft.summary });
  }

  return reviewed;
}
