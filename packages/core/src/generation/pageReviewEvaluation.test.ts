import { expect, it } from "vitest";
import { summarizePageReviewObservations } from "./pageReviewEvaluation.js";

it("separates fallback, potential savings, actual savings, disagreements and independently labeled misses", () => {
  const base = { purpose: "screen-page-review", version: "v1", rewriteAvoided: false, mode: "shadow" as const, reviewAvoided: false };
  const report = summarizePageReviewObservations([
    { id: "clean-disagrees", elapsedMs: 100, diagnosticCalls: 1, adjudication: "clean", outcome: { ...base, wouldAvoidReview: true, disagreement: true, answers: {} } },
    { id: "miss", elapsedMs: 300, diagnosticCalls: 1, adjudication: "defect", outcome: { ...base, wouldAvoidReview: true, disagreement: false, answers: {} } },
    { id: "uncertain", elapsedMs: 200, diagnosticCalls: 2, outcome: { ...base, wouldAvoidReview: false } },
    { id: "local-failure", elapsedMs: 1, diagnosticCalls: 0 }
  ]);
  expect(report).toMatchObject({ examples: 4, screenOpportunities: 3, diagnosticCalls: 4, fallbackFrequency: 1 / 3, avoidedDiagnosticCalls: 0, potentialAvoidedDiagnosticCalls: 2, comparable: 2, disagreementRate: 0.5, disagreements: ["clean-disagrees"], independentlyConfirmedMisses: ["miss"], totalLatencyMs: { p50: 100, p95: 300 } });
});
it("reports unavailable comparisons as null, not zero disagreements", () => {
  expect(summarizePageReviewObservations([])).toMatchObject({ fallbackFrequency: null, disagreementRate: null, totalLatencyMs: { p50: null, p95: null } });
});
