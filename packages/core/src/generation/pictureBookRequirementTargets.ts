import { createHash } from "node:crypto";
import { z } from "zod";

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

export function validRequirementTargets(brief: string, pages: readonly Page[], targets: readonly PictureBookRequirementTarget[]): PictureBookRequirementTarget[] {
  const unique = new Set<string>();
  return targets.filter(target => pictureBookRequirementTargetSchema.safeParse(target).success && !unique.has(target.id) &&
    brief.includes(target.requirementQuote) && [manuscriptRequirementId(brief, target.requirementQuote, target),
      manuscriptRequirementId(brief, target.requirementQuote)].includes(target.requirementId) &&
    target.evidence.some(e => e.pageIndex === target.pageIndex) &&
    target.evidence.every(e => pages.some(p => p.index === e.pageIndex && p.markdown.includes(e.quote))) && Boolean(unique.add(target.id)));
}
