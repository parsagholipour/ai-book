import { z } from "zod";
import type { CoverageEvidenceContext } from "./manuscriptCoverage.js";
import { deliveryCoverageVerdict } from "./manuscriptCoverageDelivery.js";
import { mediaAbsenceVerdict } from "./manuscriptCoverageMedia.js";

const mediaScopeSchema = z.enum(["story_pages", "cover", "all", "character_references"]);

/** The reviewer maps the ENTIRE promise to existing typed brief obligations.
 * This records semantic equivalence, not a model verdict about absent assets. */
export const deliveryBindingSchema = z.object({
  promiseQuote: z.string().min(1), fullyRepresented: z.literal(true),
  requirements: z.array(z.object({ id: z.string(), quote: z.string().min(1) })).min(1).max(64)
});
type Requirement = {
  id: string; source: string; kind: string; quote: string;
  mediaScope?: string | undefined; sourceQuoteIssue?: string | undefined;
  deliveryBinding?: z.infer<typeof deliveryBindingSchema> | undefined;
};

export const DELIVERY_BINDING_GUIDANCE =
  "For a promise that restates the brief's ENTIRE set of media prohibitions with no extra obligation, include deliveryBinding:{promiseQuote,fullyRepresented:true,requirements:[{id,quote}]}. Copy the whole promiseQuote and each referenced brief quote exactly. Include EVERY brief media_absence item from factRequirements; story pages, cover and character references are separate. Link only grounded brief requirements, never other promises. Do not use a binding for a partial match, conditional prohibition, image appearance, prose independence, narrative payoff or any extra substantive condition. Omit the binding for mixed promises and assess the full promise as content. A binding only classifies the promise: use unverified with empty evidence when assets are unknown; code will assess it from fresh asset facts.";

function linkedRequirements(requirement: Requirement, requirements: readonly Requirement[]) {
  const binding = requirement.deliveryBinding;
  if (!binding || requirement.source !== "promise" || requirement.kind !== "content" || requirement.sourceQuoteIssue ||
    binding.promiseQuote !== requirement.quote || new Set(binding.requirements.map(r => r.id)).size !== binding.requirements.length) return undefined;
  // Conservative all-media binding: a model cannot accidentally drop the reference
  // scope and clear a blanket no-images promise with only story/cover checks.
  if (requirements.some(r => r.source === "brief" && r.kind === "media_absence" && !binding.requirements.some(link => link.id === r.id))) return undefined;
  const linked = binding.requirements.map(link => {
    const matches = requirements.filter(r => r.id === link.id);
    const target = matches.length === 1 ? matches[0] : undefined;
    return target?.source === "brief" && target.kind === "media_absence" && !target.sourceQuoteIssue &&
      target.quote === link.quote && ["story_pages", "cover", "all", "character_references"].includes(target.mediaScope ?? "") ? target : undefined;
  });
  return linked.every(r => r !== undefined) ? linked : undefined;
}

/** Independent parsing keeps one malformed binding from discarding the review. */
export function bindDeliveryPromise<T extends Requirement>(requirement: T, value: unknown, requirements: readonly Requirement[]): T {
  const parsed = deliveryBindingSchema.safeParse(value);
  if (!parsed.success) return requirement;
  const bound = { ...requirement, deliveryBinding: parsed.data };
  return linkedRequirements(bound, requirements) ? bound : requirement;
}

/** Re-evaluate every linked obligation, never cached verdicts or a passing subset. */
export function boundDeliveryVerdict(requirement: Requirement, requirements: readonly Requirement[], context?: CoverageEvidenceContext) {
  if (!requirement.deliveryBinding) return undefined;
  const linked = linkedRequirements(requirement, requirements);
  if (!linked) return { status: "unverified" as const, reason: "The promise's linked delivery obligations could not be validated.", deliveryChecks: [] };
  const deliveryChecks = linked.flatMap(target => {
    const delivery = deliveryCoverageVerdict(target, context);
    if (delivery) return delivery.deliveryChecks;
    const mediaScope = mediaScopeSchema.parse(target.mediaScope);
    return [{ kind: "media_absence" as const, quote: target.quote, mediaScope, ...mediaAbsenceVerdict(mediaScope, context?.mediaInventory) }];
  });
  return { status: deliveryChecks.some(c => c.status === "missing") ? "missing" as const
    : deliveryChecks.some(c => c.status === "unverified") ? "unverified" as const : "fulfilled" as const,
    reason: deliveryChecks.map(c => c.reason).join(" "), deliveryChecks };
}
