import { quickDraftPageQuality } from "./quickDraftReviewPolicy.js";
import { updateJobProgress } from "../runtime/jobLifecycle.js";
import type { IndexedPageDraft } from "../runtime/jobTypes.js";
import { reviewPageWithQualityGates, withoutPageReview } from "./pageReview.js";
import { loadQualityContext } from "./qualitySettings.js";
import {
  isCancellationError,
  CASE_EVIDENCE_WRITER_RULES,
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

/**
 * The deterministic local checks on a whole-book draft's pages (the
 * single-pass strategy under five pages) and on a composed book's cut pages.
 * No model reviews either, on any tier (`withoutPageReview`). A composed page
 * whose integrity checks fail — a prompt leak or a placeholder, the two rules
 * `composedPageQualityReport` keeps — gets one revise under `pageQaRewrite`:
 * the repair of a deterministic finding, the way `arithmeticFindings` is
 * repaired. A whole-book draft's page is saved as drafted with its report, as a
 * short book's is (E4); its old one rewrite on any local failure went in E5.
 */
export async function reviewWholeBookDraftPages(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  strategy: BookGenerationStrategy;
  textModel: TextModelAdapter;
  pages: IndexedPageDraft[];
  generationJobId?: string | undefined;
}): Promise<ReviewedWholeBookPage[]> {
  const loadedQuality = quickDraftPageQuality(options.input, await loadQualityContext(options.input));
  const quality = withoutPageReview(loadedQuality);
  const composed = strategyComposesChapters(options.strategy);
  const reviewed: ReviewedWholeBookPage[] = [];
  const previousPages: PriorPageContext[] = [];

  for (const pageDraft of options.pages) {
    let draft: IndexedPageDraft = pageDraft;
    let revision = 1;
    let report = await reviewPageWithQualityGates({
      strategy: options.strategy,
      quality,
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
    if (composed) {
      report = composedPageQualityReport(report);
    }

    if (!report.approved && composed && loadedQuality.enabled("pageQaRewrite")) {
      await updateJobProgress(options.generationJobId, {
        message: `Page ${pageDraft.index} failed local quality checks; revising.`
      });
      try {
        const revisedDraft = await options.strategy.revisePageDraft({
          input: options.input,
          plan: options.plan,
          pageIndex: pageDraft.index,
          qaCandidateNumber: 2,
          ...(options.plan.dossier?.evidencePackets?.length ? {
            researchNotes: [...options.plan.researchNotes.map((note) => `${note.title} (${note.url ?? ""}): ${note.summary}`), ...options.plan.dossier.evidencePackets.map((packet) => JSON.stringify(packet))],
            pageEditGuidance: CASE_EVIDENCE_WRITER_RULES.join(" ")
          } : {}),
          draft,
          report,
          previousPages,
          continuityNotes: [],
          textModel: options.textModel
        });
        const revisedReport = await reviewPageWithQualityGates({
          strategy: options.strategy,
          quality,
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
        if (isCancellationError(error)) {
          throw error;
        }
      }
    }

    reviewed.push({ draft, qualityReport: report, revision });
    previousPages.push({ index: draft.index, title: draft.title, markdown: draft.markdown, summary: draft.summary });
  }

  return reviewed;
}
