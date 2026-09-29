import type { ManuscriptRequirementInventory } from "../schemas/manuscriptRequirements.js";

type Requirement = ManuscriptRequirementInventory["requirements"][number] & { source?: string };
const policy = "Extra pages are optional and must add meaningful progression";
const unpunctuated = (text: string) => text.trim().replace(/\.$/u, "");

/** Rejoin the app's known policy only from its complete, authoritative clause.
 * Its fragments all belong to that one conditional duty. A fragment without the
 * full scope, a label or a wider compound cannot authorize normalization. */
export function normalizeExtraPageRequirement<T extends Requirement>(requirement: T, brief: string): T {
  if (requirement.kind !== "content" || requirement.sourceQuoteIssue ||
    (requirement.source !== undefined && requirement.source !== "brief")) return requirement;
  const scope = requirement.scope;
  const clause = scope?.quote ?? requirement.quote;
  if ((scope && !["whole_book", "specified"].includes(scope.extent)) ||
    unpunctuated(clause) !== policy || !brief.includes(clause) || !requirement.quote.trim() ||
    !clause.includes(requirement.quote)) return requirement;
  return { ...requirement, text: "Meaningful progression on optional extra pages", quote: clause,
    scope: { extent: "specified", quote: clause },
    ...(requirement.quote !== clause ? { originalQuote: requirement.originalQuote ?? requirement.quote } : {}) };
}

/** Before freezing a new inventory, keep one policy rather than independently
 * judging its permission and duty. Legacy inventories retain IDs during review. */
export function normalizeExtraPageInventory<T extends Requirement>(requirements: readonly T[], brief: string): T[] {
  const seen = new Set<string>();
  return requirements.flatMap(requirement => {
    const normalized = normalizeExtraPageRequirement(requirement, brief);
    if (normalized === requirement) return [requirement];
    if (seen.has(normalized.quote)) return [];
    seen.add(normalized.quote);
    return [normalized];
  });
}

export const EXTRA_PAGE_POLICY_GUIDANCE = "Keep optional permission and its attached duty in one conditional requirement with the complete source clause: 'Extra pages are optional and must add meaningful progression.' Permission is not a separate prose deliverable; progression applies when extra pages are used. Do not split this policy into an optionality item and a progression item.";
