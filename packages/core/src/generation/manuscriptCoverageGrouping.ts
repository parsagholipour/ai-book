import type { PageCountConstraint } from "../schemas/manuscriptRequirements.js";

/** Share an assessment only for identical obligations; never guess that paraphrases are equivalent. */
export function groupCoverageRequirements<T extends {
  id: string; text: string; quote?: string | undefined; kind: string; expectedTitle?: string | undefined; expectedCount?: number | undefined;
  illustrationScope?: string | undefined; mediaScope?: string | undefined; prohibitionScope?: string | undefined;
  scope?: { extent: string; quote: string } | undefined;
  pageCountConstraint?: PageCountConstraint | undefined;
}>(requirements: readonly T[]) {
  const representatives: T[] = [];
  const canonicalIds = new Map<string, string>();
  const seen = new Map<string, string>();
  for (const requirement of requirements) {
    const key = JSON.stringify([requirement.text.trim().replace(/\s+/gu, " "),
      (requirement.quote ?? requirement.text).trim().replace(/\s+/gu, " "), requirement.kind,
      requirement.expectedTitle, requirement.expectedCount, requirement.illustrationScope, requirement.mediaScope, requirement.prohibitionScope,
      requirement.scope?.extent, requirement.scope?.quote, requirement.pageCountConstraint]);
    const canonical = seen.get(key) ?? requirement.id;
    if (!seen.has(key)) { seen.set(key, canonical); representatives.push(requirement); }
    canonicalIds.set(requirement.id, canonical);
  }
  return { representatives, canonicalIds };
}
