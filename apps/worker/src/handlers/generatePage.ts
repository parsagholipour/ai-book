import {
  formatQualityFailure,
  getProjectOrThrow,
  parseChapterBrief,
  strategyForInput,
  styleExcerptsForPage,
  toPriorPageContext
} from "../generation/bookHelpers.js";
import { loadContinuityNotes, loadResearchNotesForGeneration } from "../generation/generationContext.js";
import { runPageQualityLoop } from "../generation/pageReview.js";
import { pageRevisionMessage } from "../generation/pageReviewRecovery.js";
import {
  enrichPageQualityReport,
  mergeEntityAndStoryStateLines,
  persistKeeperStoryDelta
} from "../generation/qualityEnrichment.js";
import { applyPlanThinkingBoost, loadQualityContext } from "../generation/qualitySettings.js";
import { loadProjectStoryState } from "../generation/storyStateStore.js";
import { repairPageEmbeddings } from "../generation/embeddingRepair.js";
import { storeEmbedding } from "../generation/embeddingWrites.js";
import { loadEntityStateLines, updateEntityStateFromPage } from "../generation/entityState.js";
import { retrieveSemanticResearchNotes } from "../generation/researchMemory.js";
import {
  RECENT_PAGE_WINDOW,
  embedSemanticQuery,
  lexicalTermsForQuery,
  retrieveSemanticPageMemory
} from "../generation/semanticRecall.js";
import { pageQaCandidatesFor, pageQaRewriteAttemptsFor } from "../generation/tuning.js";
import { inputForPlanVersion } from "../generation/projectInput.js";
import {
  GeneratedPagePublicationClaimLostError,
  publishStagedGeneratedPage,
  stageGeneratedPageAndBrief,
  type GeneratedPagePublicationSnapshot
} from "../generation/pagePublication.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { enqueueNextPageIfReady } from "../runtime/dispatch.js";
import { advanceJobStep, updateJobProgress } from "../runtime/jobLifecycle.js";
import { isStopRequestedError } from "../runtime/jobTypes.js";
import { nextPageVersion } from "../generation/pageIllustrationOwnership.js";
import {
  bestOfCandidateCount,
  bookPlanSchema,
  createProviders,
  firstPageCandidateCount,
  formatStoryStateLines,
  generateBestOfPageDrafts,
  generatePageDraftWithWriterTools,
  type PriorPageContext
} from "@book-maker/core";
import { pageScope, prisma } from "@book-maker/db";
import { Job } from "bullmq";

/**
 * `generate-page` job: draft, review and save a single page.
 */

