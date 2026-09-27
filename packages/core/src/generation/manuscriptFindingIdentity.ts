import { createHash } from "node:crypto";
import type { ManuscriptCoverage } from "./manuscriptCoverage.js";
import type { PictureBookRequirementTarget } from "./pictureBookRequirementTargets.js";
import { pageFindingProvenance } from "./manuscriptQualityProvenance.js";

type Requirement = ManuscriptCoverage["requirements"][number];
/** Labels identify the actor and independently testable outcome; a shared source
 * clause alone is not an identity. IDs survive ordering changes and checkpoints. */
export function coverageObligationId(brief: string, item: { text: string; quote: string; kind: string }): string {
  return `obligation-${createHash("sha256").update(JSON.stringify([brief, item.quote.trim(), item.text.trim(), item.kind])).digest("hex").slice(0, 24)}`;
}

export function requirementQualityFindingId(target: PictureBookRequirementTarget): string {
  const primary = target.evidence.find(e => e.pageIndex === target.pageIndex)!;
  const diagnosis = [target.problem, `Evidence on page ${target.pageIndex}: “${primary.quote}”`,
    ...target.evidence.filter(e => e !== primary).map(e => `Related page ${e.pageIndex}: “${e.quote}”`),
    `Requested requirement: “${target.requirementQuote}”`].join(" ");
  return pageFindingProvenance(target.pageIndex, diagnosis).findingId!;
}

export const COVERAGE_IDENTITY_GUIDANCE = "Each requirement has a local obligationId whose label names an actor and outcome. For a brief requirement, return findingIds containing only supplied requirementTargets ids that diagnose that SAME atomic obligation; match the actor, outcome, scope and original source clause. Shared quotes or pages alone do not establish identity. Assign each finding to at most one brief obligation. For a missing promise, optionally return sameFailureAs with a supplied missing brief requirement id ONLY when that single obligation fully accounts for ALL of the promise's failure. A compound promise with two unpaid arcs cannot be assigned to one. Leave links absent when uncertain. This links diagnostics only; still return every independent verdict and its evidence.";

/** Semantic alignment shares the existing manuscript read. The model selects
 * supplied IDs, while code validates references, scopes and unique ownership. */
export function bindCoverageFindingIdentities(requirements: Requirement[], answers: readonly { id: string; findingIds?: unknown; sameFailureAs?: unknown }[],
  targets: readonly PictureBookRequirementTarget[]): Requirement[] {
  const candidates = new Map<string, PictureBookRequirementTarget[]>();
  for (const requirement of requirements) {
    const matches = answers.filter(a => a.id === requirement.id);
    const ids = matches.length === 1 ? matches[0]?.findingIds : undefined;
    if (requirement.source !== "brief" || requirement.kind !== "content" || requirement.sourceQuoteIssue ||
      !Array.isArray(ids) || !ids.length || ids.length > 64 || new Set(ids).size !== ids.length) continue;
    const linked = ids.map(id => targets.find(t => t.id === id &&
      (t.requirementQuote.includes(requirement.quote) || requirement.quote.includes(t.requirementQuote))));
    if (linked.every((t): t is PictureBookRequirementTarget => t !== undefined)) candidates.set(requirement.id, linked);
  }
  const owner = (target: PictureBookRequirementTarget) => new Set(requirements.filter(r => candidates.get(r.id)?.includes(target)).map(r => r.obligationId ?? r.id));
  const bound = requirements.map(r => {
    const linked = (candidates.get(r.id) ?? []).filter(t => owner(t).size === 1);
    return linked.length ? { ...r, findingIds: linked.map(t => t.id), qualityFindingIds: linked.map(requirementQualityFindingId) } : r;
  });
  return bound.map(r => {
    const answersForRow = answers.filter(a => a.id === r.id);
    const reference = answersForRow.length === 1 ? answersForRow[0]?.sameFailureAs : undefined;
    const original = bound.find(b => b.id === reference && b.source === "brief" && b.kind === "content" && !b.sourceQuoteIssue);
    if (r.source !== "promise" || r.kind !== "content" || r.status !== "missing" || original?.status !== "missing" || !original.obligationId) return r;
    return { ...r, obligationId: original.obligationId, sameFailureAs: original.id,
      ...(original.qualityFindingIds ? { qualityFindingIds: original.qualityFindingIds } : {}) };
  });
}
