import {
  checkChangedPageGrounding, figureFreeProse, hasResearchIntent, withClaimVerification,
  type CreateProjectInput, type DecisionModelRoute, type GroundingPage,
  type PageDraft, type PageGroundingResult, type PageQualityReport, type TextModelAdapter
} from "@book-maker/core";
import type { QualityGateContext } from "./qualityEnrichment.js";

/** Page-local cache: source authorization/version, original and model are pinned by this call. */
export function changedCandidateGrounding(options: {
  input: CreateProjectInput;
  quality: QualityGateContext;
  pageIndex: number;
  draft: PageDraft;
  report: PageQualityReport;
  original?: GroundingPage | undefined;
  researchNotes?: string[] | undefined;
  textModel: TextModelAdapter;
  decisions?: DecisionModelRoute | undefined;
  userRequest?: string | undefined;
}) {
  if (!options.quality.enabled("changedCandidateGrounding")) {
    return async (_draft: PageDraft, report: PageQualityReport, _notes: string[]) => report;
  }
  const prose = (page: GroundingPage): GroundingPage => ({ title: page.title, markdown: figureFreeProse(page.markdown) });
  const original = prose(options.original ?? options.draft);
  const key = (candidate: GroundingPage, notes: string[]) => JSON.stringify([candidate, notes]);
  const cache = new Map<string, Promise<PageGroundingResult>>();
  // Enrichment already checked the seed. Reuse only that exact text/evidence pair,
  // never its approval: each rewrite still owns its general review's findings.
  if (!options.original) {
    cache.set(key(prose(options.draft), options.researchNotes ?? []), Promise.resolve({
      groundedOk: options.report.groundedOk ?? true,
      groundingStatus: options.report.groundingStatus ?? "not_applicable",
      unsupportedClaims: options.report.unsupportedClaims ?? []
    }));
  }
  return async (draft: PageDraft, report: PageQualityReport, researchNotes: string[]): Promise<PageQualityReport> => {
    if (!hasResearchIntent(options.input)) return { ...report, groundingStatus: "not_applicable" };
    const candidate = prose(draft);
    const identity = key(candidate, researchNotes);
    let pending = cache.get(identity);
    if (!pending) {
      pending = checkChangedPageGrounding({
        textModel: options.textModel, decisions: options.decisions,
        pageIndex: options.pageIndex, original, candidate, researchNotes, userRequest: options.userRequest
      });
      cache.set(identity, pending);
    }
    const result = await pending;
    if (result.groundingStatus === "verified" || result.groundingStatus === "failed") {
      return withClaimVerification(report, result);
    }
    // An outage/missing source is not an approval and must not erase a reviewer's failure.
    return report.groundedOk === false || report.groundingStatus === "failed"
      ? { ...report, groundedOk: false, groundingStatus: "failed", groundingAvailability: result.groundingStatus }
      : { ...report, groundingStatus: result.groundingStatus };
  };
}
