import { createHash } from "node:crypto";
import { z } from "zod";
import type { PictureBookPageReview } from "./pictureBookReviewValidation.js";

const evidenceSchema = z.strictObject({ pageIndex: z.number().int().positive(), quote: z.string().min(12).max(700) });
export const pictureBookRequirementTargetSchema = z.strictObject({
  id: z.string().min(1), requirementId: z.string().min(1), requirementQuote: z.string().min(1).max(700),
  pageIndex: z.number().int().positive(), problem: z.string().min(1).max(500),
  acceptanceCriteria: z.string().min(1).max(500), evidence: z.array(evidenceSchema).min(1).max(4)
});
export type PictureBookRequirementTarget = z.infer<typeof pictureBookRequirementTargetSchema>;
export const pictureBookRequirementAssessmentSchema = z.strictObject({
  findingId: z.string().min(1), resolved: z.boolean(), noNewRegressions: z.boolean(),
  reason: z.string().trim().min(1).max(700), evidence: z.array(evidenceSchema).max(4)
});
export type PictureBookRequirementAssessment = z.infer<typeof pictureBookRequirementAssessmentSchema>;
type Page = { index: number; markdown: string };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
export const manuscriptRequirementId = (brief: string, quote: string, atom?: { problem: string; acceptanceCriteria: string }) =>
  `requirement-${digest(atom ? [brief, quote.trim(), atom.problem, atom.acceptanceCriteria] : [brief, quote.trim()])}`;

/** Only call with a complete review whose context/manuscript fingerprint was checked.
 * Persisted findings are also checked against their actual source spans here. */
export function pictureBookRequirementTargets(brief: string, pages: readonly Page[], reviews: readonly PictureBookPageReview[]): PictureBookRequirementTarget[] {
  const targets = new Map<string, PictureBookRequirementTarget>();
  for (const review of reviews) {
    if (!review.completedChecks.pageModelReview || !pages.some(p => p.index === review.pageIndex && p.markdown === review.draftMarkdown)) continue;
    for (const finding of review.findings ?? []) {
      if (finding.domain !== "prose" || finding.basis !== "missing_requirement" || !finding.requirementQuote) continue;
      const requirementId = manuscriptRequirementId(brief, finding.requirementQuote, { problem: finding.message, acceptanceCriteria: finding.guidance });
      // Retain the existing finding identity across repair checkpoints. Its
      // diagnosis/criterion already distinguish actors; requirementId now does too.
      const target = { id: `finding-${digest([manuscriptRequirementId(brief, finding.requirementQuote), review.pageIndex, finding.message, finding.guidance])}`,
        requirementId, requirementQuote: finding.requirementQuote, pageIndex: review.pageIndex,
        problem: finding.message, acceptanceCriteria: finding.guidance,
        evidence: [{ pageIndex: review.pageIndex, quote: finding.quote }, ...finding.relatedEvidence] };
      if (validRequirementTargets(brief, pages, [target]).length) targets.set(target.id, target);
    }
  }
  return [...targets.values()].sort((a, b) => a.pageIndex - b.pageIndex || a.id.localeCompare(b.id));
}

export function validRequirementTargets(brief: string, pages: readonly Page[], targets: readonly PictureBookRequirementTarget[]): PictureBookRequirementTarget[] {
  const unique = new Set<string>();
  return targets.filter(target => pictureBookRequirementTargetSchema.safeParse(target).success && !unique.has(target.id) &&
    brief.includes(target.requirementQuote) && [manuscriptRequirementId(brief, target.requirementQuote, target),
      manuscriptRequirementId(brief, target.requirementQuote)].includes(target.requirementId) &&
    target.evidence.some(e => e.pageIndex === target.pageIndex) &&
    target.evidence.every(e => pages.some(p => p.index === e.pageIndex && p.markdown.includes(e.quote))) && Boolean(unique.add(target.id)));
}

/** A missing assessment never becomes an implicit clean verdict. Evidence must be
 * from the full candidate, including any later scene where a multi-scene fix pays off. */
export function requirementAssessmentErrors(targets: readonly PictureBookRequirementTarget[], pageIndex: number,
  assessments: readonly PictureBookRequirementAssessment[] | undefined, pages: ReadonlyMap<number, Page>): string[] {
  const expected = targets.filter(t => t.pageIndex === pageIndex);
  const actual = assessments ?? [];
  const errors: string[] = [];
  if (expected.some(t => actual.filter(a => a.findingId === t.id).length !== 1) ||
    actual.some(a => !expected.some(t => t.id === a.findingId)))
    errors.push("Return exactly one requirementAssessment per finding owned by this page; do not omit, duplicate or invent finding IDs.");
  for (const assessment of actual) {
    if (!pictureBookRequirementAssessmentSchema.safeParse(assessment).success ||
      (assessment.resolved && !assessment.evidence.length) ||
      assessment.evidence.some(e => !pages.get(e.pageIndex)?.markdown.includes(e.quote)))
      errors.push("A resolved requirement needs exact candidate-prose evidence; all supplied resolution evidence must match its cited page.");
  }
  return errors;
}
