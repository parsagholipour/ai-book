import { z } from "zod";
import type { CoverageEvidenceContext, CoveragePage, ManuscriptCoverage } from "./manuscriptCoverage.js";
import { storyPageCountVerdict } from "./manuscriptCoverageDelivery.js";

export const extraPageApplicabilitySchema = z.object({
  kind: z.literal("extra_story_pages"),
  status: z.enum(["applicable", "not_applicable", "unverified"]),
  requestedStoryPages: z.number().int().positive().optional(),
  extraPageIndexes: z.array(z.number().int().positive())
});
type Applicability = z.infer<typeof extraPageApplicabilitySchema>;
type Requirement = Pick<ManuscriptCoverage["requirements"][number], "source" | "kind" | "quote" | "scope" | "sourceQuoteIssue">;

/** Recognize the app's complete optional-page clause, never a model label or a
 * compound obligation. Other conditional wording still requires semantic review. */
export function extraPageProgressionApplicability(requirement: Requirement, context?: CoverageEvidenceContext, pages?: readonly CoveragePage[]): Applicability | undefined {
  const supportedClause = (quote: string) => /^Extra pages are optional and must add meaningful progression\.?$/i.test(quote.trim());
  if (requirement.source !== "brief" || requirement.kind !== "content" || requirement.sourceQuoteIssue || !supportedClause(requirement.quote) ||
    (requirement.scope && (!(requirement.scope.extent === "whole_book" || requirement.scope.extent === "specified") ||
      requirement.scope.quote !== requirement.quote))) return undefined;
  const requested = context?.requestedStoryPages;
  const knownMinimum = requested !== undefined && Number.isSafeInteger(requested) && requested > 0;
  const unknown: Applicability = { kind: "extra_story_pages", status: "unverified", extraPageIndexes: [],
    ...(knownMinimum ? { requestedStoryPages: requested } : {}) };
  const bounds = context?.storyPageCountBounds;
  if (!context || !knownMinimum || !Number.isSafeInteger(context.targetStoryPages) || context.targetStoryPages < requested ||
    (bounds && (!Number.isSafeInteger(bounds.minimumPages) || !Number.isSafeInteger(bounds.maximumPages) ||
      bounds.minimumPages < requested || bounds.maximumPages < bounds.minimumPages)) || context.storyPageIndexes.length < requested ||
    storyPageCountVerdict(context.targetStoryPages, context).status !== "fulfilled") return unknown;
  const indexes = [...context.storyPageIndexes].sort((a, b) => a - b);
  if (pages) {
    const actual = pages.map(page => page.index).sort((a, b) => a - b);
    if (actual.length !== indexes.length || actual.some((index, offset) => index !== indexes[offset])) return unknown;
  }
  const extraPageIndexes = indexes.filter(index => index > requested);
  return { kind: "extra_story_pages", status: extraPageIndexes.length ? "applicable" : "not_applicable",
    requestedStoryPages: requested, extraPageIndexes };
}

export function extraPageProgressionFactVerdict(applicability?: Applicability) {
  if (!applicability || applicability.status === "applicable") return undefined;
  return applicability.status === "not_applicable"
    ? { status: "fulfilled" as const, reason: `Not applicable: the manuscript uses only the ${applicability.requestedStoryPages} requested story pages; no optional extra pages need progression evidence.` }
    : { status: "unverified" as const, reason: "Extra-page progression cannot be assessed without a known original page minimum and a complete, consistent delivered page map." };
}

export function hasExtraPageEvidence(applicability: Applicability, evidence: readonly { pageIndex: number }[]): boolean {
  return applicability.extraPageIndexes.every(index => evidence.some(item => item.pageIndex === index));
}

/** A cached no-extra-page pass cannot become approval of newly added prose. */
export function refreshExtraPageProgression(requirement: ManuscriptCoverage["requirements"][number], context: CoverageEvidenceContext, pages?: readonly CoveragePage[]) {
  const applicability = extraPageProgressionApplicability(requirement, context, pages);
  if (!applicability) return undefined;
  const fact = extraPageProgressionFactVerdict(applicability);
  if (fact) return { ...requirement, ...fact, applicability, evidence: [] };
  const previous = requirement.applicability;
  const samePages = previous?.status === "applicable" && previous.requestedStoryPages === applicability.requestedStoryPages &&
    previous.extraPageIndexes.length === applicability.extraPageIndexes.length &&
    previous.extraPageIndexes.every((index, offset) => index === applicability.extraPageIndexes[offset]);
  if (samePages && (requirement.status !== "fulfilled" || hasExtraPageEvidence(applicability, requirement.evidence))) return { ...requirement, applicability };
  return { ...requirement, applicability, status: "unverified" as const,
    reason: "The optional extra pages require a prose assessment with exact progression evidence for every added page." };
}

export const EXTRA_PAGE_PROGRESSION_GUIDANCE = "For requirements with applicability.kind extra_story_pages, code derives applicability from the original requested minimum and delivered page map. When applicable, assess whether every listed extraPageIndex adds meaningful progression in the context of the full story. Fulfilled needs exact prose evidence from every extra page showing new action, a consequential choice or a payoff; merely having text is insufficient. The selected total does not replace the original minimum. Do not waive this condition when extra pages exist.";
