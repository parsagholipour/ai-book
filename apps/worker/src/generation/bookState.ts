import { directGenerationResumeState, type DirectResumeState } from "./directGenerationResume.js";
import { chapterSetupsForPlan, normalizedChapters, planInputSnapshot } from "./bookHelpers.js";
import { chapterSetupForPage } from "./generationContext.js";
import { enforceProductionMapIntegrity } from "./productionMapIntegrity.js";
import { applyPlanThinkingBoost, loadQualityContext } from "./qualitySettings.js";
import { advanceJobStep, updateJobProgress } from "../runtime/jobLifecycle.js";
import { type ChapterSetup } from "../runtime/jobTypes.js";
import { jsonInputValue } from "../runtime/serialization.js";
import {
  chapterBriefSchema,
  compactPictureBookPlanForBriefs,
  inputWithSelectedPageCount,
  mapWithConcurrency,
  normalizePlanPageTargets,
  range,
  type BookGenerationStrategy,
  type BookPlan,
  type ChapterBrief,
  type CreateProjectInput,
  type PriorPageContext,
  type ProviderSet,
  type QualityFeatureId,
  type WholeBookDraft,
  type WholeBookPageDraft,
  seedStoryStateFromPromises
} from "@book-maker/core";
import { Prisma, prisma, PAGE_SCOPE_PREFIX } from "@book-maker/db";

/**
 * Persistent book-generation state shared by the direct passes: chapter setup,
 * the reset/checkpoint transactions, and resume-context loading. Serves both
 * the generate-book handler and the passes in bookPasses.ts, which is why it
 * lives in generation/ rather than under handlers/.
 */

/**
 * One quality snapshot, taken by whichever gate asks for it first and by
 * nothing else.
 *
 * `prepareChapterSetups` has two shapes and one remaining quality gate, plan
 * thinking boost (the page-map critic went on 2026-10-16). Production-map
 * integrity is mandatory and not a gate. The read behind the gates is a
 * `generationQualityRevision` row — cheap, indexed, and taken once per
 * `GENERATE_BOOK`. It was hoisted to the top of the function when `beatDedup`
 * gave the per-chapter fan-out a gate of its own, which is how the whole
 * function came to pay for a read before any gate had said it would be
 * consulted: the per-chapter path, which had never made this read at all,
 * now made it *ahead of* every one of its chapter-brief model calls, and the
 * page-map path made it ahead of the progress line announcing itself.
 *
 * A thunk puts the cost back where it is spent. It is the shape
 * `unpaidPromiseQualityIssues` takes for the same reason
 * (`handlers/compileExportStandDown.ts`): the gate is the first thing asked,
 * and what sits behind it is not evaluated until the gate says it will be read.
 * The difference is only in what the deferral is worth — this one is a single
 * indexed row rather than a zod parse per page — which is why the promise is
 * memoized rather than the whole context being re-read per gate: two gates on
 * one path must not be able to disagree about a settings revision an operator
 * saved between them, and the failure of the read still fails the pass exactly
 * as it did when it was unconditional. Deferred, not made best-effort.
 */
function lazyQualityGate(input: CreateProjectInput): (feature: QualityFeatureId) => Promise<boolean> {
  let context: ReturnType<typeof loadQualityContext> | undefined;
  return async (feature) => {
    context ??= loadQualityContext(input);
    return (await context).enabled(feature);
  };
}