export async function generatePage(job: Job) {
  const { projectId, pageId, planId } = job.data as { projectId: string; pageId: string; planId: string };
  const generationJobId = job.data.generationJobId as string | undefined;
  const [project, page, planVersion] = await Promise.all([
    getProjectOrThrow(projectId),
    prisma.page.findUnique({ where: { id: pageId }, include: { chapter: true } }),
    prisma.planVersion.findUnique({ where: { id: planId } })
  ]);
  if (!page || !planVersion) {
    throw new Error("Page or plan not found");
  }

  const input = inputForPlanVersion(project, planVersion.inputSnapshot);
  const strategy = strategyForInput(input);
  const plan = bookPlanSchema.parse(planVersion.planningPackage);
  // The only fallible work after COMPLETED is deduped fan-out. A retry of the
  // same plan replays that tail without redrafting or touching the keeper.
  if (page.status === "COMPLETED") {
    if (project.currentPlanId === planId) {
      await enqueueNextPageIfReady(projectId, planId, input);
    }
    return;
  }
  const providers = createLoggedProviders(job, createProviders(config, input), input);
  // Prisma always returns Date here; the fallback keeps narrow handler mocks
  // that predate the row-version protocol from inventing a production state.
  const loadedPageVersion = page.updatedAt instanceof Date ? page.updatedAt : new Date(0);
  const pageVersion = nextPageVersion(loadedPageVersion);
  const claimed = await prisma.page.updateMany({
    where: {
      id: pageId,
      index: page.index,
      updatedAt: loadedPageVersion,
      status: { not: "COMPLETED" }
    },
    data: { status: "GENERATING", updatedAt: pageVersion }
  });
  if (claimed.count !== 1) {
    return;
  }
  const publicationSnapshot: GeneratedPagePublicationSnapshot = {
    id: page.id,
    status: "GENERATING",
    title: page.title,
    markdown: page.markdown,
    summary: page.summary,
    imagePrompt: page.imagePrompt,
    revision: page.revision,
    updatedAt: pageVersion
  };
  const chapterPlan = plan.chapters.find((chapter) => chapter.index === page.chapter?.index);
  const chapterBrief = parseChapterBrief(page.chapter?.productionBrief);
  const pageBrief = chapterBrief?.pages.find((brief) => brief.pageIndex === page.index);

  const semanticQueryText = [
    pageBrief ? `${pageBrief.purpose} ${pageBrief.beat}` : "",
    chapterPlan ? `${chapterPlan.title} ${chapterPlan.summary}` : "",
    plan.premise
  ]
    .filter(Boolean)
    .join("\n");
  // The trigram arms of both retrievals below take distinctive needles, not
  // the composed brief: entity names the brief mentions score 1.0 against a
  // note or summary naming them, while the whole brief measurably matches
  // nothing but stop-word noise. The names select the relevance share of the
  // continuity notes, so a setup about this page's cast planted far behind
  // the recency window can still reach the page that pays it off.
  const lexicalTerms = lexicalTermsForQuery(plan, semanticQueryText);

  // Everything the composed brief needs is already in hand — the page row, the
  // plan and the input — so none of these six loads reads anything another one
  // writes, and they go out together instead of one await at a time. The
  // embedding call is why it is worth doing: it is the only provider round trip
  // in the set, so every database read now finishes underneath it rather than
  // after it. `loadContinuityNotes` belongs here despite taking `queryTerms`,
  // because those terms come from the plan and this page's own brief — nothing
  // this set loads.
  //
  // The fan-out is deliberately bounded, and to *reads* only. At most seven
  // statements leave a page job at once (`loadContinuityNotes` and
  // `loadEntityStateLines` each run two of their own), and with
  // `MAX_PARALLEL_PAGE_JOBS` at 4 against the worker's 10-connection pg pool a
  // full wave queues on the pool rather than exhausting it: these are short
  // point reads, none of them holds a transaction open across an await, and
  // pg's connection acquisition has no timeout unless one is configured, so the
  // excess waits instead of erroring. Provider concurrency does not change at
  // all — one embedding call in flight, exactly as before.
  const [previousPages, continuityNotes, semanticQueryVector, entityStateLines, quality, storyState] =
    await settleIndependentLoads([
      prisma.page.findMany({
        // The window itself, not a number that happens to match it:
        // `pastRecencyWindow` below and `shouldSkipWriterTools`
        // (`packages/core/src/generation/writerTools.ts`) both read the gate off
        // this load, so a second copy of the number could only drift from it.
        where: { projectId, index: { lt: page.index }, status: "COMPLETED" },
        orderBy: { index: "desc" },
        take: RECENT_PAGE_WINDOW
      }),
      // Same clamp the page-memory retrieval below takes, and for the same
      // reason: on a FAILED_QA retry this page's successors are COMPLETED and
      // have written continuity notes about this page's own cast.
      loadContinuityNotes(projectId, { queryTerms: lexicalTerms, beforePageIndex: page.index }),
      // Embedded once: the research retrieval and the page-memory retrieval
      // share this vector instead of paying two embedding calls for the same
      // string.
      embedSemanticQuery(providers.embedding, semanticQueryText, projectId),
      loadEntityStateLines(projectId, plan),
      loadQualityContext(input),
      loadProjectStoryState(projectId, plan.promises ?? [])
    ]);
  const orderedPreviousPages = previousPages.reverse();
  const priorPageContext = orderedPreviousPages.map(toPriorPageContext);
  applyPlanThinkingBoost(providers.text, quality.enabled("planThinkingBoost"));

  // What follows stays serial, and every link in it is a real dependency rather
  // than a habit: both retrievals want the vector above, and the repair pass
  // writes the very embedding rows the retrieval then reads, so overlapping the
  // two would have a page read the memory it is in the middle of backfilling.
  // The repair is also the only step here that writes anything, and it spends
  // up to three embedding calls of its own — running it beside the research
  // retrieval would multiply provider concurrency across a whole wave of page
  // jobs to save a single database round trip.
  const researchNotes = await loadResearchNotesForGeneration(projectId, strategy, chapterPlan, {
    embedding: providers.embedding,
    queryText: semanticQueryText,
    ...(semanticQueryVector ? { vector: semanticQueryVector } : {})
  });
  const pastRecencyWindow = page.index > RECENT_PAGE_WINDOW + 1;
  if (pastRecencyWindow) {
    // Backfill a few missing or degraded page embeddings before this page
    // reads long-range memory. The recency-window cutoff is a cost/race
    // reduction heuristic — a page in BullMQ retry backoff can still sit
    // COMPLETED with no row — uniqueness plus upsert is what settles a
    // duplicate insert, not this bound.
    await repairPageEmbeddings({
      projectId,
      embedding: providers.embedding,
      beforeIndex: page.index - RECENT_PAGE_WINDOW
    });
  }
  const semanticMemory = pastRecencyWindow
    ? await retrieveSemanticPageMemory({
        projectId,
        queryText: semanticQueryText,
        lexicalTerms,
        embedding: providers.embedding,
        excludePageIndexes: orderedPreviousPages.map((previousPage) => previousPage.index),
        // Same clamp `lookupStoredPage` applies below, for the same reason: on
        // a retry this page's successors are COMPLETED and embedded.
        beforePageIndex: page.index,
        ...(semanticQueryVector ? { vector: semanticQueryVector } : {})
      })
    : [];
  const storyLines = formatStoryStateLines(storyState);
  const entityState = mergeEntityAndStoryStateLines(entityStateLines, storyLines);
  const styleExcerpts = await styleExcerptsForPage({
    projectId,
    pageIndex: page.index,
    recencyPages: priorPageContext,
    input,
    quality
  });

  // Sequential drafting uses the same `bestOfPolish` gate as polish
  // (`polishPageWithQualityGates`). Operator `draftCandidates` only applies
  // when that gate is on. Page 1 is the exception: it best-ofs by tier
  // (`firstPageCandidateCount`), and `Math.max` keeps the two gates from
  // multiplying on ultra.
  const candidateCount = Math.max(
    quality.enabled("bestOfPolish") ? bestOfCandidateCount(input) : 1,
    firstPageCandidateCount(input, page.index)
  );
  await advanceJobStep(
    generationJobId,
    "draft",
    30,
    candidateCount > 1 ? `Drafting page ${page.index} (${candidateCount} candidates)` : `Drafting page ${page.index}`
  );
  const draftOptions = {
    input,
    plan,
    chapter: chapterPlan,
    chapterBrief,
    pageBrief,
    pageIndex: page.index,
    previousSummaries: orderedPreviousPages.map((previousPage) => previousPage.summary).filter(Boolean),
    previousPages: priorPageContext,
    continuityNotes,
    researchNotes,
    semanticMemory,
    entityState,
    ...(styleExcerpts.length > 0 ? { styleExcerpts } : {}),
    // Injected so the writer tool loop can reach the whole manuscript and its
    // long-range memory, not just the pages already in this context pack.
    lookupStoredPage: async (index: number): Promise<PriorPageContext | null> => {
      // FAILED_QA retry: later pages and this page's stale draft are already
      // COMPLETED, so looking them up would hand the model future content
      // (or its own prior draft) as a "stored earlier page."
      if (index >= page.index) {
        return null;
      }
      const stored = await prisma.page.findFirst({
        where: { projectId, index, status: "COMPLETED" },
        select: { index: true, title: true, summary: true, markdown: true }
      });
      return stored ?? null;
    },
    searchStoredMemory: (query: string): Promise<string[]> =>
      retrieveSemanticPageMemory({
        projectId,
        queryText: query,
        // The model's own query is the needle: it types the distinctive
        // phrase it wants back ("brass key"), which is exactly the shape
        // strict_word_similarity scores 1.0 when a summary contains it.
        lexicalTerms: [query],
        embedding: providers.embedding,
        // The tool promises the model "earlier pages of this book", so the
        // search is clamped exactly like `lookupStoredPage` above: on a
        // FAILED_QA retry the pages after this one are already COMPLETED and
        // embedded, and `search_memory("the vault")` would answer with
        // `Page 41:` — events the page being drafted has not reached.
        // `beforePageIndex` is strict, so it also covers this page's own stale
        // draft; `excludePageIndexes` keeps that explicit for a reader.
        excludePageIndexes: [page.index],
        beforePageIndex: page.index
      }),
    textModel: providers.text
  };
  const draftPage = async (options: typeof draftOptions) => {
    if (!quality.enabled("writerTools")) {
      return strategy.generatePageDraft(options);
    }
    return generatePageDraftWithWriterTools({
      ...options,
      storyState,
      fallback: () => strategy.generatePageDraft(options)
    });
  };
  const initialDraft =
    candidateCount > 1
      ? await generateBestOfPageDrafts({
          draftPage,
          baseOptions: draftOptions,
          candidateCount,
          judgeModel: providers.text
        })
      : await draftPage(draftOptions);
  await advanceJobStep(generationJobId, "qa", 55, `Reviewing page ${page.index}`);
  const initialReport = await strategy.reviewPageDraft({
    input,
    plan,
    chapter: chapterPlan,
    chapterBrief,
    pageBrief,
    pageIndex: page.index,
    draft: initialDraft,
    previousPages: priorPageContext,
    continuityNotes,
    textModel: providers.text,
    ...(styleExcerpts.length > 0 ? { styleExcerpts } : {})
  });
  const enriched = await enrichPageQualityReport({
    input,
    plan,
    pageIndex: page.index,
    draft: initialDraft,
    report: initialReport,
    previousPages: priorPageContext,
    researchNotes,
    textModel: providers.text,
    projectId,
    quality,
    storyState,
    styleExcerpts
  });

  const outcome = await runPageQualityLoop({
    projectId,
    strategy,
    input,
    plan,
    chapter: chapterPlan,
    chapterBrief,
    pageBrief,
    chapterId: page.chapterId,
    pageIndex: page.index,
    draft: initialDraft,
    report: enriched.report,
    previousPages: priorPageContext,
    continuityNotes,
    textModel: providers.text,
    generationJobId,
    maxCandidates: pageQaCandidatesFor(input),
    repairBrief: true,
    // This handler owns the page's terminal write, so a kept brief repair
    // stays staged until both can be committed as one durable fact below.
    deferBriefRepairPersistence: true,
    reviseContext: `Page ${page.index}`,
    reviseProgress: 70,
    quality,
    ...(styleExcerpts.length > 0 ? { styleExcerpts } : {}),
    ...(quality.enabled("claimRetrieve")
      ? {
          retrieveResearch: (draft) =>
            retrieveSemanticResearchNotes({
              projectId,
              queryText: `${draft.title}\n${draft.summary}\n${draft.markdown}`.slice(0, 1200),
              embedding: providers.embedding,
              topK: 6
            })
        }
      : {}),
    onRewrite: (nextRevision, recoveryRevision) =>
      advanceJobStep(
        generationJobId,
        "revise",
        70,
        pageRevisionMessage(page.index, nextRevision, pageQaRewriteAttemptsFor(input), recoveryRevision)
      )
  });
  const { draft, revision, report: qualityReport } = outcome;

  const stageKeeper = async (status: "GENERATING" | "FAILED_QA") => {
    try {
      return await stageGeneratedPageAndBrief({
        projectId,
        chapterId: page.chapterId,
        pageIndex: page.index,
        draft,
        revision,
        qualityReport,
        status,
        pendingBriefRepair: outcome.pendingBriefRepair,
        existingPage: publicationSnapshot
      });
    } catch (error) {
      // A newer delivery already moved this stable page id. Its keeper, brief
      // and generated illustration ownership win together; this stale Bull
      // delivery has no tail left to publish.
      if (error instanceof GeneratedPagePublicationClaimLostError) {
        return undefined;
      }
      throw error;
    }
  };

  if (!qualityReport.approved) {
    // Page-level failure isolation: keep the best draft with its honest
    // report, flag the page, and let the rest of the book continue. The page
    // can be retried individually and the final review can still repair it.
    const stagedPage = await stageKeeper("FAILED_QA");
    if (!stagedPage) {
      return;
    }
    await persistKeeperStoryDelta({
      projectId,
      pageIndex: page.index,
      draft,
      textModel: providers.text,
      plan,
      input,
      previousExtract: enriched.extract,
      keeperWasRevised: revision > 1,
      currentState: enriched.storyState,
      quality
    });
    await updateJobProgress(generationJobId, {
      message: `Page ${page.index} kept its best draft but failed quality review; continuing with the next page. ${formatQualityFailure(page.index, qualityReport)}`
    });
    // No maybeEnqueueCompile here: this job's own row is still ACTIVE, so the
    // open-jobs gate can never pass from inside the handler. The compile check
    // that actually fires is maybeCompileAfterCompletedJob in processJob.ts.
    await enqueueNextPageIfReady(projectId, planId, input);
    return;
  }

  await advanceJobStep(generationJobId, "save", 88, `Saving page ${page.index}`);
  const willIllustrate = Boolean(draft.imagePrompt) && strategy.shouldIllustratePage(input, plan, page.index);
  // Every approved keeper is durable but non-terminal before its fallible
  // publication tail. A repaired brief joins the same conditional transaction.
  // Illustrated pages additionally need this stage before their tokened job
  // can start and compare itself with the page it depicts.
  const stagedPage = await stageKeeper("GENERATING");
  if (!stagedPage) {
    return;
  }
  const publication = await publishStagedGeneratedPage({
    projectId,
    planId,
    pageIndex: page.index,
    draft,
    stagedPage,
    willIllustrate,
    continuityTags: ["page", String(page.index)]
  });
  if (publication === "enqueue-declined") {
    return;
  }
  if (publication === "superseded") {
    // A structural move preserves the staged version but invalidates the
    // numeric completion claim. Retrying lets this stable page settle from its
    // new position; reporting success here would strand its staged row in
    // GENERATING after this job becomes terminal.
    throw new GeneratedPagePublicationClaimLostError(page.index);
  }

  // These memory helpers are best-effort by contract: ordinary provider and
  // database failures are recorded/degraded internally, and only a user stop
  // escapes (which processJob makes unrecoverable). They stay after the final
  // ownership CAS so a losing old delivery cannot write stale memory, while a
  // Bull retry can only arise from the deduped fan-out below.
  await persistKeeperStoryDelta({
    projectId,
    pageIndex: page.index,
    draft,
    textModel: providers.text,
    plan,
    input,
    previousExtract: enriched.extract,
    keeperWasRevised: revision > 1,
    currentState: enriched.storyState,
    quality
  });

  if (draft.continuityNotes.length > 0) {
    await updateEntityStateFromPage(projectId, page.index, draft.continuityNotes);
  }

  await storeEmbedding({ projectId, scope: pageScope(page.index), sourceId: pageId, text: draft.summary }, providers.embedding);

  await enqueueNextPageIfReady(projectId, planId, input);
}

