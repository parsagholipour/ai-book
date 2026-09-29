import type { TextModelAdapter } from "../adapters/types.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import { matchingRequirementInventory } from "../schemas/manuscriptRequirements.js";
import { inventoryManuscriptRequirements } from "./manuscriptCoverage.js";
import { REQUIREMENT_SCOPE_GUIDANCE } from "./manuscriptCoverageScope.js";
import { generationPageCountBounds, requestedGenerationPages } from "./pageCountAllowance.js";

/** One interpretation before writing; resume and final coverage reuse even a
 * partial/unavailable attempt instead of interpreting the brief around the draft. */
export async function preparePictureBookRequirementContract(options: {
  input: CreateProjectInput; plan: BookPlan; textModel: TextModelAdapter;
}): Promise<BookPlan> {
  if (matchingRequirementInventory(options.plan.requirementInventory, options.input.prompt)) return options.plan;
  const requirementInventory = await inventoryManuscriptRequirements({ brief: options.input.prompt, textModel: options.textModel, requireScope: true });
  return { ...options.plan, requirementInventory };
}

export const WRITER_REQUIREMENT_SCOPE_GUIDANCE = `requirementContract is the saved interpretation also used by final coverage. Honor its quoted constraints and scopes; labels add no obligations. For total story-page count, pageCountPolicy is authoritative over exact-count wording in the brief or generated promises: never below the requested minimum; optional extra pages only within the supplied bounds. Once a map fixes the count, preserve every selected page. Preserve the original brief when the inventory is partial or unavailable. ${REQUIREMENT_SCOPE_GUIDANCE}`;

/** Compact payload: no duplicate full brief, review bookkeeping or generated ids. */
export function pictureBookRequirementContract(input: CreateProjectInput, plan: BookPlan, pageCountBounds = generationPageCountBounds(input)) {
  const inventory = matchingRequirementInventory(plan.requirementInventory, input.prompt);
  return { pageCountPolicy: { requestedPages: requestedGenerationPages(input), ...pageCountBounds },
    ...(inventory ? { requirementContract: { complete: inventory.complete,
      requirements: inventory.requirements.map(({ quote, scope }) => ({ quote, scope })) } } : {}) };
}