export async function prepareChapterSetups(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  generationJobId?: string | undefined;
}): Promise<ChapterSetup[]> {
  let chapterRanges = chapterSetupsForPlan(options.plan, options.input.targetPages);
  const quality = lazyQualityGate(options.input);
  const createChapterBriefs = options.strategy.createChapterBriefs;
  if (createChapterBriefs) {
    await advanceJobStep(options.generationJobId, "briefs", 25, "Creating global page map", { phase: "briefs" });
    applyPlanThinkingBoost(options.providers.text, await quality("planThinkingBoost"));
    const briefs = await createChapterBriefs({
      input: options.input,
      plan: options.plan,
      textModel: options.providers.text
    });
    const mappedPlan = compactPictureBookPlanForBriefs(options.input, options.plan, briefs);
    const mappedInput = mappedPlan === options.plan ? options.input : inputWithSelectedPageCount(options.input,
      mappedPlan.chapters.reduce((sum, chapter) => sum + chapter.targetPages, 0));
    chapterRanges = chapterSetupsForPlan(mappedPlan, mappedInput.targetPages);
    const integrity = {
      input: mappedInput,
      plan: mappedPlan,
      textModel: options.providers.text,
      strategy: options.strategy,
      chapterRanges,
      generationJobId: options.generationJobId,
      quality
    };
    // No critic rewrites the map before drafting since 2026-10-16 (E5: blind
    // readers preferred the short book drafted from the critic's patched map
    // 5 / 7 / 6 against the map it was handed); integrity is the map's last pass.
    const mapped = await enforceProductionMapIntegrity({ ...integrity, briefs });
    return chapterRanges.map((setup) => ({
      ...setup,
      brief: requireBriefForChapter(mapped, setup)
    }));
  }

  // Each chapter's brief depends only on the plan and that chapter, so a
  // small pool replaces one model latency per chapter in series. Progress
  // reports the brief being *started*; order can interleave, the results
  // cannot — mapWithConcurrency preserves positions.
  const briefs = await mapWithConcurrency(chapterRanges, 3, async (setup, chapterIndex) => {
    await advanceJobStep(
      options.generationJobId,
      "briefs",
      15 + Math.round((chapterIndex / Math.max(chapterRanges.length, 1)) * 40),
      `Chapter brief ${chapterIndex + 1}/${chapterRanges.length}`,
      { phase: "briefs", chapterIndex: setup.chapter.index, total: chapterRanges.length }
    );
    return options.strategy.generateChapterBrief({
      input: options.input,
      plan: options.plan,
      chapter: setup.chapter,
      chapterPageStart: setup.startPage,
      chapterPageEnd: setup.endPage,
      textModel: options.providers.text
    });
  });
  // Integrity is mandatory: each chapter's brief is written with no sight of
  // the others, so a collision across chapters has never been seen beside its
  // twin by anything. The critic stays off this path.
  const mapped = await enforceProductionMapIntegrity({
    briefs,
    input: options.input,
    plan: options.plan,
    textModel: options.providers.text,
    strategy: options.strategy,
    chapterRanges,
    generationJobId: options.generationJobId,
    quality
  });
  return chapterRanges.map((setup) => ({
    ...setup,
    brief: requireBriefForChapter(mapped, setup)
  }));
}

export function requireBriefForChapter(briefs: ChapterBrief[], setup: ChapterSetup): ChapterBrief {
  const brief = briefs.find((candidate) => candidate.chapterIndex === setup.chapter.index);
  if (!brief) {
    throw new Error(`Page map missing chapter ${setup.chapter.index}.`);
  }
  const expectedPages = range(setup.startPage, setup.endPage);
  const actualPages = brief.pages.map((page) => page.pageIndex);
  if (actualPages.length !== expectedPages.length || actualPages.some((pageIndex, index) => pageIndex !== expectedPages[index])) {
    throw new Error(
      `Page map for chapter ${setup.chapter.index} must contain pages ${expectedPages.join(", ")} in order. Received ${actualPages.join(", ")}.`
    );
  }
  return brief;
}

export async function resetBookForDirectGeneration(
  projectId: string,
  chapterSetups: ChapterSetup[],
  promises: readonly string[] = []
): Promise<Map<number, string>> {
  return prisma.$transaction(async (tx) => {
    await tx.imageAsset.deleteMany({ where: { projectId } });
    await tx.page.deleteMany({ where: { projectId } });
    await tx.chapter.deleteMany({ where: { projectId } });
    await tx.continuityNote.deleteMany({ where: { projectId } });
    await tx.embedding.deleteMany({ where: { projectId, scope: { startsWith: PAGE_SCOPE_PREFIX } } });
    await tx.project.update({
      where: { id: projectId },
      data: {
        status: "GENERATING",
        storyState: seedStoryStateFromPromises(promises) as Prisma.InputJsonValue
      }
    });

    const chapterIds = new Map<number, string>();
    for (const setup of chapterSetups) {
      const chapter = await tx.chapter.create({
        data: {
          projectId,
          index: setup.chapter.index,
          title: setup.chapter.title,
          summary: setup.chapter.summary,
          targetPages: setup.chapter.targetPages,
          ...(setup.brief ? { productionBrief: setup.brief as Prisma.InputJsonValue } : {})
        }
      });
      chapterIds.set(setup.chapter.index, chapter.id);
    }
    return chapterIds;
  });
}

