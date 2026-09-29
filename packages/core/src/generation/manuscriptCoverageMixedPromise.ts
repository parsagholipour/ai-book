import { z } from "zod";
import type { CoverageEvidenceContext, CoveragePage } from "./manuscriptCoverage.js";
import { coverageCitationResolver } from "./manuscriptCoverageCitations.js";
import { assessDeliveryObligation } from "./manuscriptCoverageDelivery.js";
import { mediaAbsenceScopes } from "./manuscriptCoverageMedia.js";
import type { DeliveryObligation } from "./manuscriptCoveragePromises.js";
import type { PageCountConstraint, RequirementScope } from "../schemas/manuscriptRequirements.js";

const narrativeSchema = z.strictObject({
  status: z.enum(["fulfilled", "missing", "unverified"]), reason: z.string().trim().min(1),
  evidence: z.array(z.strictObject({ pageIndex: z.number().int().positive(), quote: z.string().min(1) }))
});
/** Store the prose judgment independently; final asset facts must never rewrite it. */
export const mixedPromiseAssessmentSchema = z.strictObject({
  promiseQuote: z.string().min(1),
  deliveryRequirements: z.array(z.strictObject({ id: z.string(), quote: z.string().min(1) })).min(1).max(64),
  narrative: narrativeSchema
});
type Assessment = z.infer<typeof mixedPromiseAssessmentSchema>;
type Requirement = {
  id: string; source: string; kind: string; quote: string; expectedCount?: number | undefined;
  pageCountConstraint?: PageCountConstraint | undefined; scope?: RequirementScope | undefined;
  mediaScope?: "story_pages" | "cover" | "all" | "character_references" | undefined;
  sourceQuoteIssue?: string | undefined; deliveryBinding?: unknown;
  mixedPromiseAssessment?: Assessment | undefined;
};

export const MIXED_PROMISE_GUIDANCE =
  "For a promise combining narrative obligations with page-count or media-absence obligations, return mixedPromiseAssessment:{promiseQuote,deliveryRequirements:[{id,quote}],narrative:{status,reason,evidence:[{pageIndex,quote}]}}. Copy the ENTIRE promiseQuote exactly. Link every delivery obligation to an equivalent grounded brief page_count or media_absence item in factRequirements using its exact id and quote. Link only obligations the promise actually contains; never other promises or approximate/conditional matches. The narrative assessment must assess ALL remaining meaning of the complete promise, including ending, progression, tone, arcs, qualifiers and conditions; do not silently drop unknown clauses. Fulfilled narrative needs exact current-prose evidence. Unknown assets must not make an otherwise verified narrative unverified: code combines its verdict with fresh delivery facts. Conversely, empty assets or a matching page count never prove an ending or character change. If any delivery clause cannot be mapped exactly, omit mixedPromiseAssessment and assess the entire promise normally. Never combine it with deliveryBinding. This separates evidence within the existing read; it does not waive any obligation.";

function obligations(requirement: Requirement, assessment: Assessment, requirements: readonly Requirement[], context?: CoverageEvidenceContext): DeliveryObligation[] | undefined {
  if (requirement.source !== "promise" || requirement.kind !== "content" || requirement.sourceQuoteIssue || requirement.deliveryBinding ||
    assessment.promiseQuote !== requirement.quote || new Set(assessment.deliveryRequirements.map(r => r.id)).size !== assessment.deliveryRequirements.length) return undefined;
  const atoms: DeliveryObligation[] = [];
  for (const link of assessment.deliveryRequirements) {
    const matches = requirements.filter(r => r.id === link.id);
    const target = matches.length === 1 ? matches[0] : undefined;
    if (!target || target.source !== "brief" || target.sourceQuoteIssue || target.quote !== link.quote) return undefined;
    if (target.kind === "media_absence" && target.mediaScope) {
      for (const mediaScope of mediaAbsenceScopes(target.quote) ?? [target.mediaScope]) {
        atoms.push({ kind: "media_absence", quote: target.quote, mediaScope });
      }
    } else if (target.kind === "page_count") {
      const constraint = target.pageCountConstraint;
      const expectedCount = target.expectedCount ?? (constraint?.kind === "range" ? constraint.minimum : constraint?.count) ?? context?.targetStoryPages;
      const source = target.scope?.quote.includes(target.quote) ? target.scope.quote : target.quote;
      if (!expectedCount || !Number.isSafeInteger(expectedCount) || expectedCount < 1 ||
        (expectedCount !== context?.targetStoryPages && !source.includes(String(expectedCount)))) return undefined;
      atoms.push({ kind: "page_count", quote: target.quote, expectedCount,
        ...(constraint ? { pageCountConstraint: constraint } : {}), ...(target.scope ? { scope: target.scope } : {}) });
    } else return undefined;
  }
  return atoms;
}

