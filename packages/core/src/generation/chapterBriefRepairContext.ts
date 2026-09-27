import type { BookPlan, ChapterBrief, CreateProjectInput, PageProductionBeat } from "../schemas/book.js";
import type { ProductionMapFinding } from "./productionMapAudit.js";

/** Latest accepted assignments and bounded context for an integrity rebuild. */
export type ChapterBriefRepairContext = {
  currentBrief: ChapterBrief | null;
  adjacentPages: PageProductionBeat[];
  collisionPages: PageProductionBeat[];
  findings: Array<Pick<ProductionMapFinding, "code" | "pageIndexes" | "evidence">>;
};

export function chapterBriefRepairFields(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  repairContext?: ChapterBriefRepairContext;
}) {
  if (!options.repairContext) return { rules: [], payload: {} };
  return {
    rules: [
      "This is an integrity repair of an existing map: repairContext.currentBrief is the latest accepted chapter, including prior corrections. The chapter summary and keyBeats outside repairContext are the older outline, not permission to reset those corrections.",
      "Address repairContext.findings while preserving unaffected assignments and the current chapter's entry and exit states. adjacentPages and collisionPages are read-only context; return only the requested page range. If currentBrief is null, reconstruct the missing chapter using the outline and these boundaries.",
      "Preserve required crossings, character movements, object ownership and transfers, discoveries, evidence, and causal handoffs. Shared wording does not prove the same completed action repeats: two different objects may each need to be retrieved or returned. Differentiate the flagged assignment's specific purpose and consequence without deleting a necessary action.",
      "Keep the user's request, global continuity rules, and promises true. Return all requested pages, changing only assignments that need repair."
    ],
    payload: {
      userRequest: options.input.prompt,
      promises: options.plan.promises,
      repairContext: options.repairContext
    }
  };
}
