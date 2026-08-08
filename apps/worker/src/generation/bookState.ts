import { directGenerationResumeState, type DirectResumeState } from "./directGenerationResume.js";
import { chapterSetupsForPlan, normalizedChapters, planInputSnapshot } from "./bookHelpers.js";
import { chapterSetupForPage } from "./generationContext.js";
import { updateJobProgress } from "../runtime/jobLifecycle.js";
import { type ChapterSetup } from "../runtime/jobTypes.js";
import { jsonInputValue, range } from "../runtime/serialization.js";
import {
  chapterBriefSchema,
  normalizePlanPageTargets,
  type BookGenerationStrategy,
  type BookPlan,
  type ChapterBrief,
  type CreateProjectInput,
  type PriorPageContext,
  type ProviderSet,
  type WholeBookDraft,
  type WholeBookPageDraft
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";

/**
 * Persistent book-generation state shared by the direct passes: chapter setup,
 * the reset/checkpoint transactions, and resume-context loading. Serves both
 * the generate-book handler and the passes in bookPasses.ts, which is why it
 * lives in generation/ rather than under handlers/.
 */

export async function prepareChapterSetups(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  generationJobId?: string | undefined;
}): Promise<ChapterSetup[]> {
  const chapterRanges = chapterSetupsForPlan(options.plan, options.input.targetPages);
  const createChapterBriefs = options.strategy.createChapterBriefs;
  if (createChapterBriefs) {
    await updateJobProgress(options.generationJobId, {
      progress: 25,
      message: "Creating global page map"
    });
    const briefs = await createChapterBriefs({
      input: options.input,
      plan: options.plan,
      textModel: options.providers.text
    });
    return chapterRanges.map((setup) => ({
      ...setup,
      brief: requireBriefForChapter(briefs, setup)
    }));
  }

  const chapterSetups: ChapterSetup[] = [];
  for (const [chapterIndex, setup] of chapterRanges.entries()) {
    await updateJobProgress(options.generationJobId, {
      progress: 15 + Math.round((chapterIndex / Math.max(chapterRanges.length, 1)) * 40),
      message: `Chapter brief ${chapterIndex + 1}/${chapterRanges.length}`
    });
    const brief = await options.strategy.generateChapterBrief({
      input: options.input,
      plan: options.plan,
      chapter: setup.chapter,
      chapterPageStart: setup.startPage,
      chapterPageEnd: setup.endPage,
      textModel: options.providers.text
    });
    chapterSetups.push({ ...setup, brief });
  }
  return chapterSetups;
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

export async function resetBookForDirectGeneration(projectId: string, chapterSetups: ChapterSetup[]): Promise<Map<number, string>> {
  return prisma.$transaction(async (tx) => {
    await tx.imageAsset.deleteMany({ where: { projectId } });
    await tx.page.deleteMany({ where: { projectId } });
    await tx.chapter.deleteMany({ where: { projectId } });
    await tx.continuityNote.deleteMany({ where: { projectId } });
    await tx.embedding.deleteMany({ where: { projectId, scope: { startsWith: "page:" } } });
    await tx.project.update({ where: { id: projectId }, data: { status: "GENERATING" } });

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
  const acceptedPages = draft.pageSetDiagnostics?.acceptedPages ?? draft.pages.length;
  const targetPages = Math.max(1, acceptedPages);
  const targetChanged = targetPages !== input.targetPages;
  const inputForAcceptedPages = targetChanged ? { ...input, targetPages } : input;
  const planForAcceptedPages = targetChanged ? normalizePlanPageTargets(plan, targetPages) : plan;
  const canReuseExactSetups =
    !targetChanged && draft.pageSetDiagnostics?.renumbered !== true && exactTargetChapterSetups !== undefined;

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
}): Promise<void> {
  const diagnostics = options.draft.pageSetDiagnostics;
  if (!diagnostics || diagnostics.acceptedPages === diagnostics.requestedPages) {
    return;
  }

  await prisma.$transaction([
    prisma.project.update({
      where: { id: options.projectId },
      data: { targetPages: diagnostics.acceptedPages }
    }),
    prisma.planVersion.update({
      where: { id: options.planId },
      data: {
        inputSnapshot: planInputSnapshot(options.input),
        planningPackage: jsonInputValue(options.plan)
      }
    })
  ]);
}
