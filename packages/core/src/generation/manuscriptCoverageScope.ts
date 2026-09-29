import { z } from "zod";
import { FINAL_PAGE_OBLIGATION_GUIDANCE } from "./finalPageObligations.js";
import { requirementScopeSchema, type ManuscriptRequirementInventory } from "../schemas/manuscriptRequirements.js";

export const REQUIREMENT_SCOPE_GUIDANCE = "Requirement text is a display label, never authority for an added quantifier or restriction. Interpret the exact source in the full brief. An explicit each/every quantifier governs the coordinated qualities attached to that unit unless the brief gives an exception: 'Make each page a scene with concise prose, natural dialogue and sensory details' applies all listed qualities to each page. Assess each item's own quoted obligation separately; the longer scope quote establishes its extent, not a merger with neighboring requirements. Missing dialogue belongs to the dialogue item, not a separate page-turn item sharing that scope quote. A standalone request for natural dialogue has whole-book scope. Do not infer a per-page quota merely from a label. Preserve explicit counts, exceptions, negation and deadlines; use unresolved if scope cannot be established. A before-moonrise arrival deadline does not require the story itself to end before moonrise. " + FINAL_PAGE_OBLIGATION_GUIDANCE;
export const COVERAGE_SCOPE_GUIDANCE = `${REQUIREMENT_SCOPE_GUIDANCE} Use the saved scope and its source quote; never silently strengthen or relax it. For any missing content requirement, promise or requirement with scope, include scopeAssessment:{supported,authority:brief|promise,quote,explanation,extent?}. For a saved scope, copy its extent and quote the complete scope passage in scopeAssessment; do not choose another extent based on the label. Quote the exact source that authorizes the specific condition allegedly violated and explain its scope. A planner promise may add a substantive payoff, but cannot override the brief or turn ambiguous wording into a stricter delivery rule. 'Reach the picnic before moonrise and end there' specifies a location, not ending immediately upon arrival; later picnic scenes are allowed. An explicit 'end immediately upon arrival' must still be enforced. If the alleged constraint is unsupported, reassess the actual obligation against all pages: fulfilled still needs exact evidence. If uncertainty remains, return unverified; do not silently clear the obligation.`;
export const scopeAssessmentSchema = z.object({
  extent: requirementScopeSchema.shape.extent.optional(),
  supported: z.boolean(), authority: z.enum(["brief", "promise"]), quote: z.string().min(1), explanation: z.string().min(1)
});

export function hasGroundedScope(requirement: ManuscriptRequirementInventory["requirements"][number], brief: string) {
  return !requirement.scope || (requirement.scope.extent !== "unresolved" &&
    brief.includes(requirement.scope.quote) && requirement.scope.quote.includes(requirement.quote));
}

/** Semantic interpretation belongs to the reviewer; code checks provenance and
 * requires an explicit scope decision before an accusation can drive repair. */
export function missingScopeConcern(requirement: ManuscriptRequirementInventory["requirements"][number] & {
  source: "brief" | "promise";
}, assessment: unknown, brief: string): string | undefined {
  if (requirement.source !== "promise" && !requirement.scope && requirement.kind !== "content") return undefined;
  if (!hasGroundedScope(requirement, brief)) return "The requirement scope is unresolved or its source quote is not grounded.";
  const parsed = scopeAssessmentSchema.safeParse(assessment);
  if (!parsed.success) return "The reviewer did not establish the source and scope of the alleged missing condition.";
  const source = parsed.data.authority === "brief" ? brief : requirement.source === "promise" ? requirement.quote : "";
  if (!parsed.data.supported || !source.includes(parsed.data.quote)) return "The alleged missing condition has no supported scope in its cited source.";
  if (requirement.scope && (parsed.data.extent !== requirement.scope.extent ||
    !parsed.data.quote.includes(requirement.scope.quote))) return "The alleged missing condition changes or omits the saved requirement scope.";
  return undefined;
}
