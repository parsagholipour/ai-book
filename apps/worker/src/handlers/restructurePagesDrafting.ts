import { styleExcerptsForPage, toPriorPageContext, type strategyForInput } from "../generation/bookHelpers.js";
import { loadContinuityNotes, loadResearchNotesForGeneration } from "../generation/generationContext.js";
import { reviewAndSaveGeneratedPage } from "../generation/pageReview.js";
import { isStructuralPageLeaseLostError } from "../generation/structuralPageLease.js";
import type { inputForPlanVersion } from "../generation/projectInput.js";
import { loadQualityContext } from "../generation/qualitySettings.js";
import type { createLoggedProviders } from "../providers/loggedAdapters.js";
import { advanceJobStep } from "../runtime/jobLifecycle.js";
import type { bookPlanSchema } from "@book-maker/core";
import { prisma } from "@book-maker/db";

/**
 * The drafting half of `restructurePages`: the model calls an insert owes,
 * split out of the handler so the file that decides a book's status stays one
 * screenful of decisions rather than a page loop wrapped around them.
 */

/**
 * Writes the inserted pages, giving each one the page that already follows it,
 * and answers with the ids it actually wrote.
 *
 * That forward context is the whole difference from appending: an inserted page
 * has to hand off to prose the reader already has, and a drafting call that
 * cannot see it either stops mid-thought or writes the next page's beat again.
 *
 * The return value is the other half. A resumed delivery drafts the ids the
 * stamp recorded, and an id the book no longer holds cannot be written — so the
 * loop skips it, and used to skip it in silence, which is how a five-page insert
 * settled APPLIED having written two and kept the charge for five. The skip is
 * now logged and counted, and the count is what drives both the operation's
 * `affectedPageIndexes` and the refund of the difference.
 *
 * Everything read inside the loop is read there because it moves with the page:
 * the two page-context queries follow `page.index` *and* have to see the page
 * the previous iteration just saved COMPLETED, and the continuity notes are
 * written by that same save. Only the research notes are per-chapter, and they
 * are memoized as such — see the comments at each site, and do not hoist the
 * rest to match.
 */
