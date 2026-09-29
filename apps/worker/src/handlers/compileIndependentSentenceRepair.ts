import { pictureBookPageReview, isInheritedRepairFinding,
  type repairPictureBookManuscript, type PictureBookPageReview, type PictureBookRepairContext } from "@book-maker/core";

type Candidate = Awaited<ReturnType<typeof repairPictureBookManuscript>>;

/** Narrow fallback: only individually accepted original sentence targets, with
 * every semantic edit restored. The result is NOT accepted until freshly reviewed. */
export function independentSentenceCandidate(originals: Candidate["pages"], candidate: Candidate,
  reviews: PictureBookPageReview[], baseline: PictureBookPageReview[]): Candidate | undefined {
  if (candidate.context.sentenceOnly || !candidate.context.sentenceOnlyPageIndexes?.length ||
    baseline.length !== originals.length || originals.some(page => baseline.find(review => review.pageIndex === page.index)?.draftMarkdown !== page.markdown)) return;
  const changes = candidate.context.changes.filter(change => {
    const review = reviews.find(item => item.pageIndex === change.pageIndex);
    return candidate.context.sentenceOnlyPageIndexes!.includes(change.pageIndex) &&
      review?.draftMarkdown === candidate.pages.find(page => page.index === change.pageIndex)?.markdown &&
      review?.report.approved && review.repairAssessment?.targetResolved && review.repairAssessment.meaningPreserved && review.repairAssessment.noNewRegressions &&
      !reviews.some(item => [...(item.findings ?? []), ...(item.unverifiedFindings ?? [])].some(finding =>
        finding.relatedEvidence.some(evidence => evidence.pageIndex === change.pageIndex)));
  });
  if (!changes.length || changes.length === candidate.context.changes.length) return;
  const indexes = new Set(changes.map(change => change.pageIndex));
  const context: PictureBookRepairContext = { sentenceOnly: true, sentenceOnlyPageIndexes: [...indexes], changes,
    issues: candidate.context.issues.flatMap(issue => issue.messages.flatMap(message => {
      const label = /^Page (\d+): /u.exec(message);
      const owners = label && issue.pageIndexes.includes(Number(label[1])) ? [Number(label[1])] : issue.pageIndexes;
      return owners.filter(index => indexes.has(index)).map(index => ({ pageIndexes: [index], messages: [message] }));
    })) };
  // Residual continuity, requirements, unverified evidence or local failures do
  // not authorize this optimization. Keep the existing strict acceptance rules.
  if (baseline.some(review => !indexes.has(review.pageIndex) &&
    (review.unverifiedFindings?.length || review.storyExtract?.contradictions.length ||
      (review.findings ?? []).some(finding => !isInheritedRepairFinding(finding, review.pageIndex, context))))) return;
  return { context, pages: originals.map(page => indexes.has(page.index) ? candidate.pages.find(item => item.index === page.index)! : page) };
}

/** Restored prose keeps its grounded original diagnoses even if the new model
 * overlooks them. Fresh candidate checks/state remain authoritative for regressions. */
export function retainRestoredSceneFindings(reviews: PictureBookPageReview[], baseline: PictureBookPageReview[], context: PictureBookRepairContext): void {
  for (const review of reviews) {
    const original = baseline.find(item => item.pageIndex === review.pageIndex);
    if (!original || original.draftMarkdown !== review.draftMarkdown) continue;
    const retained = (original.findings ?? []).filter(finding => isInheritedRepairFinding(finding, review.pageIndex, context) &&
      !(review.findings ?? []).some(current => JSON.stringify(current) === JSON.stringify(finding)));
    if (!retained.length) continue;
    const report = pictureBookPageReview({ pageIndex: review.pageIndex, score: review.report.score,
      findings: retained, storyExtract: null, styleAudit: null },
      { index: review.pageIndex, markdown: review.draftMarkdown, title: "", summary: "" },
      { pageModelReview: true, storyExtractAudit: false, styleAuditor: false }, "").report;
    review.findings = [...(review.findings ?? []), ...retained];
    review.report = { ...review.report, approved: false, score: Math.min(review.report.score, original.report.score),
      issues: [...review.report.issues, ...report.issues], requiredRevisions: [...review.report.requiredRevisions, ...report.requiredRevisions],
      checks: Object.fromEntries(Object.entries(review.report.checks).map(([key, value]) =>
        [key, value && report.checks[key as keyof typeof report.checks]])) as typeof report.checks };
  }
}
