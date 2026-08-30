import { getProjectOrThrow, strategyForInput } from "../generation/bookHelpers.js";
import {
  generateBookBatchWindow,
  generateBookChapterWholePass,
  generateBookDraftThenPolish,
  generateBookWholePass
} from "../generation/bookPasses.js";
import { prepareChapterSetups } from "../generation/bookState.js";
import { ensureCharacterReferenceAssets } from "../generation/characterReferences.js";
import { strategyUsesSemanticMemory } from "../generation/embeddingWrites.js";
import { embedResearchSourcesForProject } from "../generation/researchMemory.js";
import { inputForPlanVersion } from "../generation/projectInput.js";
import { generateReplannedBook } from "../generation/replanEditCandidates.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { enqueueWorkerJob, maybeEnqueueCompile, maybeEnqueueCover, parallelPageWaveSize } from "../runtime/dispatch.js";
import { advanceJobStep, updateJobProgress } from "../runtime/jobLifecycle.js";
import { type JobCompletion } from "../runtime/jobTypes.js";
import {
  bookPlanSchema,
  createProviders,
  expandChapterResearch,
  jsonPayloadToRecord,
  seedStoryStateFromPromises,
  type BookGenerationStrategy,
  type BookPlan,
  type CreateProjectInput,
  type ProviderSet
} from "@book-maker/core";
import { Prisma, prisma, PAGE_SCOPE_PREFIX } from "@book-maker/db";
import type { GenerateBookJob } from "../runtime/jobPayloads.js";

/**
 * `generate-book` job: pick an execution strategy for a plan, set up chapters and
 * pages, and either fan out per-page jobs or run a direct in-process generation.
 */

export async function generateBook(job: GenerateBookJob): Promise<JobCompletion> {
  const { projectId, planId, generationJobId } = job.data;
  const project = await getProjectOrThrow(projectId);
  const planVersion = await prisma.planVersion.findUnique({ where: { id: planId } });
  if (!planVersion) {
    throw new Error("Approved plan not found");
  }
  const input = inputForPlanVersion(project, planVersion.inputSnapshot);
  const plan = bookPlanSchema.parse(planVersion.planningPackage);
  const strategy = strategyForInput(input);
  const providers = createLoggedProviders(job, createProviders(config, input), input);

  const stagedReplanOperationId = await stagedReplanSuccessorOperationId(job);
  if (stagedReplanOperationId) {
    // A replan deliberately does not reach the execution-mode switch below. Its
    // pages are drafted, adherence-audited and repaired in memory and published
    // in one transaction, so the reader's book survives a replan that fails the
    // audit; every arm of that switch writes chapters and pages as it goes and
    // would destroy the manuscript before knowing whether the replacement is
    // any good. The strategy still writes the prose — `generatePageDraft` is
    // its own — so only the orchestration differs.
    const completion = await generateReplannedBook({
      projectId,
      planId,
      operationId: stagedReplanOperationId,
      sourceProjectId: job.data.sourceProjectId,
      queuedEditInstruction: job.data.editInstruction,
      queuedRequest: job.data.request,
      queuedCharacterContext: job.data.characterContext,
      input,
      plan,
      providers,
      strategy,
      generationJobId,
      attemptId: job.data.attemptId
    });
    return {
      ...completion,
      afterJobCompleted: async () => {
        // After the delivery tail, never in front of it. The publication
        // transaction is the tail lease's last renewal, and nothing heartbeats
        // it again until `replannedBookFollowUpCompletion` starts its own — so
        // an unbounded per-chapter research expansion here spent the whole
        // three-minute budget on a picture the tail needed, and the first
        // statement of that tail is the renewal that would then find the lease
        // gone. The expansion's own rows are read by the compile this tail
        // queues, so a corpus that lands behind that enqueue reaches the next
        // export rather than this one; a tail that cannot start reaches none.
        await completion.afterJobCompleted?.();
        await expandPublishedReplanResearch({ projectId, input, plan, providers, strategy, generationJobId });
      }
    };
  }

  await maybeExpandStrategyResearch({
    projectId,
    input,
    plan,
    providers,
    strategy,
    generationJobId
  });

  switch (strategy.executionMode) {
    case "whole-book":
      await generateBookWholePass({
        projectId,
        planId,
        input,
        plan,
        providers,
        strategy,
        generationJobId
      });
      return {};
    case "chapter-whole-pass":
      await generateBookChapterWholePass({
        projectId,
        planId,
        input,
        plan,
        providers,
        strategy,
        generationJobId
      });
      return {};
    case "batch-window":
      await generateBookBatchWindow({
        projectId,
        planId,
        input,
        plan,
        providers,
        strategy,
        generationJobId
      });
      return {};
    case "draft-then-polish":
      await generateBookDraftThenPolish({
        projectId,
        planId,
        input,
        plan,
        providers,
        strategy,
        generationJobId
      });
      return {};
    case "sequential-pages":
      await generateBookSequential({
        projectId,
        planId,
        input,
        plan,
        providers,
        strategy,
        generationJobId
      });
      return {};
    default:
      assertNeverExecutionMode(strategy.executionMode);
  }
}