export type StoredResumeChapter = {
  id: string;
  index: number;
  title: string;
  targetPages: number;
  brief: ChapterBrief | undefined;
};

export type StoredResumePage = {
  index: number;
  status: string;
  title: string;
  markdown: string;
  summary: string;
  imagePrompt: string | null;
};

export type DirectResumeContext = {
  chapters: StoredResumeChapter[];
  pages: StoredResumePage[];
};

export async function loadDirectResumeContext(projectId: string): Promise<DirectResumeContext> {
  const [chapters, pages] = await Promise.all([
    prisma.chapter.findMany({
      where: { projectId },
      orderBy: { index: "asc" },
      select: { id: true, index: true, title: true, targetPages: true, productionBrief: true }
    }),
    prisma.page.findMany({
      where: { projectId },
      orderBy: { index: "asc" },
      select: { index: true, status: true, title: true, markdown: true, summary: true, imagePrompt: true }
    })
  ]);
  return {
    chapters: chapters.map((chapter) => {
      const parsed = chapter.productionBrief === null ? null : chapterBriefSchema.safeParse(chapter.productionBrief);
      return {
        id: chapter.id,
        index: chapter.index,
        title: chapter.title,
        targetPages: chapter.targetPages,
        brief: parsed?.success ? parsed.data : undefined
      };
    }),
    pages
  };
}

export function directResumeStateForContext(options: {
  targetPages: number;
  plan: BookPlan;
  context: DirectResumeContext;
  requiresBriefs: boolean;
  requireAllPagesPresent: boolean;
}): DirectResumeState {
  return directGenerationResumeState({
    targetPages: options.targetPages,
    planChapters: normalizedChapters(options.plan, options.targetPages).map((chapter) => ({
      index: chapter.index,
      title: chapter.title,
      targetPages: chapter.targetPages
    })),
    storedChapters: options.context.chapters.map((chapter) => ({
      index: chapter.index,
      title: chapter.title,
      targetPages: chapter.targetPages,
      hasBrief: chapter.brief !== undefined
    })),
    storedPages: options.context.pages.map((page) => ({ index: page.index, status: page.status })),
    requiresBriefs: options.requiresBriefs,
    requireAllPagesPresent: options.requireAllPagesPresent
  });
}

/**
 * Rebuilds chapter setups from the rows a previous run persisted so a resumed
 * job skips prepareChapterSetups (and its brief-generation model calls). Only
 * valid when directGenerationResumeState already confirmed the stored
 * structure matches the plan.
 */
export function rebuildChapterSetupsFromStored(
  plan: BookPlan,
  targetPages: number,
  storedChapters: StoredResumeChapter[]
): { chapterSetups: ChapterSetup[]; chapterIds: Map<number, string> } {
  const byIndex = new Map(storedChapters.map((chapter) => [chapter.index, chapter]));
  const chapterIds = new Map<number, string>();
  const chapterSetups = chapterSetupsForPlan(plan, targetPages).map((setup) => {
    const stored = byIndex.get(setup.chapter.index);
    if (stored) {
      chapterIds.set(setup.chapter.index, stored.id);
    }
    return { ...setup, brief: stored?.brief };
  });
  return { chapterSetups, chapterIds };
}

/** Settled pages before the resume point, as generation context for the remaining pages. */
export function priorPageContextsFromStored(pages: StoredResumePage[], beforeIndex: number): PriorPageContext[] {
  return pages
    .filter((page) => page.index < beforeIndex && (page.status === "COMPLETED" || page.status === "FAILED_QA"))
    .sort((a, b) => a.index - b.index)
    .map((page) => ({ index: page.index, title: page.title, markdown: page.markdown, summary: page.summary }));
}

/**
 * Persists an accepted whole-book draft as PENDING page rows before polishing
 * begins, so a failure during the polish loop can resume without repeating the
 * whole-book draft call — the most expensive step of draft-then-polish. The
 * polish loop's upsert flips each row to COMPLETED/FAILED_QA in place.
 */
