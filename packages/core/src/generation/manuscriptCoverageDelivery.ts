import { z } from "zod";
import type { CoverageEvidenceContext } from "./manuscriptCoverage.js";
import { deliveryPromiseFacts, type DeliveryObligation } from "./manuscriptCoveragePromises.js";
import { mediaAbsenceScopes, mediaAbsenceVerdict } from "./manuscriptCoverageMedia.js";
import { countReadableWords } from "./proseShape.js";
import { figureFreeProse } from "./figures/figureBlocks.js";
import { pageCountConstraintSchema, requirementScopeSchema } from "../schemas/manuscriptRequirements.js";
import { pageCountRequirementVerdict } from "./manuscriptPageCount.js";

/** Match the local prose QA measurement; figure specifications are not words. */
export function coverageStoryPageWordCounts(pages: readonly { index: number; markdown: string }[]) {
  return pages.map(page => ({ index: page.index, words: countReadableWords(figureFreeProse(page.markdown)) })).sort((a, b) => a.index - b.index);
}

const result = { status: z.enum(["fulfilled", "missing", "unverified"]), reason: z.string() };
export const deliveryCheckSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page_count"), quote: z.string(), expectedCount: z.number().int().positive(), requireNonempty: z.literal(true).optional(),
    pageCountConstraint: pageCountConstraintSchema.optional(), scope: requirementScopeSchema.optional(), ...result }),
  z.object({ kind: z.literal("word_range"), quote: z.string(), minWords: z.number().int().positive(), maxWords: z.number().int().positive(), ...result }),
  z.object({ kind: z.literal("media_absence"), quote: z.string(), mediaScope: z.enum(["story_pages", "cover", "all", "character_references"]), ...result })
]);
type Verdict = Pick<z.infer<typeof deliveryCheckSchema>, "status" | "reason">;

/** Count original-target promises against the configured allowance, then the
 * fixed selected map. Unrelated quantities and legacy contexts remain exact. */
export function storyPageCountVerdict(expectedCount: number, context: CoverageEvidenceContext): Verdict {
  const bounds = context.storyPageCountBounds &&
    (expectedCount === context.requestedStoryPages || expectedCount === context.targetStoryPages)
    ? context.storyPageCountBounds : { minimumPages: expectedCount, maximumPages: expectedCount };
  const indexes = [...context.storyPageIndexes].sort((a, b) => a - b);
  const valid = indexes.length >= bounds.minimumPages && indexes.length <= bounds.maximumPages &&
    indexes.every((index, offset) => index === offset + 1);
  const expected = bounds.minimumPages === bounds.maximumPages ? String(bounds.minimumPages) : `${bounds.minimumPages}–${bounds.maximumPages}`;
  return { status: valid ? "fulfilled" : "missing", reason: `The manuscript has ${indexes.length} story-page records; the configured delivery requires ${expected} uniquely numbered pages from 1. Front matter is excluded.` };
}

/** Store separate evidence for every atom and recompute it from fresh facts.
 * Never trust a model-supplied/cached subset of obligations to clear its parent. */
export function deliveryCoverageVerdict(requirement: { source: string; kind: string; quote: string; mediaScope?: string | undefined }, context?: CoverageEvidenceContext) {
  const media = requirement.kind === "media_absence" && requirement.mediaScope ? mediaAbsenceScopes(requirement.quote) : undefined;
  const obligations = requirement.source === "promise" && requirement.kind === "content" ? deliveryPromiseFacts(requirement.quote)
    : media?.map(mediaScope => ({ kind: "media_absence" as const, quote: requirement.quote, mediaScope }));
  if (!obligations) return undefined;
  const deliveryChecks = obligations.map(obligation => ({ ...obligation, ...assessDeliveryObligation(obligation, context) }));
  return { status: deliveryChecks.some(c => c.status === "missing") ? "missing" as const
    : deliveryChecks.some(c => c.status === "unverified") ? "unverified" as const : "fulfilled" as const,
    reason: deliveryChecks.map(c => c.reason).join(" "), deliveryChecks };
}

export function assessDeliveryObligation(obligation: DeliveryObligation, context?: CoverageEvidenceContext): Verdict {
  if (obligation.kind === "media_absence") return mediaAbsenceVerdict(obligation.mediaScope, context?.mediaInventory);
  if (!context) return { status: "unverified", reason: "Actual story-page facts were not supplied." };
  const indexes = [...context.storyPageIndexes].sort((a, b) => a - b);
  if (obligation.kind === "page_count") {
    const verdict = pageCountRequirementVerdict(obligation, context);
    if (verdict.status === "fulfilled" && obligation.requireNonempty) {
      const counts = actualWordCounts(context, indexes);
      if (!counts) return { status: "unverified", reason: "Actual prose word counts were not supplied for every promised story page." };
      const empty = counts.filter(count => count.words === 0);
      return { status: empty.length ? "missing" : "fulfilled", reason: empty.length
        ? `Promised story pages contain no prose: ${empty.map(count => count.index).join(", ")}.`
        : `All ${indexes.length} uniquely numbered story pages contain prose. Narrative completeness is assessed separately.` };
    }
    return verdict;
  }
  const counts = actualWordCounts(context, indexes);
  if (!counts)
    return { status: "unverified", reason: "Actual word counts were not supplied for every story page." };
  const outside = counts.filter(c => c.words < obligation.minWords || c.words > obligation.maxWords);
  return { status: outside.length ? "missing" : "fulfilled", reason: outside.length
    ? `Story pages outside the promised ${obligation.minWords}–${obligation.maxWords} words: ${outside.map(c => `${c.index} (${c.words})`).join(", ")}.`
    : `Every story page has ${obligation.minWords}–${obligation.maxWords} words.` };
}

function actualWordCounts(context: CoverageEvidenceContext, indexes: readonly number[]) {
  const counts = context.storyPageWordCounts;
  return counts && indexes.length > 0 && new Set(indexes).size === indexes.length && counts.length === indexes.length &&
    new Set(counts.map(c => c.index)).size === indexes.length &&
    counts.every(c => indexes.includes(c.index) && Number.isSafeInteger(c.words) && c.words >= 0) ? counts : undefined;
}
