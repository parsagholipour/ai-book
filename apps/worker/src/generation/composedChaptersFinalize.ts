import {
  type BookGenerationStrategy,
  type BookPlan,
  type CreateProjectInput,
  type PageDraft,
  type ProviderSet,
  chapterCaseEvidence, mapWithConcurrency, reviewChapterCaseEvidence, reviewSourceClaims, stripFigureFences
} from "@book-maker/core";
import { prisma, pageScope } from "@book-maker/db";
import { advanceJobStep, updateJobProgress } from "../runtime/jobLifecycle.js";
import type { IndexedPageDraft } from "../runtime/jobTypes.js";
import { restoreFigures, stripDraftFigures } from "./composedFigures.js";
import { loadComposedBookState, recordChapterEvidenceResiduals, recordChapterSourceClaims } from "./composedChaptersState.js";
import { sourceClaimDigest, sourceClaimReviewApplies } from "./composedClaimReview.js";
import { parseEvidenceFinding } from "./composedEvidenceRepair.js";
import type { RunLogger } from "../providers/runLogging.js";
import {
  GeneratedPagePublicationClaimLostError,
  loadGeneratedPagePublicationSnapshot,
  publishStagedGeneratedPage,
  stageGeneratedPageAndBrief
} from "./pagePublication.js";
import { keeperStoryExtractForSave, persistStoryExtract } from "./qualityEnrichment.js";
import { loadQualityContext } from "./qualitySettings.js";
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
  runLog?: Pick<RunLogger, "append"> | undefined;
}): Promise<void> {
  const { projectId, planId, input, plan, providers, strategy, generationJobId, runLog } = options;
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
  await advanceJobStep(generationJobId, "setup", 76, `Finalizing ${pending.length} pages`, {
    done: plan.chapters.length,
    total: plan.chapters.length,
    phase: "finalize"
  });
  // Figures aside: the local checks, a revise and the story delta read prose;
  // each page's blocks go back before it is staged (`composedFigures.ts`).
  const pendingDrafts: IndexedPageDraft[] = pending.map((page) => ({
    index: page.index,
    title: page.title,
    markdown: page.markdown,
    summary: page.summary,
    continuityNotes: notesByIndex.get(page.index) ?? [],
    ...(page.imagePrompt ? { imagePrompt: page.imagePrompt } : {})
  }));
  const { drafts, fencesByIndex } = stripDraftFigures(pendingDrafts);
  const reviewed = await reviewWholeBookDraftPages({
    input,
    plan,
    strategy,
    textModel: providers.text,
    pages: drafts,
    generationJobId
  });

  // A local leak repair is another writer. Check its changed case assertions before publishing any page.
  const reviewedByIndex = new Map(reviewed.map((page) => [page.draft.index, page.draft.markdown]));
  // Restore once before the final source review: local QA saw figure-free drafts,
  // but the published pages (and compile's digest) carry each figure's stand-in.
  const publicationDrafts = new Map(reviewed.map((page) => [page.draft.index, restoreFigures(page.draft, fencesByIndex)]));
  let start = 1;
  for (const chapter of plan.chapters) {
    const end = start + chapter.targetPages;
    const pages = state.pages.filter((page) => page.index >= start && page.index < end);
    const changed = pages.some((page) => reviewedByIndex.has(page.index) && reviewedByIndex.get(page.index) !== drafts.find((draft) => draft.index === page.index)?.markdown);
    if (sourceClaimReviewApplies(input, plan) && pages.some((page) => page.status === "PENDING")) {
      const markdown = pages.map((page) => stripFigureFences(publicationDrafts.get(page.index)?.markdown ?? page.markdown).prose).join("\n\n");
      const stored = state.chapters.find((entry) => entry.index === chapter.index);
      const textDigest = sourceClaimDigest(markdown);
      // Includes manuscript cuts, developmental edits, arithmetic repairs, and resumed old chapters.
      if (stored?.sourceClaimsDigest !== textDigest || stored.sourceClaimsStatus !== "reviewed") {
        const excerpts = [...new Map([...(plan.dossier?.excerpts ?? []), ...(plan.dossier?.evidencePackets ?? []).flatMap((packet) => packet.excerpts)].map((excerpt) => [excerpt.id, excerpt])).values()];
        const review = await reviewSourceClaims({ markdown, excerpts, textModel: providers.text });
        await recordChapterSourceClaims(projectId, chapter.index, { ...review, textDigest });
        await runLog?.append("generation.composed_chapters.claim_coverage", { projectId, chapterIndex: chapter.index, stage: "finalize", textDigest, ...review });
      }
    } else if (changed) {
      const markdown = pages.map((page) => reviewedByIndex.get(page.index) ?? page.markdown).join("\n\n");
      const review = await reviewChapterCaseEvidence({ markdown, packets: plan.dossier?.evidencePackets ?? chapterCaseEvidence(plan, chapter.index), textModel: providers.text });
      if (review.issues.length || review.dropped.length) {
        // The same door as the compose-time residuals: recorded on the chapter, flagged by the compile, never a failed book.
        const unresolved = review.issues.map(parseEvidenceFinding);
        console.warn("Final page repair left unsupported case claims", { event: "generation.composed_chapters.evidence_unresolved", projectId, chapterIndex: chapter.index, stage: "finalize", unresolved, dropped: review.dropped.length });
        await runLog?.append("generation.composed_chapters.evidence_unresolved", { projectId, chapterIndex: chapter.index, stage: "finalize", unresolved, dropped: review.dropped.length });
        await recordChapterEvidenceResiduals(projectId, chapter.index, unresolved);
      }
    }
    start = end;
  }

  const keepers: Array<{ pageIndex: number; draft: PageDraft; revised: boolean }> = [];
  for (const [offset, page] of reviewed.entries()) {
    const pageIndex = page.draft.index;
    const existing = await loadGeneratedPagePublicationSnapshot(projectId, pageIndex);
    if (!existing || existing.status !== "PENDING") {
      continue;
    }
    const approved = page.qualityReport.approved;
    const willIllustrate =
      approved && Boolean(page.draft.imagePrompt) && strategy.shouldIllustratePage(input, plan, pageIndex);
    const draft = publicationDrafts.get(pageIndex)!;
    const staged = await stageGeneratedPageAndBrief({
      projectId,
      chapterId: chapterIdByIndex.get(pageIndex) ?? null,
      pageIndex,
      draft,
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
        draft,
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
    if (approved) keepers.push({ pageIndex, draft: page.draft, revised: page.revision > 1 });
    if ((offset + 1) % 10 === 0) {
      await updateJobProgress(generationJobId, {
        progress: 76 + Math.round(((offset + 1) / reviewed.length) * 6),
        message: `Finalized ${offset + 1}/${reviewed.length} pages`
      });
    }
  }
  await persistChapterStoryDeltas({ projectId, input, plan, providers, generationJobId, keepers, chapterIdByIndex });
}

/**
 * The story state: one extraction per approved page as before, but a
 * chapter's pages are extracted together against the state the chapter
 * started from, then applied in page order. One after another, the calls
 * were 140 of a Quick Draft guide's 610 seconds (2026-09-30), and every
 * chapter was already written, so nothing downstream was waiting on the
 * state they built. A page no longer sees what an earlier page of its own
 * chapter added: a repeat is merged on apply where the state keys it
 * (promises, entities) and appended where it does not (facts).
 */
export async function persistChapterStoryDeltas(options: {
  projectId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  generationJobId?: string | undefined;
  keepers: ReadonlyArray<{ pageIndex: number; draft: PageDraft; revised: boolean }>;
  chapterIdByIndex: ReadonlyMap<number, string>;
}): Promise<void> {
  const { projectId, input, plan, keepers } = options;
  const quality = await loadQualityContext(input);
  if (keepers.length === 0 || !quality.enabled("storyExtractAudit")) return;
  // `storyNotesTogether` (Quick Draft): one window for the whole book, so
  // every page is extracted at once against the state the book opened with.
  const together = quality.enabled("storyNotesTogether");
  const chapters: Array<typeof keepers[number][]> = [];
  for (const keeper of keepers) {
    const chapterId = options.chapterIdByIndex.get(keeper.pageIndex);
    const last = chapters.at(-1);
    if (last && (together || options.chapterIdByIndex.get(last[0]!.pageIndex) === chapterId)) last.push(keeper);
    else chapters.push([keeper]);
  }
  let currentState = await loadProjectStoryState(projectId, plan.promises ?? []);
  let done = 0;
  for (const pages of chapters) {
    const chapterState = currentState;
    const extracts = await mapWithConcurrency(pages, together ? BOOK_STORY_EXTRACT_CONCURRENCY : STORY_EXTRACT_CONCURRENCY, (page) => keeperStoryExtractForSave({
      projectId, pageIndex: page.pageIndex, draft: page.draft, textModel: options.providers.text, plan, input,
      previousExtract: null, keeperWasRevised: page.revised, currentState: chapterState, quality
    }));
    for (const [offset, extract] of extracts.entries()) {
      if (!extract) continue;
      const nextState = await persistStoryExtract({ projectId, pageIndex: pages[offset]!.pageIndex, plan, extract });
      if (nextState) currentState = nextState;
    }
    done += pages.length;
    await updateJobProgress(options.generationJobId, {
      progress: 82 + Math.round((done / keepers.length) * 6),
      message: `Noted the story state of ${done}/${keepers.length} pages`
    });
  }
}

/** Calls in flight within one chapter's extraction. */
const STORY_EXTRACT_CONCURRENCY = 6;
/** Calls in flight when the whole book is one window: a 20–30 page book's pages in two or three rounds. */
const BOOK_STORY_EXTRACT_CONCURRENCY = 12;