const invalid = () => ({ status: "unverified" as const,
  reason: "The mixed promise's separate narrative assessment and delivery obligations could not be validated.", deliveryChecks: [] });

/** Called again after serialization with fresh export facts. Never reuse passing delivery checks. */
export function mixedPromiseVerdict(requirement: Requirement, requirements: readonly Requirement[], context?: CoverageEvidenceContext) {
  const assessment = requirement.mixedPromiseAssessment;
  if (!assessment) return undefined;
  const atoms = obligations(requirement, assessment, requirements, context);
  if (!atoms) return invalid();
  const deliveryChecks = atoms.map(atom => ({ ...atom, ...assessDeliveryObligation(atom, context) }));
  const narrative = assessment.narrative;
  const statuses = [narrative.status, ...deliveryChecks.map(check => check.status)];
  return { status: statuses.includes("missing") ? "missing" as const
    : statuses.includes("unverified") ? "unverified" as const : "fulfilled" as const,
    reason: [narrative.reason, ...deliveryChecks.map(check => check.reason)].join(" "), deliveryChecks };
}

/** An optional malformed response cannot discard other requirements or gain a pass.
 * Evidence is checked before its narrative verdict becomes reusable at export. */
export function assessMixedPromise(options: {
  requirement: Requirement; value: unknown; requirements: readonly Requirement[]; context?: CoverageEvidenceContext | undefined;
  pages: readonly CoveragePage[]; assessmentComplete: boolean;
  missingScopeConcern?: string | undefined;
}) {
  if (options.value === undefined || options.requirement.source !== "promise" || options.requirement.kind !== "content") return undefined;
  const parsed = mixedPromiseAssessmentSchema.safeParse(options.value);
  if (!parsed.success || !obligations(options.requirement, parsed.data, options.requirements, options.context)) return invalid();
  const resolve = coverageCitationResolver(options.pages);
  const narrative = parsed.data.narrative;
  const evidence = narrative.evidence.flatMap(citation => resolve(citation) ?? []);
  if (narrative.status === "fulfilled" && (!evidence.length || evidence.length !== narrative.evidence.length)) {
    narrative.status = "unverified";
    narrative.reason = `Unverified narrative assessment: ${narrative.reason} The cited evidence could not be validated.`;
  } else if (narrative.status === "missing" && options.missingScopeConcern) {
    narrative.status = "unverified";
    narrative.reason = `Unverified scope: ${options.missingScopeConcern} Original concern: ${narrative.reason}`;
  } else if (narrative.status === "missing" && !options.assessmentComplete) {
    narrative.status = "unverified";
    narrative.reason = `Unverified narrative concern: ${narrative.reason} The manuscript review was incomplete.`;
  }
  const mixedPromiseAssessment = { ...parsed.data, narrative: { ...narrative, evidence } };
  return { ...mixedPromiseVerdict({ ...options.requirement, mixedPromiseAssessment }, options.requirements, options.context)!,
    mixedPromiseAssessment, evidence };
}