/**
 * The replan this GENERATE_BOOK delivery is the staged successor of, or null
 * when it is not one.
 *
 * `processJob` asks this before it replays an already-COMPLETED row, because
 * that question and the fork below have to be the same one. The replay gate
 * keyed on `replanOperationId` alone, so a redelivered *pre-staging* successor
 * — which answers null here and is regenerated through the ordinary book path
 * — re-entered the execution-mode switch with its durable row already
 * COMPLETED, and every arm of that switch deletes the project's pages,
 * chapters, illustrations, continuity notes and page embeddings before it
 * rewrites the book. The redelivery is not hypothetical: `generate-book` has a
 * BullMQ attempt budget, and a tail failure is rethrown to spend it.
 */
export async function stagedReplanSuccessorOperationId(job: GenerateBookJob): Promise<string | null> {
  const operationId = job.data.replanOperationId;
  if (!operationId) return null;
  return (await stagedReplanSuccessor(operationId)) ? operationId : null;
}

/**
 * Whether the staged-replan pipeline is what queued this successor — and so
 * whether `generateReplannedBook` owns the delivery at all.
 *
 * `replanBook.ts` stamps `classifier.replanStagedPlanId` before it creates the
 * GENERATE_BOOK row, so every successor the current build produces carries it;
 * `stagedReplanJobGuard.ts` reads the same stamp to decide whether it has
 * anything to prove, and correctly answers `unstaged` — no opinion — for a row
 * that has none. A successor queued by the *pre-staging* build carries none of
 * it: that build published the revised plan itself, set the project GENERATING,
 * left this job to regenerate the book through the execution-mode switch below,
 * and then marked the operation APPLIED. Sent into `generateReplannedBook`
 * instead, it claims the lease, reads `phase: "tail"` off that APPLIED row,
 * finds no publication identity to replay and throws
 * `UnownedReplanDeliveryError` — which `processJob` converts to an
 * `UnrecoverableError` *without* settling anything, leaving the durable job
 * ACTIVE and the project GENERATING for good, on a book the reader has paid
 * for. A rolling deploy has to answer an in-flight legacy successor the way the
 * build that queued it would have, which is the ordinary path.
 *
 * An operation row that is *missing* is not that: it still takes the fork,
 * whose own "Book edit operation not found" failure settles and refunds.
 */
async function stagedReplanSuccessor(operationId: string): Promise<boolean> {
  const operation = await prisma.bookEditOperation.findUnique({
    where: { id: operationId },
    select: { classifier: true }
  });
  if (!operation) return true;
  const stagedPlanId = jsonPayloadToRecord(operation.classifier).replanStagedPlanId;
  if (typeof stagedPlanId === "string" && stagedPlanId.trim()) return true;
  console.warn("Regenerating a pre-staging replan successor through the ordinary book path", {
    event: "generation.legacy_replan_successor",
    operationId
  });
  return false;
}

