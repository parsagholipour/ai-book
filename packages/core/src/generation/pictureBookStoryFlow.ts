import { MAX_PICTURE_BOOK_PAGES } from "./pageCountAllowance.js";
import { z } from "zod";

const checkSchema = z.strictObject({
  pageIndexes: z.array(z.number().int().positive()).min(1).max(MAX_PICTURE_BOOK_PAGES),
  assessment: z.string().trim().min(12).max(600),
  repairPageIndexes: z.array(z.number().int().positive()).max(MAX_PICTURE_BOOK_PAGES)
});

/** Editorial checks stay in this call. Only the corrected assignments reach the writer. */
export const pictureBookFlowAuditSchema = z.strictObject({
  stateDependencies: z.array(checkSchema).max(20),
  setupPayoffs: z.array(checkSchema).max(20),
  sceneProgression: z.array(checkSchema.extend({
    changes: z.array(z.strictObject({
      pageIndex: z.number().int().positive(),
      actionQuote: z.string().min(8).max(400),
      change: z.string().trim().min(8).max(200)
    })).min(1).max(MAX_PICTURE_BOOK_PAGES)
  })).max(20)
});
export type PictureBookFlowAudit = z.infer<typeof pictureBookFlowAuditSchema>;

/** Validate execution of declared repairs, not the model's semantic judgments. */
export function pictureBookFlowAuditErrors(
  audit: PictureBookFlowAudit,
  pages: readonly { pageIndex: number; beat: string }[],
  revisions: readonly { pageIndex: number }[]
): string[] {
  const existing = new Set(pages.map(p => p.pageIndex));
  const revised = new Set(revisions.map(p => p.pageIndex));
  const covered = new Set<number>();
  const errors: string[] = [];
  for (const [category, checks] of Object.entries(audit)) for (const check of checks) {
    if (check.pageIndexes.some(index => !existing.has(index)) ||
      new Set(check.pageIndexes).size !== check.pageIndexes.length)
      errors.push(`${category}: pageIndexes must identify distinct existing pages.`);
    if (new Set(check.repairPageIndexes).size !== check.repairPageIndexes.length)
      errors.push(`${category}: repairPageIndexes must be distinct.`);
    for (const index of check.repairPageIndexes) {
      if (!revised.has(index)) errors.push(`${category}: page ${index} needs a complete sceneRevision; an assessment alone does not repair the map.`);
      covered.add(index);
    }
  }
  for (const index of revised) if (!covered.has(index))
    errors.push(`Page ${index}: each sceneRevision must belong to a flowAudit check that assesses its linked scenes, including downstream effects of new complications.`);
  for (const check of audit.sceneProgression) {
    const changes = check.changes.map(c => c.pageIndex);
    if (new Set(changes).size !== changes.length || changes.length !== check.pageIndexes.length ||
      check.pageIndexes.some(index => !changes.includes(index)))
      errors.push("sceneProgression: changes must cover each checked page exactly once.");
    for (const change of check.changes) if (!pages.find(p => p.pageIndex === change.pageIndex)?.beat.includes(change.actionQuote))
      errors.push(`Page ${change.pageIndex}: actionQuote must be an exact span from the INPUT beat, not a proposed revision or a paraphrase.`);
  }
  return errors;
}

export const PICTURE_BOOK_FLOW_INSTRUCTIONS = [
  "First return a compact flowAudit with three arrays: stateDependencies, setupPayoffs, sceneProgression. Audit the complete map, including changes you introduce, before finalizing sceneRevisions. Each check has pageIndexes (the linked existing scenes), assessment (one concise concrete entry-state -> action -> exit-state or setup -> payoff account), and repairPageIndexes (all scenes you actually replace for this check, [] only when sound). Include both sound critical dependencies and defects. Empty categories are allowed only when there is nothing relevant to check. Do not produce a summary for every page or repeat canon. Each sceneRevision must be covered by a check, and every repairPageIndexes entry must have a full sceneRevision.",
  "stateDependencies: make ONE focused check per important object/aspect or agreement, never one blanket account for the whole inventory. In assessment name its chronological states and page numbers, including each move and dependent use. Follow location, holder AND condition. The beat's enacted action takes precedence over requiredContinuity: if notes still leave an object at its old location after a beat moved it, repair those notes in the affected sceneRevision. Do not undo the move in your assessment. Distinguish remembered origin from current location. Check character knowledge and prior agreements separately: a later reference to an agreed signal cannot establish a missing earlier agreement. Repair unsupported uses by adding the missing action or removing the false assumption. An object cannot remain visible where it used to be after it has moved.",
  "setupPayoffs: explicitly pair every introduced complication or promised method with the action resolving it, including complications introduced by your own revisions. Damage remains until repair, replacement or a usable alternative support; inspecting, intending or returning an object is not repair. Do not hang an object on the same damaged support without a concrete resolving action. Include the setup and actual payoff pages. If absent, assign and revise the payoff scene now. A known mistake deliberately left in place needs a practical constraint or meaningful consequence; otherwise correct it promptly and revise later dependent scenes.",
  "sceneProgression: examine neighboring pairs and short runs of 2–4 scenes, AND returns over an already completed route. Each check also returns changes:[{pageIndex,actionQuote,change}] for every checked page: copy a short EXACT action span from its INPUT beat, then name its actual change. Proposing a signal is not sending it; accepting a plan is not performing it. Audit the original actions, not an imagined improved version. In assessment justify separate scenes or combine their work. Do not approve a long section by summarizing its overall success: a section can advance while containing redundant pages. Do not approve preparatory micro-actions merely because they have different verbs or labels (trust, knowledge, choice, response). A page that only invites a judgment, grants permission, proposes a method or agrees to it must share its slot with meaningful execution, unless delaying that action causes a concrete consequence or changes a relationship beyond the stated intention. Show trust through doing the shared work. Combine redundant preparation and enactment; preserve the necessary order within the scene. Allocate freed slots to meaningful action or changed relationships from this story. Preserve necessary transfers, difficult retrieval stages, purposeful refrains, requested escort and quiet closure. Do not manufacture danger, a fixed act ratio or a cliffhanger on every page. A new label or scenery alone is not progression.",
  "After composing replacements, reread the FINAL chronology across ALL pages. The audit is not a second hidden story: every newly required action belongs in the revised beat, and any obsolete downstream assumption must be replaced in its own sceneRevision. Do not leave a detected defect as advice for the writer. Keep each assessment concise; no full-map state ledger is needed."
];
