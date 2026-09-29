import { bindTextModelCall, MAX_TEXT_PROVIDER_ATTEMPTS, repairPictureBookManuscript,
  pictureBookRepairPageScopes, PictureBookRepairScopeError, unattemptedPictureBookLocalRequirements,
  type PictureBookRepairFeedback, type TextAttemptBudget } from "@book-maker/core";
import { RepairRejectedError } from "./compileRepairOutcome.js";

type Candidate = Awaited<ReturnType<typeof repairPictureBookManuscript>>;

/** One original candidate and at most one local OR semantic correction, within the same
 * physical allowance and pinned route. Always patch the frozen original. */
export async function checkedShortBookRepairCandidate(options: Parameters<typeof repairPictureBookManuscript>[0] & {
  assertActive: () => Promise<void>;
  /** Deterministic, model-free checks over pages, also used on the frozen baseline. */
  check: (candidate: Candidate) => Promise<PictureBookRepairFeedback["failures"]>;
  verify: (candidate: Candidate, budget: TextAttemptBudget) => Promise<{
    rejection: RepairRejectedError; failures: PictureBookRepairFeedback["failures"];
  } | undefined>;
  selectIndependent?: (candidate: Candidate) => Candidate | undefined;
}): Promise<Candidate> {
  const { assertActive, check, verify, selectIndependent, ...repair } = options;
  const textModel = (await bindTextModelCall(options.textModel, "revise-page")).adapter;
  const budget: TextAttemptBudget = { limit: MAX_TEXT_PROVIDER_ATTEMPTS, used: 0, outputWidened: false };
  const reviewBudget: TextAttemptBudget = { limit: MAX_TEXT_PROVIDER_ATTEMPTS, used: 0, outputWidened: false };
  const originalTargets = new Set(pictureBookRepairPageScopes(options).map(scope => scope.pageIndex));
  let feedback: PictureBookRepairFeedback | undefined;
  let previous: { candidate: Candidate; rejection: RepairRejectedError; semantic: boolean } | undefined;
  const finish = async (candidate: Candidate, rejection: RepairRejectedError, semantic: boolean): Promise<Candidate> => {
    // No new proposal or renewed allowance. Reserve room for editorial AND
    // independent continuity verification of the exact recombined manuscript.
    if (!semantic || reviewBudget.limit - reviewBudget.used < 2) throw rejection;
    const independent = selectIndependent?.(candidate);
    if (!independent) throw rejection;
    await assertActive();
    if ((await check(independent)).length) throw rejection;
    await assertActive();
    const result = await verify(independent, reviewBudget);
    if (result) throw result.rejection;
    return independent;
  };
  for (let round = 0; ; round += 1) {
    await assertActive();
    const before = budget.used;
    let candidate: Candidate;
    try {
      candidate = await repairPictureBookManuscript({ ...repair, textModel, textAttemptBudget: budget, ...(feedback ? { feedback } : {}) });
    } catch (error) {
      if (!(error instanceof PictureBookRepairScopeError)) throw error;
      if (round === 1 || Math.max(budget.used, before + 1) >= budget.limit || reviewBudget.used >= reviewBudget.limit)
        throw new RepairRejectedError("local_checks", error.feedback.failures.map(f => f.pageIndex), error.message);
      feedback = error.feedback;
      continue;
    } finally {
      // Custom/test adapters may not account at the wire. Never grant a free call.
      budget.used = Math.max(budget.used, before + 1);
    }
    const unattempted = unattemptedPictureBookLocalRequirements({ ...repair, candidatePages: candidate.pages });
    if (!candidate.context.changes.length && !unattempted.length) return candidate;
    // An identical rejected manuscript cannot benefit from another paid review.
    if (previous && candidate.pages.every((page, i) => page.markdown === previous?.candidate.pages[i]?.markdown && page.title === previous?.candidate.pages[i]?.title))
      return finish(previous.candidate, previous.rejection, previous.semantic);
    await assertActive();
    let failures = [...unattempted, ...await check(candidate)];
    const changed = new Set(candidate.context.changes.map(change => change.pageIndex));
    let semantic = false;
    let rejection: RepairRejectedError;
    if (failures.length) {
      rejection = new RepairRejectedError("local_checks", failures.map(failure => failure.pageIndex),
        `Coordinated repair failed local checks: ${failures.map(failure => `Page ${failure.pageIndex}: ${failure.issues.join(" ")}`).join(" ")}`);
      const outside = failures.filter(failure => !changed.has(failure.pageIndex) && !originalTargets.has(failure.pageIndex));
      if (outside.length) {
        if (round === 1 || budget.used >= budget.limit || reviewBudget.used >= reviewBudget.limit) throw rejection;
        await assertActive();
        const baseline = await check({ pages: [...options.pages], context: { issues: options.issues, changes: [] } });
        // A changed page can create a collision reported on an untouched neighbor.
        // Only newly introduced findings may use the existing correction; an
        // inherited defect still cannot expand scope. Keep the original targets
        // frozen and forward the dependency evidence (e.g. "from page 9").
        if (outside.some(failure => !options.pages.some(page => page.index === failure.pageIndex) ||
          !failure.issues.length || failure.issues.some(issue => baseline.some(original =>
            original.pageIndex === failure.pageIndex && original.issues.includes(issue))))) throw rejection;
      }
    } else {
      await assertActive();
      const result = await verify(candidate, reviewBudget);
      if (!result) return candidate;
      ({ rejection, failures } = result);
      semantic = true;
    }
    // A correction must leave room to verify it. Neither allowance is reset.
    if (round === 1 || budget.used >= budget.limit || reviewBudget.used >= reviewBudget.limit) return finish(candidate, rejection, semantic);
    previous = { candidate, rejection, semantic };
    feedback = { ...(semantic ? { phase: "semantic" as const } : {}),
      candidatePages: candidate.pages.filter(page => changed.has(page.index)).map(({ index, markdown, title }) => ({ index, markdown, title })), failures };
  }
}
