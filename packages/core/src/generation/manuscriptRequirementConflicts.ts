import type { ManuscriptCoverage } from "./manuscriptCoverage.js";
import type { PictureBookRequirementTarget } from "./pictureBookRequirementTargets.js";
import { requirementQualityFindingId } from "./manuscriptFindingIdentity.js";

/** These findings belong to the same final manuscript. Neither semantic reviewer
 * overrides the other; contradictory verdicts remain visible for adjudication. */
export function reconcileRequirementFindings(review: ManuscriptCoverage, targets: readonly PictureBookRequirementTarget[]): ManuscriptCoverage {
  if (!targets.length) return review;
  const matchingRequirements = (target: PictureBookRequirementTarget) => {
    const bound = review.requirements.filter(r => r.source === "brief" && r.findingIds?.includes(target.id));
    return bound.length ? bound : review.requirements.filter(requirement =>
      requirement.source === "brief" && requirement.quote.trim() === target.requirementQuote.trim());
  };
  const requirements = review.requirements.map(requirement => {
    const conflicts = targets.filter(target => matchingRequirements(target).length === 1 &&
      matchingRequirements(target).includes(requirement));
    if (!conflicts.length || requirement.status !== "fulfilled") return requirement;
    return { ...requirement, status: "unverified" as const,
      reason: `Reviewers disagree. Coverage: ${requirement.reason} Outstanding prose review: ${conflicts.map(target => `${target.problem} Acceptance criterion: ${target.acceptanceCriteria}`).join(" ")}` };
  });
  // A differently inventoried clause cannot silently erase an outstanding finding.
  // Shared clauses can describe distinct actors' arcs; do not merge their verdicts
  // or guess which one a finding belongs to from text similarity.
  for (const target of targets) {
    if (matchingRequirements(target).length === 1) continue;
    requirements.push({ id: target.id, source: "brief", quote: target.requirementQuote, text: target.requirementQuote,
      kind: "content", status: "unverified", evidence: target.evidence,
      obligationId: target.id, qualityFindingIds: [requirementQualityFindingId(target)],
      reason: `An outstanding prose finding was not aligned with the coverage inventory unambiguously: ${target.problem} Acceptance criterion: ${target.acceptanceCriteria}` });
  }
  return { ...review, requirements,
    status: review.status === "reviewed" && requirements.some(requirement => requirement.status === "unverified") ? "incomplete" : review.status };
}