/**
 * Chapter research expansion for a replan, run against the manuscript it just
 * published.
 *
 * Not the ordinary pre-drafting call below: a replan's publication transaction
 * replaces every `ResearchSource` row with the revised plan's own notes, so
 * rows written before it are deleted by it, and the guard inside
 * `maybeExpandStrategyResearch` would skip the call anyway — the live project
 * still holds the *old* plan's sources at that point, and a stored query the
 * revised plan does not name reads as "an earlier expansion already ran".
 * After the publication the project's corpus is exactly the plan's notes, which
 * is the state that guard is written for, so the expansion runs and the
 * replanned book keeps a research corpus rather than shrinking to the plan.
 *
 * Best-effort: the manuscript is published, settled and paid for by the time
 * this runs, so a research outage must not reopen it. The rows and their
 * embeddings are read by later edits, continuations and exports, all of which
 * ask again.
 */
async function expandPublishedReplanResearch(options: {
  projectId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  generationJobId?: string | undefined;
}): Promise<void> {
  try {
    await maybeExpandStrategyResearch(options);
  } catch (error) {
    console.warn("Replan research expansion skipped for a published book", {
      event: "generation.replan_research_expansion_failed",
      projectId: options.projectId,
      error
    });
  }
}

export function assertNeverExecutionMode(mode: never): never {
  throw new Error(`Unhandled book generation execution mode: ${String(mode)}`);
}

export async function generateBookSequential(options: {
  projectId: string;
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  generationJobId?: string | undefined;
}) {
  if (await canResumeSequentialBook(options.projectId, options.plan, options.input)) {
    await advanceJobStep(options.generationJobId, "setup", 65, "Resuming with existing completed pages");
    await prisma.$transaction(async (tx) => {
      await tx.page.updateMany({
        where: { projectId: options.projectId, status: { in: ["GENERATING", "FAILED_QA"] } },
        data: { status: "PENDING" }
      });
      await tx.project.update({ where: { id: options.projectId }, data: { status: "GENERATING" } });
    });
  } else {
    const chapterSetups = await prepareChapterSetups(options);
    await advanceJobStep(options.generationJobId, "setup", 65);

    await prisma.$transaction(async (tx) => {
      await tx.imageAsset.deleteMany({ where: { projectId: options.projectId } });
      await tx.page.deleteMany({ where: { projectId: options.projectId } });
      await tx.chapter.deleteMany({ where: { projectId: options.projectId } });
      await tx.continuityNote.deleteMany({ where: { projectId: options.projectId } });
      await tx.embedding.deleteMany({ where: { projectId: options.projectId, scope: { startsWith: PAGE_SCOPE_PREFIX } } });
      await tx.project.update({
        where: { id: options.projectId },
        data: {
          status: "GENERATING",
          storyState: seedStoryStateFromPromises(options.plan.promises ?? []) as Prisma.InputJsonValue
        }
      });

      for (const setup of chapterSetups) {
        const chapter = await tx.chapter.create({
          data: {
            projectId: options.projectId,
            index: setup.chapter.index,
            title: setup.chapter.title,
            summary: setup.chapter.summary,
            targetPages: setup.chapter.targetPages,
            productionBrief: setup.brief as Prisma.InputJsonValue
          }
        });

        for (let pageIndex = setup.startPage; pageIndex <= setup.endPage; pageIndex += 1) {
          await tx.page.create({
            data: {
              projectId: options.projectId,
              chapterId: chapter.id,
              index: pageIndex,
              title: `Page ${pageIndex}`,
              markdown: "",
              summary: "",
              status: "PENDING"
            }
          });
        }
      }
    });
  }

  await ensureCharacterReferenceAssets({
    projectId: options.projectId,
    planId: options.planId,
    input: options.input,
    plan: options.plan,
    providers: options.providers,
    strategy: options.strategy,
    generationJobId: options.generationJobId
  });
  await maybeEnqueueCover(options.projectId, options.planId, options.input);
  const waveSize = parallelPageWaveSize(options.input);
  const pagesToStart = await prisma.page.findMany({
    where: { projectId: options.projectId, status: "PENDING" },
    orderBy: { index: "asc" },
    take: waveSize
  });
  if (pagesToStart.length > 0) {
    await advanceJobStep(
      options.generationJobId,
      "enqueue",
      85,
      waveSize > 1 ? `Starting ${pagesToStart.length} pages in parallel` : undefined
    );
    for (const pageToStart of pagesToStart) {
      await enqueueWorkerJob({
        projectId: options.projectId,
        type: "GENERATE_PAGE",
        payload: { pageId: pageToStart.id, planId: options.planId },
        dedupeKey: `generate-page:${pageToStart.id}:${options.planId}`
      });
    }
  } else {
    await maybeEnqueueCompile(options.projectId, options.planId);
  }
}