export async function draftInsertedPages(options: {
  projectId: string;
  planVersionId: string;
  input: ReturnType<typeof inputForPlanVersion>;
  plan: ReturnType<typeof bookPlanSchema.parse>;
  strategy: ReturnType<typeof strategyForInput>;
  providers: ReturnType<typeof createLoggedProviders>;
  insertedPageIds: string[];
  generationJobId?: string | undefined;
  assertLease: () => Promise<void>;
}): Promise<string[]> {
  const { projectId } = options;
  const total = options.insertedPageIds.length;
  const drafted: string[] = [];
  // One read per chapter rather than one per page. `ResearchSource` rows are
  // written by planning, `replanBook` and `generateBook` and by nothing this
  // loop reaches, and with no `semantic` argument
  // `loadResearchNotesForGeneration` is a project-wide `findMany` filtered by
  // the chapter's own terms — so its answer varies with the chapter plan and
  // with nothing else. `continueBook` reads it once per chapter for the same
  // reason. Keyed on the plan chapter's index, with `null` standing for "no
  // matching chapter": the loader returns the unfiltered notes for every such
  // page, so they all share one entry.
  const researchNotesByChapter = new Map<number | null, string[]>();
  const quality = await loadQualityContext(options.input);
  await advanceJobStep(options.generationJobId, "apply", 40, "Writing the new pages", { done: 0, total });

  for (const [offset, pageId] of options.insertedPageIds.entries()) {
    await options.assertLease();
    const page = await prisma.page.findUnique({ where: { id: pageId }, include: { chapter: true } });
    if (!page) {
      // Never silent: the run log is the only record of a paid page that was
      // never written, and the caller refunds against the count this loop
      // returns rather than against the stamp it was handed.
      console.warn("Structural insert skipped a recorded page the book no longer holds", {
        event: "generation.structural_insert_page_missing",
        projectId,
        pageId
      });
      continue;
    }
    await advanceJobStep(
      options.generationJobId,
      "apply",
      40 + Math.round((offset / Math.max(total, 1)) * 40),
      `Writing page ${page.index}`,
      { done: offset, total, pageIndex: page.index }
    );
    const [previous, following] = await Promise.all([
      prisma.page.findMany({
        where: { projectId, index: { lt: page.index }, status: "COMPLETED" },
        orderBy: { index: "desc" },
        take: 12
      }),
      prisma.page.findMany({
        where: { projectId, index: { gt: page.index }, status: "COMPLETED" },
        orderBy: { index: "asc" },
        take: 2
      })
    ]);
    const previousPages = [...previous].reverse().map(toPriorPageContext);
    const nextPages = following.map(toPriorPageContext);
    const chapterPlan = options.plan.chapters.find((chapter) => chapter.index === page.chapter?.index);
    // Read per page on purpose, and it is the one query in this loop that could
    // look hoistable and is not: `reviewAndSaveGeneratedPage` writes a
    // `ContinuityNote` row for every page it approves, so what this reads on
    // iteration N+1 includes what iteration N wrote — the established facts the
    // next inserted page must not contradict, at the *end* of a 28-note list
    // ordered by ascending priority, which is the end a prompt keeps when it
    // truncates. Hoisting it would hand every page of the insert the same
    // pre-insert snapshot to save a handful of cheap round trips, and it would
    // not even be a saving: the page reviewer reloads the notes itself
    // (`pageReview.ts`), so a contradiction the draft was no longer shown is
    // caught one step later by a QA rewrite, which is a whole model call.
    // Whole book: an inserted page lands into prose that already exists on both
    // sides of it, which is why `nextPages` is read above.
    const continuityNotes = await loadContinuityNotes(projectId, { beforePageIndex: null });
    const chapterKey = chapterPlan?.index ?? null;
    let researchNotes = researchNotesByChapter.get(chapterKey);
    if (!researchNotes) {
      researchNotes = await loadResearchNotesForGeneration(projectId, options.strategy, chapterPlan);
      researchNotesByChapter.set(chapterKey, researchNotes);
    }

    const priorPageContext = previousPages.slice(-6);
    const styleExcerpts = await styleExcerptsForPage({
      projectId,
      pageIndex: page.index,
      recencyPages: priorPageContext,
      input: options.input,
      quality
    });
    const draft = await options.strategy.generatePageDraft({
      input: options.input,
      plan: options.plan,
      ...(chapterPlan ? { chapter: chapterPlan } : {}),
      pageIndex: page.index,
      previousSummaries: previousPages.map((entry) => entry.summary).slice(-40),
      previousPages: priorPageContext,
      ...(nextPages.length > 0 ? { nextPages } : {}),
      continuityNotes,
      researchNotes,
      textModel: options.providers.text,
      ...(styleExcerpts.length > 0 ? { styleExcerpts } : {})
    });
    await options.assertLease();
    try {
      await reviewAndSaveGeneratedPage({
        projectId,
        planId: options.planVersionId,
        input: options.input,
        plan: options.plan,
        providers: options.providers,
        strategy: options.strategy,
        draft: { ...draft, index: page.index },
        chapterId: page.chapterId,
        ...(chapterPlan ? { chapter: chapterPlan } : {}),
        previousPages: previousPages.slice(-18),
        ...(nextPages.length > 0 ? { nextPages } : {}),
        ...(options.generationJobId ? { generationJobId: options.generationJobId } : {}),
        // The structural charge prices pages, never illustrations.
        illustrate: false,
        // Not just the page upsert: the same fence gates the story delta, the
        // continuity notes, the entity state and the embedding behind it, so a
        // delivery that lost the book here publishes none of the memory the
        // winner's later pages would read back. See `reviewAndSaveGeneratedPage`.
        assertOwnership: options.assertLease
      });
    } catch (error) {
      // Never silent, for the same reason the skipped page above is not: the
      // handler's lost-lease catch stands this delivery down without failing a
      // book somebody else now owns, and the run log is the only record that
      // this is what happened rather than a page quietly going missing.
      if (isStructuralPageLeaseLostError(error)) {
        console.warn("Structural insert stood down mid-page: another delivery owns this edit", {
          event: "generation.structural_insert_lost_lease",
          projectId,
          pageId,
          pageIndex: page.index
        });
      }
      throw error;
    }
    await options.assertLease();
    drafted.push(pageId);
  }
  return drafted;
}
