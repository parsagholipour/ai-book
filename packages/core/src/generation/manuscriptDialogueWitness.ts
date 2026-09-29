import { dialogueCandidateSpans, dialogueWitnessConcern, requestsDialogue } from "./dialogueWitness.js";
import { hasGroundedScope } from "./manuscriptCoverageScope.js";
import type { ManuscriptRequirementInventory } from "../schemas/manuscriptRequirements.js";

type Requirement = ManuscriptRequirementInventory["requirements"][number];
type Page = { index: number; markdown: string };
type Evidence = { pageIndex: number; quote: string };

/** A detector cannot accuse the manuscript of missing dialogue. It can prevent
 * a clean pass until the reviewer accounts for suspicious pages and witnesses. */
export function manuscriptDialogueWitnessConcerns(requirement: Requirement, brief: string, pages: readonly Page[],
  status: string, evidence: readonly Evidence[]): string | undefined {
  if (requirement.kind !== "content" || !requestsDialogue(requirement.quote) || !hasGroundedScope(requirement, brief) ||
    !["fulfilled", "missing"].includes(status)) return undefined;
  const concerns: string[] = [];
  if (requirement.scope?.extent === "each_page") {
    const unchecked = pages.filter(page => !dialogueCandidateSpans(page.markdown).length &&
      (status === "fulfilled" || !evidence.some(item => item.pageIndex === page.index)));
    if (unchecked.length) concerns.push(`Dialogue needs contextual review on pages ${unchecked.map(page => page.index).join(", ")}; no plausible spoken-text witness was identified and the verdict did not establish an absence on these pages.`);
  }
  if (status === "fulfilled" && evidence.length && !evidence.some(item => {
    const page = pages.find(page => page.index === item.pageIndex);
    return page && !dialogueWitnessConcern(page.markdown, item.quote);
  })) concerns.push(`The fulfillment evidence on pages ${[...new Set(evidence.map(item => item.pageIndex))].join(", ")} does not include a plausible spoken utterance. Narration and non-spoken quotations cannot establish dialogue.`);
  return concerns.length ? concerns.join(" ") : undefined;
}

export function manuscriptDialogueReviewHints(requirements: readonly (Requirement & { id: string })[], pages: readonly Page[], brief: string) {
  const perPage = requirements.filter(requirement => requirement.kind === "content" && requirement.scope?.extent === "each_page" &&
    requestsDialogue(requirement.quote) && hasGroundedScope(requirement, brief));
  if (!perPage.length) return undefined;
  const pageIndexes = pages.filter(page => !dialogueCandidateSpans(page.markdown).length).map(page => page.index);
  return pageIndexes.length ? { requirementIds: perPage.map(requirement => requirement.id), pageIndexes,
    instruction: "These pages lack a recognizable spoken-text witness. Inspect each in the full manuscript, including the ending. This is a review prompt, not proof of absence. Cite actual utterances for fulfillment; for missing, cite each affected page with its grounded scope. Do not omit a page merely because other pages already fail." } : undefined;
}