export async function checkpointWholeBookDraftPages(options: {
  projectId: string;
  chapterSetups: ChapterSetup[];
  chapterIds: Map<number, string>;
  pages: WholeBookPageDraft[];
}): Promise<void> {
  await prisma.page.createMany({
    data: options.pages.map((page) => {
      const setup = chapterSetupForPage(options.chapterSetups, page.index);
      return {
        projectId: options.projectId,
        chapterId: setup ? options.chapterIds.get(setup.chapter.index) ?? null : null,
        index: page.index,
        title: page.title,
        markdown: page.markdown,
        summary: page.summary,
        imagePrompt: page.imagePrompt ?? null,
        status: "PENDING" as const
      };
    })
  });
}

export function effectiveWholeBookDraftContext(
  input: CreateProjectInput,
  plan: BookPlan,
  draft: WholeBookDraft,
  exactTargetChapterSetups?: ChapterSetup[]
): { input: CreateProjectInput; plan: BookPlan; chapterSetups: ChapterSetup[] } {
  const acceptedPages = draft.pages.length;
  const targetPages = acceptedPages;
  const inputForAcceptedPages = inputWithSelectedPageCount(input, targetPages);
  const planMatches = plan.chapters.reduce((sum, chapter) => sum + chapter.targetPages, 0) === targetPages;
  const planForAcceptedPages = planMatches ? plan : normalizePlanPageTargets(plan, targetPages);
  const canReuseExactSetups =
    planMatches && draft.pageSetDiagnostics?.renumbered !== true && exactTargetChapterSetups !== undefined;

  return {
    input: inputForAcceptedPages,
    plan: planForAcceptedPages,
    chapterSetups: canReuseExactSetups ? exactTargetChapterSetups : chapterSetupsForPlan(planForAcceptedPages, targetPages)
  };
}

export async function reportAcceptedWholeBookDraft(
  generationJobId: string | undefined,
  draft: WholeBookDraft
): Promise<string | undefined> {
  const message = wholeBookDraftAcceptanceMessage(draft);
  if (!message) {
    return undefined;
  }
  await updateJobProgress(generationJobId, { message });
  return message;
}

export function wholeBookDraftAcceptanceMessage(draft: WholeBookDraft): string | undefined {
  const diagnostics = draft.pageSetDiagnostics;
  if (!diagnostics) {
    return undefined;
  }
  const noteworthy =
    diagnostics.acceptedPages !== diagnostics.requestedPages ||
    diagnostics.renumbered ||
    diagnostics.missingIndexes.length > 0 ||
    diagnostics.unexpectedIndexes.length > 0 ||
    diagnostics.duplicateIndexes.length > 0;
  if (!noteworthy) {
    return undefined;
  }

  const details = [
    diagnostics.missingIndexes.length ? `missing ${diagnostics.missingIndexes.join(", ")}` : "",
    diagnostics.unexpectedIndexes.length ? `unexpected ${diagnostics.unexpectedIndexes.join(", ")}` : "",
    diagnostics.duplicateIndexes.length ? `duplicate ${diagnostics.duplicateIndexes.join(", ")}` : ""
  ].filter(Boolean);
  const suffix = details.length > 0 ? ` (${details.join("; ")})` : "";
  return `Accepted ${diagnostics.acceptedPages} generated pages for a ${diagnostics.requestedPages}-page target${suffix}.`;
}

export async function persistAcceptedWholeBookTarget(options: {
  projectId: string;
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  draft: WholeBookDraft;
  chapterAllocationChanged?: boolean;
  originalTargetPages?: number;
}): Promise<void> {
  const diagnostics = options.draft.pageSetDiagnostics;
  const targetChanged = options.draft.pages.length !== (options.originalTargetPages ?? diagnostics?.requestedPages ?? options.input.targetPages);
  if (!targetChanged && !options.chapterAllocationChanged && !options.input.mediaSettings.generationPageCount) {
    return;
  }

  await prisma.$transaction([
    ...(targetChanged ? [prisma.project.update({
      where: { id: options.projectId },
      data: { targetPages: options.draft.pages.length }
    })] : []),
    prisma.planVersion.update({
      where: { id: options.planId },
      data: {
        inputSnapshot: planInputSnapshot(options.input),
        planningPackage: jsonInputValue(options.plan)
      }
    })
  ]);
}
