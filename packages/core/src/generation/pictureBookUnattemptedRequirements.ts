import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import { matchingRequirementInventory } from "../schemas/manuscriptRequirements.js";
import { dialogueCandidateSpans } from "./dialogueWitness.js";
import { pictureBookPageRequirements } from "./pictureBookPreRepairChecklist.js";
import { validRequirementTargets, type PictureBookRequirementTarget } from "./pictureBookRequirementTargets.js";

type Page = { index: number; markdown: string };

/** An unchanged page cannot gain its own missing speech through a neighboring
 * edit. Limit this admission check to grounded, explicitly each-page speech
 * requirements with only local evidence and no speech candidates in the original.
 * Arcs, comparisons, naturalness and other relational judgments still need review.
 * A changed page is never approved here: it must pass the ordinary full review. */
export function unattemptedPictureBookLocalRequirements(options: {
  input: CreateProjectInput; plan: BookPlan; pages: readonly Page[]; candidatePages: readonly Page[];
  requirementTargets?: readonly PictureBookRequirementTarget[];
}) {
  const localSpeech = /^(?:(?:natural|spoken|direct|brief|short)\s+)*(?:dialogue|speech|spoken (?:words|lines))[.!]?$/iu;
  const inventory = matchingRequirementInventory(options.plan.requirementInventory, options.input.prompt);
  const requirements = pictureBookPageRequirements(options.input, options.plan).filter(r => localSpeech.test(r.quote.trim()) &&
    !inventory?.requirements.some(item => item.kind === "prohibition" && item.quote === r.quote));
  const failures = new Map<number, string[]>();
  for (const target of validRequirementTargets(options.input.prompt, options.pages, options.requirementTargets ?? [])) {
    if (!requirements.some(r => r.quote === target.requirementQuote) || target.evidence.some(e => e.pageIndex !== target.pageIndex)) continue;
    const original = options.pages.find(p => p.index === target.pageIndex);
    const candidate = options.candidatePages.find(p => p.index === target.pageIndex);
    if (!original || !candidate || original.markdown !== candidate.markdown || dialogueCandidateSpans(original.markdown).length) continue;
    const message = `Unattempted local requirement ${target.id} (“${target.requirementQuote}”): page ${target.pageIndex} retains the exact original prose with no spoken-text candidate. ${target.problem} ${target.acceptanceCriteria}`;
    failures.set(target.pageIndex, [...(failures.get(target.pageIndex) ?? []), message]);
  }
  return [...failures].sort(([a], [b]) => a - b).map(([pageIndex, issues]) => ({ pageIndex, issues }));
}
