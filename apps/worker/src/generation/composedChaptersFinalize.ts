import {
  type BookGenerationStrategy,
  type BookPlan,
  type CreateProjectInput,
  type ProviderSet
} from "@book-maker/core";
import { prisma, pageScope } from "@book-maker/db";
import { advanceJobStep, updateJobProgress } from "../runtime/jobLifecycle.js";
import type { IndexedPageDraft } from "../runtime/jobTypes.js";
import { loadComposedBookState } from "./composedChaptersState.js";
import {
  GeneratedPagePublicationClaimLostError,
  loadGeneratedPagePublicationSnapshot,
  publishStagedGeneratedPage,
  stageGeneratedPageAndBrief
} from "./pagePublication.js";
import { persistKeeperStoryDelta } from "./qualityEnrichment.js";
import { loadProjectStoryState } from "./storyStateStore.js";
import { reviewWholeBookDraftPages } from "./wholeBookPageReview.js";

/**
 * The composed pass's last step: the whole book's PENDING page rows through
 * the page-level local checks and into publication, one page at a time.
 * Split from `composedChaptersPass.ts` for the 900-line budget.
 */
export async function finalizePendingPages(options: {
  projectId: string;
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  generationJobId?: string | undefined;
}): Promise<void> {
  const { projectId, planId, input, plan, providers, strategy, generationJobId } = options;
  const state = await loadComposedBookState(projectId);
  const pending = state.pages.filter((page) => page.status === "PENDING");
  if (pending.length === 0) {
    return;
  }
  const notesByIndex = new Map<number, string[]>();
  const chapterIdByIndex = new Map<number, string>();
  for (const chapter of state.chapters) {
    for (const [pageIndex, notes] of chapter.pageNotes) {
      notesByIndex.set(pageIndex, notes);
      chapterIdByIndex.set(pageIndex, chapter.id);
    }
  }
  await advanceJobStep(generationJobId, "setup", 76, `Finalizing ${pending.length} pages`);
  const drafts: IndexedPageDraft[] = pending.map((page) => ({
    index: page.index,
    title: page.title,
    markdown: page.markdown,
    summary: page.summary,
    continuityNotes: notesByIndex.get(page.index) ?? [],
    ...(page.imagePrompt ? { imagePrompt: page.imagePrompt } : {})
  }));
  const reviewed = await reviewWholeBookDraftPages({
    input,
    plan,
    strategy,
    textModel: providers.text,
    pages: drafts,
    generationJobId
  });

  let currentState = await loadProjectStoryState(projectId, plan.promises ?? []);
  for (const [offset, page] of reviewed.entries()) {
    const pageIndex = page.draft.index;
    const existing = await loadGeneratedPagePublicationSnapshot(projectId, pageIndex);
    if (!existing || existing.status !== "PENDING") {
      continue;
    }
    const approved = page.qualityReport.approved;
    const willIllustrate =
      approved && Boolean(page.draft.imagePrompt) && strategy.shouldIllustratePage(input, plan, pageIndex);
    const staged = await stageGeneratedPageAndBrief({
      projectId,
      chapterId: chapterIdByIndex.get(pageIndex) ?? null,
      pageIndex,
      draft: page.draft,
      revision: page.revision,
      qualityReport: page.qualityReport,
      status: approved ? (willIllustrate ? "GENERATING" : "COMPLETED") : "FAILED_QA",
      pendingBriefRepair: undefined,
      existingPage: existing
    });
    if (approved && !willIllustrate && page.draft.continuityNotes.length > 0) {
      await prisma.continuityNote.createMany({
        data: page.draft.continuityNotes.map((body) => ({
          projectId,
          pageId: staged.id,
          scope: pageScope(pageIndex),
          body,
          tags: ["page", String(pageIndex), strategy.id]
        }))
      });
    }
    if (willIllustrate) {
      const publication = await publishStagedGeneratedPage({
        projectId,
        planId,
        pageIndex,
        draft: page.draft,
        stagedPage: staged,
        willIllustrate: true,
        continuityTags: ["page", String(pageIndex), strategy.id]
      });
      if (publication === "enqueue-declined") {
        return;
      }
      if (publication === "superseded") {
        throw new GeneratedPagePublicationClaimLostError(pageIndex);
      }
    }
    if (approved) {
      const nextState = await persistKeeperStoryDelta({
        projectId,
        pageIndex,
        draft: page.draft,
        textModel: providers.text,
        plan,
        input,
        previousExtract: null,
        keeperWasRevised: page.revision > 1,
        currentState
      });
      if (nextState) {
        currentState = nextState;
      }
    }
    if ((offset + 1) % 10 === 0) {
      await updateJobProgress(generationJobId, {
        progress: 76 + Math.round(((offset + 1) / reviewed.length) * 12),
        message: `Finalized ${offset + 1}/${reviewed.length} pages`
      });
    }
  }
}

/**
 * A stance the pass had to generate is written back onto the approved plan, so
 * the console can show the author the book was written as and a later
 * continuation or chat edit reads the same one. The merge keeps every other
 * field of the stored package byte for byte.
 */
