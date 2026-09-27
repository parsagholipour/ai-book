/** Delivery, assessed coverage and human editorial approval answer different questions. */
export function summarizeQualityAcceptance(review, pages) {
  const coverage = review?.briefCoverage?.review;
  const requirements = Array.isArray(coverage?.requirements) ? coverage.requirements : [];
  const missingRequirements = requirements.filter(r => r.status === "missing");
  const unverifiedRequirements = requirements.filter(r => !["fulfilled", "missing"].includes(r.status));
  const complete = coverage?.status === "reviewed" && coverage.assessmentComplete === true && requirements.length > 0 && unverifiedRequirements.length === 0;
  const semantic = {
    status: complete ? "complete" : coverage?.status === "unavailable" ? "unavailable" : coverage ? "incomplete" : "unknown",
    passed: !coverage ? null : complete && missingRequirements.length === 0,
    requirementCount: requirements.length,
    missingRequirements: missingRequirements.map(r => ({ id: r.id, text: r.text, reason: r.reason })),
    unverifiedRequirements: unverifiedRequirements.map(r => ({ id: r.id, text: r.text, reason: r.reason }))
  };
  const residualIssues = Array.isArray(review?.issues) ? review.issues : [];
  const failedPageIndexes = pages.filter(p => p.status === "FAILED_QA" || p.qualityReport?.approved === false).map(p => p.index);
  const knownState = ["passed", "review_recommended", "blocked"].includes(review?.state);
  const quality = {
    state: knownState ? review.state : "unknown",
    passed: residualIssues.length || failedPageIndexes.length ? false : knownState ? review.state === "passed" : null,
    residualIssues, failedPageIndexes,
    score: Number.isFinite(review?.score) ? review.score : null,
    scoreBasis: review?.scoreBasis ?? "legacy_diagnostic_count",
    scoreMeaning: "Unresolved findings indicator, not an editorial rating or proof of correctness."
  };
  return { semantic, quality, qualityPassed: quality.passed, semanticPassed: semantic.passed };
}

export function acceptanceStatus({ functionalPassed, performance, qualityPassed, semanticPassed }) {
  if (!functionalPassed || performance.passed === false || qualityPassed === false || semanticPassed === false) return "failed";
  if (performance.passed !== true || qualityPassed !== true || semanticPassed !== true) return "unassessed";
  return "human_review_pending";
}

export function allAssessed(values) {
  return values.some(v => v === false) ? false : values.every(v => v === true) ? true : null;
}
