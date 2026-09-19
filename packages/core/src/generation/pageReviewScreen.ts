import { buildPageReviewPrompt } from "./pageReviewPrompt.js";
import type { DecisionModelRoute, DecisionOutcome } from "../adapters/decisions.js";
import { DecisionEvaluationEscalationError, evaluationEscalationReason, type DecisionEvaluationRequest, type DecisionQuestion } from "../adapters/decisionEvaluation.js";
import { isCancellationError } from "../adapters/retry.js";
import type { GenerateJsonOptions, TextModelAdapter } from "../adapters/types.js";
import type { PageQualityReport } from "../schemas/book.js";
import { pageScopePayload } from "./pagesShared.js";
import { runLocalPageQualityChecks } from "./pagesLocalQa.js";
import type { ReviewPageOptions } from "./pagesReview.js";

export type PageReviewDecisionMode = "off" | "shadow" | "pass";
/** Deployment switch, independent of the existing Fast decisions selection. */
export function pageReviewDecisionMode(value = process.env.BOOK_MAKER_PAGE_REVIEW_DECISIONS): PageReviewDecisionMode {
  return value === "off" || value === "pass" ? value : "shadow";
}
export const PAGE_REVIEW_SCREEN_VERSION = "page-review-screen-v1";
const dimensions = {
  fulfillment: "Does the page fulfill the sanitized CURRENT page brief, including its bounded claim, required continuity and ending pressure? Do not demand later chapter beats. The approved userRequest overrides stale assignments. Apply opening rules only where the shared reviewer contract states them.",
  progression: "Does this page add a specific new consequence, argument, discovery or completed choice? Necessary recurring actions may progress. Respect chapter-local position and existing following prose; require concrete resolution of the core promise only on the final book page.",
  repetition: "Does it avoid restaging the same encounter, exposition, decision or emotional turn from prior or following pages, including paraphrased repetition? Protect intentional repetition, quotations, recurring actions with new consequences and reader-requested repetition. Missing relevant prose is insufficient_context, not evidence of novelty.",
  continuity: "Are identities, chronology, causal relationships, negation, scope, uncertainty, attribution and established facts consistent with supplied prior/following prose, canon and continuity notes? Do not infer contradictions merely from missing context.",
  reserved_beats: "Does it leave futureChapterPageBriefs reserved? A short concluding handoff may open the next problem. Multiple paragraphs developing it or delivering its ending pressure early are a defect, even if called setup. Distinguish recurring subjects from duplicated treatment.",
  style: "Is the prose contextually natural for this book, language, genre and audience, consistent with local style guidance and pinned excerpts except for intended user edits? Protect quotations, technical language, legitimate caveats and intentional rhetorical choices. Pattern matches alone are not defects.",
  grounding: "Are factual claims and private source citations supported by supplied evidence, without overstating scope or certainty? Apply the shared citation contract exactly, including public/private source distinctions and source-identity exemptions. A named source being unfamiliar is not a defect. For claims requiring missing evidence answer insufficient_context; fiction need not have factual sources."
};
export const PAGE_REVIEW_QUESTIONS: readonly DecisionQuestion[] = Object.entries(dimensions).map(([id, instructions]) => ({
  id, type: "choice", instructions: `Use the shared editorial contract and evidence, ignoring its output-format instructions. ${instructions} Judge this dimension independently. Use clean only when the context supports a pass.`,
  options: [
    { id: "clean", description: "Sufficient evidence supports no actionable defect in this dimension." },
    { id: "defect", description: "A suspected actionable defect needs diagnostic repair instructions." },
    { id: "insufficient_context", description: "The supplied context cannot support a clean judgment." }
  ]
}));

function missingContext(options: ReviewPageOptions): boolean {
  if (!options.pageBrief?.purpose.trim() || !options.pageBrief.beat.trim() || options.pageBrief.pageIndex !== options.pageIndex) return true;
  if (options.pageIndex > 1 && !options.previousPages.some((page) => page.index === options.pageIndex - 1 && page.markdown?.trim())) return true;
  const scope = pageScopePayload(options);
  const end = scope.chapterPageEnd;
  // Edit callers carry the complete chapter brief without separate bounds.
  // Only infer its end when the chapter's declared size confirms completeness.
  if (options.chapterPageEnd === undefined && (!options.chapter || scope.chapterPageCount !== options.chapter.targetPages)) return true;
  if (!options.chapterBrief || end === undefined || end < options.pageIndex) return true;
  for (let index = options.pageIndex; index <= end; index++) {
    const pages = options.chapterBrief.pages.filter((page) => page.pageIndex === index);
    if (pages.length !== 1 || !pages[0]?.purpose.trim() || !pages[0].beat.trim()) return true;
  }
  return false;
}

