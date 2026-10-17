import {
  checkpointWholeBookDraftPages,
  directResumeStateForContext,
  effectiveWholeBookDraftContext,
  loadDirectResumeContext,
  persistAcceptedWholeBookTarget,
  prepareChapterSetups,
  priorPageContextsFromStored,
  rebuildChapterSetupsFromStored,
  reportAcceptedWholeBookDraft,
  resetBookForDirectGeneration
} from "./bookState.js";
import { usesShortBookPath } from "./shortPictureBook.js";
import { ensureCharacterReferenceAssets } from "./characterReferences.js";
import { enqueueDraftPageIllustrations } from "./draftIllustrations.js";
import { maybeEnqueueCompile, maybeEnqueueCover } from "../runtime/dispatch.js";
import { advanceJobStep, assertJobNotStopped, updateJobProgress } from "../runtime/jobLifecycle.js";
import { type ChapterSetup } from "../runtime/jobTypes.js";
import { chapterSetupsForPlan } from "./bookHelpers.js";
import { chapterSetupForPage, loadResearchNotesForGeneration } from "./generationContext.js";
import { reviewAndSaveGeneratedPage } from "./pageReview.js";
import {
  type BookGenerationStrategy,
  compactPictureBookPlanForBriefs,
  inputWithSelectedPageCount,
  type BookPlan,
  type CreateProjectInput,
  type PriorPageContext,
  type ProviderSet,
  type WholeBookPageDraft
} from "@book-maker/core";
import { prisma } from "@book-maker/db";

/**
 * The draft-then-polish pass: one whole-book draft call, then each page checked and saved as drafted.
 * The name is historical: since 2026-10-16 (E4) no page is polished and no model reads a page here, on
 * every tier. Blind readers preferred the whole-book draft to its per-page polish (Quick Draft 1 win /
 * 1 tie / 6 losses for the polish, stopped once it could not pass), to the polish with every review after
 * it (3 / 7 / 7), and did not clearly prefer the grouped picture-book review with its repairs and the
 * compile's final review over the draft (7 / 19 / 2 with three readers per order, lower bound 45%). The
 * deterministic local checks still run on every page (`localChecksOnly`).
 */