/**
 * Awaits loads that depend on nothing each other produces, without changing
 * which failure the page job ends up seeing.
 *
 * `Promise.all` is the wrong tool here twice over. It settles on the *first*
 * rejection and leaves its siblings running behind the handler's own failure
 * settlement — a warn line or a stray provider call landing in the next job's
 * run log — and it makes which error wins a matter of who lost the race. That
 * second half is the expensive one: `embedSemanticQuery` rethrows the
 * `StopRequestedError` the logged adapter raises when the reader stops the run,
 * and `loadEntityStateLines` and `loadProjectStoryState` swallow everything
 * *except* that error, so a stop is the one rejection several of these loads
 * can produce — and `Promise.all` would let an ordinary database error from a
 * sibling read mask it. `generate-page` has retry attempts, so the masked stop
 * comes back as a retry of a run the user already cancelled, and the book is
 * charged for it.
 *
 * So: wait for every load, then choose deterministically. A stop request wins
 * wherever it came from, and otherwise the failure the serial chain this
 * replaced would have thrown — the earliest one in argument order, which is
 * that chain's order. Nothing is swallowed and nothing escapes: `allSettled`
 * holds every other rejection, so none of them can surface as an unhandled
 * rejection either.
 */
async function settleIndependentLoads<T extends readonly unknown[] | []>(
  loads: T
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const settled = await Promise.allSettled(loads);
  const failures = settled.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
  for (const failure of failures) {
    if (isStopRequestedError(failure)) {
      throw failure;
    }
  }
  if (failures.length > 0) {
    throw failures[0];
  }
  return settled.map((result) => (result as PromiseFulfilledResult<unknown>).value) as unknown as {
    -readonly [K in keyof T]: Awaited<T[K]>;
  };
}