/**
 * A sequential GENERATE_BOOK re-run keeps completed pages when the existing
 * chapter/page structure still matches the approved plan, so resuming after a
 * failure does not discard finished work.
 */
export async function canResumeSequentialBook(projectId: string, plan: BookPlan, input: CreateProjectInput): Promise<boolean> {
  const [chapters, pages] = await Promise.all([
    prisma.chapter.findMany({ where: { projectId }, orderBy: { index: "asc" }, select: { index: true, title: true, targetPages: true } }),
    prisma.page.findMany({ where: { projectId }, orderBy: { index: "asc" }, select: { index: true, status: true } })
  ]);
  if (pages.length !== input.targetPages) {
    return false;
  }
  if (pages.some((page, position) => page.index !== position + 1)) {
    return false;
  }
  if (chapters.length !== plan.chapters.length) {
    return false;
  }
  const structureMatches = plan.chapters.every((chapterPlan) => {
    const stored = chapters.find((chapter) => chapter.index === chapterPlan.index);
    return stored !== undefined && stored.targetPages === chapterPlan.targetPages && stored.title === chapterPlan.title;
  });
  if (!structureMatches) {
    return false;
  }
  return pages.some((page) => page.status === "COMPLETED");
}

export async function maybeExpandStrategyResearch(options: {
  projectId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  generationJobId?: string | undefined;
}) {
  const cap = options.strategy.researchDepth ?? 0;
  if (cap <= 0) {
    return;
  }

  // Existing-rows guard, mirroring embedResearchSourcesForProject: a resumed
  // or redelivered GENERATE_BOOK re-runs this expansion, and a bare createMany
  // doubled the book's Sources list forever (the compile rebuilds it from
  // these rows on every export). Expansion sources are keyed by the queries
  // they were searched for, and those queries are derived from the plan — so a
  // stored row whose query is not one of the plan's own research notes can
  // only have been written by a previous run of this expansion. Skip the
  // provider calls entirely then, and dedupe by query on the way in otherwise.
  const existingSources = await prisma.researchSource.findMany({
    where: { projectId: options.projectId },
    select: { query: true }
  });
  const existingQueries = new Set(existingSources.map((source) => source.query));
  const planNoteQueries = new Set(options.plan.researchNotes.map((note) => note.query));
  if ([...existingQueries].some((query) => !planNoteQueries.has(query))) {
    return;
  }

  await updateJobProgress(options.generationJobId, {
    progress: 15,
    message: "Expanding chapter research"
  });
  const sources = await expandChapterResearch({
    input: options.input,
    plan: options.plan,
    research: options.providers.research,
    cap
  });
  if (sources.length === 0) {
    return;
  }

  const freshSources = sources.filter((source) => !existingQueries.has(source.query));
  if (freshSources.length > 0) {
    await prisma.researchSource.createMany({
      data: freshSources.map((source) => ({
        projectId: options.projectId,
        query: source.query,
        title: source.title,
        url: source.url ?? null,
        summary: source.summary,
        publishedAt: source.publishedAt ? new Date(source.publishedAt) : null
      }))
    });
  }
  // Research embeddings feed the semantic branch of page-context loading,
  // which only sequential-pages jobs use.
  if (strategyUsesSemanticMemory(options.strategy)) {
    await embedResearchSourcesForProject(options.projectId, options.providers.embedding);
  }
}
