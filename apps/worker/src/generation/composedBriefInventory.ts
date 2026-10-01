import {
  inventoryManuscriptRequirements, matchingRequirementInventory,
  type BookPlan, type CreateProjectInput, type ManuscriptRequirementInventory, type TextModelAdapter
} from "@book-maker/core";
import { isStopRequestedError } from "../runtime/jobTypes.js";
import { persistPlanField } from "./composedChaptersMaterial.js";

/**
 * The brief's requirement inventory, taken at the start of the composed pass.
 *
 * Two readers want it. The compile checks the finished book against the
 * request in two calls, one after the other: the inventory, which reads only
 * the brief, and the coverage read, which needs the manuscript — 28 s and
 * 40 s of a 55–90 s compile on the 2026-09-30 Quick Draft books.
 * `manuscriptCoverageForCompile` already reuses an inventory the plan carries
 * (`matchingRequirementInventory`: version 1, the same brief), which is how
 * the picture-book path has always worked. And the chapter form plan gives
 * each explicit ask a section (`briefRequirementsForForms`), because readers
 * kept finding one missing that nothing had assigned to a chapter.
 *
 * So the call starts beside the stance, and the store waits for the stance and
 * the development step, since `persistPreparedComposedPlan` refuses a plan row
 * that changed under it and `persistGeneratedAuthorStance` is a
 * read-modify-write that would lose the field. Neither half rejects: an
 * inventory that could not be taken or stored is one the compile takes itself,
 * as before. Only an available one is kept, because the compile reuses even a
 * failed inventory it finds.
 */
export async function takeBriefInventory(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  textModel: TextModelAdapter;
}): Promise<ManuscriptRequirementInventory | undefined> {
  const { input, plan, textModel } = options;
  if (!input.prompt.trim()) return undefined;
  const stored = matchingRequirementInventory(plan.requirementInventory, input.prompt);
  if (stored) return stored.status === "available" ? stored : undefined;
  try {
    const inventory = await inventoryManuscriptRequirements({ brief: input.prompt, textModel, requireScope: true });
    return inventory.status === "available" ? inventory : undefined;
  } catch (error) {
    // A stop reaches the pass through its own steps; nothing here may fail the book.
    if (!isStopRequestedError(error)) {
      console.warn("Brief inventory was not taken ahead of the compile", { event: "generation.composed_chapters.brief_inventory_not_taken", error });
    }
    return undefined;
  }
}

export async function storeBriefInventory(options: {
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  inventory: ManuscriptRequirementInventory | undefined;
}): Promise<void> {
  const { planId, input, plan, inventory } = options;
  if (!inventory || matchingRequirementInventory(plan.requirementInventory, input.prompt)) return;
  try {
    await persistPlanField(planId, "requirementInventory", inventory, (stored) =>
      Boolean(stored && typeof stored === "object" && (stored as { version?: unknown }).version === 1 && (stored as { brief?: unknown }).brief === input.prompt));
  } catch (error) {
    if (!isStopRequestedError(error)) {
      console.warn("Brief inventory was not stored ahead of the compile", { event: "generation.composed_chapters.brief_inventory_not_stored", planId, error });
    }
  }
}

/** What a section can deliver: content, a table, a structure — never a title, a page count or an illustration rule. */
const PLANNABLE_KINDS = new Set(["content", "table", "structure"]);
const MAX_PLANNED_REQUIREMENTS = 24;

/** The inventory's explicit asks as the form planner's `briefRequirements`: the label and the brief's own words. */
export function briefRequirementsForForms(inventory: ManuscriptRequirementInventory | undefined): string[] {
  if (!inventory) return [];
  return inventory.requirements
    .filter((requirement) => PLANNABLE_KINDS.has(requirement.kind))
    .map((requirement) => requirement.quote && requirement.quote !== requirement.text ? `${requirement.text}: "${requirement.quote}"` : requirement.text)
    .slice(0, MAX_PLANNED_REQUIREMENTS);
}