function hasIntegrityDefect(options: ReviewPageOptions): boolean {
  const { checks } = runLocalPageQualityChecks(options);
  return !checks.placeholderFree || !checks.promptLeakFree;
}

/** A pass supplies approval, never a prose-quality estimate. */
export async function screenPageReview(options: ReviewPageOptions, localReport: PageQualityReport, prompt: GenerateJsonOptions<PageQualityReport>, diagnose: (textModel: TextModelAdapter, prompt: GenerateJsonOptions<PageQualityReport>) => Promise<PageQualityReport>): Promise<PageQualityReport> {
  const mode = options.pageReviewDecisionMode ?? pageReviewDecisionMode();
  if (!options.decisions || mode === "off") return diagnose(options.textModel, prompt);
  const started = Date.now();
  const outcome: DecisionOutcome = { purpose: "screen-page-review", version: PAGE_REVIEW_SCREEN_VERSION, pageIndex: options.pageIndex, mode, rewriteAvoided: false, reviewAvoided: false, wouldAvoidReview: false };
  let textModel = options.textModel;
  let clean = false;
  let resolved = false;
  try {
    try {
      options.signal?.throwIfAborted();
      const adapter = await options.decisions.resolve();
      resolved = true;
      options.signal?.throwIfAborted();
      if (!adapter?.evaluate) outcome.escalationReason = "routing_unavailable";
      else if (options.skipLocalChecks && hasIntegrityDefect(options)) outcome.escalationReason = "integrity_defect";
      else if (missingContext(options)) outcome.escalationReason = "insufficient_context";
      else {
        prompt = buildPageReviewPrompt(options, true);
        // The diagnostic still uses the same original prompt, with this frozen evidence pack.
        const prepared = await textModel.prepareReviewContext?.(prompt);
        if (prepared) textModel = prepared.textModel;
        const request: DecisionEvaluationRequest = {
          purpose: outcome.purpose, signal: options.signal, escalationPolicy: "caller",
          sourceContextPrepared: Boolean(prepared),
          context: JSON.stringify({ reviewerContext: prepared?.messages ?? prompt.messages }),
          questions: PAGE_REVIEW_QUESTIONS
        };
        const result = await adapter.evaluate(request);
        options.signal?.throwIfAborted();
        outcome.answers = result.answers;
        const escalation = evaluationEscalationReason(request, result, true);
        const flagged = escalation ? undefined : Object.entries(result.answers).find(([, answer]) => answer.type !== "choice" || answer.selectedOption !== "clean");
        outcome.escalationReason = escalation ?? (flagged ? `${flagged[0]}:${flagged[1].type === "choice" ? flagged[1].selectedOption : "invalid_type"}` : undefined);
        clean = !outcome.escalationReason;
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      if (isCancellationError(error)) throw error;
      outcome.escalationReason = error instanceof DecisionEvaluationEscalationError ? error.reason : resolved ? "provider_failure" : "routing_unavailable";
      if (error instanceof DecisionEvaluationEscalationError) outcome.answers = error.result?.answers;
    }
    outcome.screenDurationMs = Date.now() - started;
    outcome.wouldAvoidReview = clean;
    if (clean && mode === "pass") {
      outcome.reviewAvoided = true;
      return { ...localReport, approved: true, score: 75, scoreBasis: "screened_unscored", issues: [], requiredRevisions: [], notes: "Jev independently screened page-review dimensions. Score is an unranked compatibility value, not a quality estimate." };
    }
    const report = await diagnose(textModel, prompt);
    options.signal?.throwIfAborted();
    outcome.diagnosticApproved = report.approved;
    if (outcome.answers) outcome.disagreement = clean !== report.approved;
    return report;
  } catch (error) {
    if (options.signal?.aborted || isCancellationError(error)) outcome.escalationReason = "cancelled";
    throw error;
  } finally {
    outcome.totalDurationMs = Date.now() - started;
    await recordOutcome(options.decisions, outcome);
    options.signal?.throwIfAborted();
  }
}

async function recordOutcome(decisions: DecisionModelRoute, outcome: DecisionOutcome): Promise<void> {
  try { await decisions.recordOutcome?.(outcome); } catch (error) {
    if (isCancellationError(error)) throw error;
    // Diagnostic writes cannot alter a verdict.
  }
}