export async function generateBookDraftThenPolish(options: {
  projectId: string;
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  generationJobId?: string | undefined;
}) {
  const generateWholeBookDraft = options.strategy.generateWholeBookDraft;
  if (!generateWholeBookDraft) {
    throw new Error(`Strategy ${options.strategy.id} does not support draft-then-polish generation.`);
  }

  // The accepted whole-book draft is checkpointed as PENDING rows before the
  // page loop, so a re-run resumes saving instead of repeating the draft
  // call. requiresBriefs is false because effectiveWholeBookDraftContext drops
  // briefs when the accepted draft was renumbered — the page loop tolerates both.
  const resumeContext = await loadDirectResumeContext(options.projectId);
  const resumeState = directResumeStateForContext({
    targetPages: options.input.targetPages,
    plan: options.plan,
    context: resumeContext,
    requiresBriefs: false,
    requireAllPagesPresent: true
  });
  if (resumeState.kind === "already-complete") {
    await advanceJobStep(options.generationJobId, "enqueue", 90, "All pages already saved; queueing export");
    await maybeEnqueueCompile(options.projectId, options.planId);
    return;
  }

  let effectiveInput: CreateProjectInput;
  let effectivePlan: BookPlan;
  let chapterSetups: ChapterSetup[];
  let chapterIds: Map<number, string>;
  let rawPages: PriorPageContext[];
  let pagesToSave: WholeBookPageDraft[];
  // Every page of the draft with what its picture shows, saved or not: the
  // sheet cast is decided from the whole book's pictures (`draftCast` below).
  let draftPictures: ReadonlyArray<{ index: number; imagePrompt?: string | null | undefined }>;
  const previousPages: PriorPageContext[] = [];

  if (resumeState.kind === "resume") {
    // persistAcceptedWholeBookTarget already ran before the first page save, so
    // options.input/options.plan reflect the accepted draft on this re-run.
    effectiveInput = options.input;
    effectivePlan = options.plan;
    ({ chapterSetups, chapterIds } = rebuildChapterSetupsFromStored(
      options.plan,
      options.input.targetPages,
      resumeContext.chapters
    ));
    rawPages = resumeContext.pages.map((page) => ({
      index: page.index,
      title: page.title,
      markdown: page.markdown,
      summary: page.summary
    }));
    pagesToSave = resumeContext.pages
      .filter((page) => page.status === "PENDING")
      .map((page) => ({
        index: page.index,
        title: page.title,
        markdown: page.markdown,
        summary: page.summary,
        continuityNotes: [],
        ...(page.imagePrompt ? { imagePrompt: page.imagePrompt } : {})
      }));
    // The checkpointed rows, COMPLETED ones included: their pictures are the
    // book's as much as the PENDING rows' are.
    draftPictures = resumeContext.pages;
    previousPages.push(...priorPageContextsFromStored(resumeContext.pages, resumeState.firstMissingPageIndex));
    await advanceJobStep(
      options.generationJobId,
      "setup",
      35,
      `Resuming with ${previousPages.length} finished pages; the saved draft is reused`
    );
    await prisma.project.update({ where: { id: options.projectId }, data: { status: "GENERATING" } });
  } else {
    const draftChapterSetups: ChapterSetup[] = options.strategy.createChapterBriefs
      ? await prepareChapterSetups(options)
      : chapterSetupsForPlan(options.plan, options.input.targetPages);
    const chapterBriefs = draftChapterSetups.flatMap((setup) => (setup.brief ? [setup.brief] : []));
    const draftPlan = compactPictureBookPlanForBriefs(options.input, options.plan, chapterBriefs);
    const draftInput = draftPlan === options.plan ? options.input : inputWithSelectedPageCount(options.input,
      draftPlan.chapters.reduce((sum, chapter) => sum + chapter.targetPages, 0));
    const researchNotes = await loadResearchNotesForGeneration(options.projectId, options.strategy);
    await advanceJobStep(options.generationJobId, "briefs", chapterBriefs.length > 0 ? 30 : 20, "Drafting whole book");
    const draft = await generateWholeBookDraft({
      input: draftInput,
      plan: draftPlan,
      chapterBriefs: chapterBriefs.length > 0 ? chapterBriefs : undefined,
      researchNotes,
      textModel: options.providers.text
    });
    const acceptanceMessage = await reportAcceptedWholeBookDraft(options.generationJobId, draft);
    const effective = effectiveWholeBookDraftContext(options.input, draftPlan, draft, draftChapterSetups);

    await advanceJobStep(
      options.generationJobId,
      "setup",
      35,
      acceptanceMessage ? `${acceptanceMessage} Preparing page records.` : "Preparing page records"
    );
    effectiveInput = effective.input;
    effectivePlan = effective.plan;
    chapterSetups = effective.chapterSetups;
    chapterIds = await resetBookForDirectGeneration(options.projectId, effective.chapterSetups, effective.plan.promises ?? []);
    await checkpointWholeBookDraftPages({
      projectId: options.projectId,
      chapterSetups: effective.chapterSetups,
      chapterIds,
      pages: draft.pages
    });
    // Persisted before the page loop (not after) so a resumed run loads the
    // accepted page target and matches the checkpointed structure.
    await persistAcceptedWholeBookTarget({
      projectId: options.projectId,
      planId: options.planId,
      input: effective.input,
      plan: effective.plan,
      ...(draftPlan !== options.plan ? { chapterAllocationChanged: true } : {}),
      originalTargetPages: options.input.targetPages,
      draft
    });
    rawPages = draft.pages.map((page) => ({
      index: page.index,
      title: page.title,
      markdown: page.markdown,
      summary: page.summary
    }));
    pagesToSave = draft.pages;
    draftPictures = draft.pages;
  }
  const pictureBook = usesShortBookPath({ input: effectiveInput, plan: effectivePlan, strategy: options.strategy, pages: rawPages });
  // On the picture-book path every picture is queued from this draft below, so
  // the draft already says who each one shows: the sheet pass decides its cast
  // from it, once for the plan version, and draws a sheet only for a character
  // two pictures share (`characterReferenceCastDecision.ts`). Off the path the
  // whole cast is drawn, as before.
  const draftCast = pictureBook ? { decideCastFromDraft: draftPictures } : {};
  await ensureCharacterReferenceAssets({ projectId: options.projectId, planId: options.planId, input: effectiveInput,
    plan: effectivePlan, providers: options.providers, strategy: options.strategy, generationJobId: options.generationJobId,
    ...draftCast });
  await assertJobNotStopped(options.generationJobId);
  await maybeEnqueueCover(options.projectId, options.planId, effectiveInput);
  // The sheets are committed and this pass publishes the draft as written, so
  // every picture starts now, beside the page loop; see draftIllustrations.ts.
  if (pictureBook) await enqueueDraftPageIllustrations({ projectId: options.projectId, planId: options.planId,
    input: effectiveInput, plan: effectivePlan, strategy: options.strategy, pages: pagesToSave });

  for (const [pageOffset, pageDraft] of pagesToSave.entries()) {
    await updateJobProgress(options.generationJobId, {
      progress: 35 + Math.round((pageOffset / Math.max(pagesToSave.length, 1)) * 45),
      message: `Checking and saving page ${pageDraft.index}`
    });
    const setup = chapterSetupForPage(chapterSetups, pageDraft.index);
    const chapterBrief = setup?.brief;
    const nextPages = rawPages.filter((page) => page.index > pageDraft.index);
    const saved = await reviewAndSaveGeneratedPage({
      projectId: options.projectId,
      planId: options.planId,
      input: effectiveInput,
      plan: effectivePlan,
      providers: options.providers,
      strategy: options.strategy,
      draft: { ...pageDraft, index: pageDraft.index },
      chapterId: setup ? chapterIds.get(setup.chapter.index) ?? null : null,
      chapter: setup?.chapter,
      chapterBrief,
      chapterPageStart: setup?.startPage,
      chapterPageEnd: setup?.endPage,
      previousPages,
      nextPages,
      generationJobId: options.generationJobId
    });
    previousPages.push(saved.page);
  }

  await advanceJobStep(options.generationJobId, "enqueue", 90, "Queueing export");
  await maybeEnqueueCompile(options.projectId, options.planId);
}
