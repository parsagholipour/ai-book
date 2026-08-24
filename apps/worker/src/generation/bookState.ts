import { bestEffortPass } from "./bestEffortPass.js";
import { directGenerationResumeState, type DirectResumeState } from "./directGenerationResume.js";
import { chapterSetupsForPlan, normalizedChapters, planInputSnapshot } from "./bookHelpers.js";
import { chapterSetupForPage } from "./generationContext.js";
import { applyPlanThinkingBoost, loadQualityContext } from "./qualitySettings.js";
import { updateJobProgress } from "../runtime/jobLifecycle.js";
import { type ChapterSetup } from "../runtime/jobTypes.js";
import { jsonInputValue, range } from "../runtime/serialization.js";
import {
  beatDedupPatch,
  chapterBriefSchema,
  critiquePageMap,
  dedupePageBeats,
  findDuplicatePageBeats,
  mapWithConcurrency,
  mergePageMapCriticPatch,
  normalizePlanPageTargets,
  type BookGenerationStrategy,
  type BookPlan,
  type ChapterBrief,
  type CreateProjectInput,
  type DuplicateBeatFinding,
  type PageMapCriticPatch,
  type PriorPageContext,
  type ProviderSet,
  type QualityFeatureId,
  type TextModelAdapter,
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
 * `prepareChapterSetups` has two shapes and three gates spread across them, and
 * the read behind them is a `generationQualityRevision` row — cheap, indexed,
 * and taken once per `GENERATE_BOOK`. It was hoisted to the top of the function
 * when `beatDedup` gave the per-chapter fan-out a gate of its own, which is how
 * the whole function came to pay for a read before any gate had said it would
 * be consulted: the per-chapter path, which had never made this read at all,
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
  const chapterRanges = chapterSetupsForPlan(options.plan, options.input.targetPages);
  const quality = lazyQualityGate(options.input);
  const createChapterBriefs = options.strategy.createChapterBriefs;
  if (createChapterBriefs) {
    await updateJobProgress(options.generationJobId, {
      progress: 25,
      message: "Creating global page map"
    });
    applyPlanThinkingBoost(options.providers.text, await quality("planThinkingBoost"));
    const briefs = await createChapterBriefs({
      input: options.input,
      plan: options.plan,
      textModel: options.providers.text
    });
    let mapped = briefs;
    if (await quality("pageMapCritic")) {
      mapped = await bestEffortPass({
        attempt: async () => {
          // Both halves of the critic rank page 1 against the book's last page,
          // and the book's is `targetPages`: pages are numbered 1..targetPages,
          // which is what `chapterRanges` above partitions. It is passed rather
          // than left to be read off `briefs`, because a map that came back short
          // is exactly the failure `requireBriefForChapter` below and the brief
          // repair loop exist for — and its highest page is then a middle page
          // that would be told to resolve the book's central promise. The merge
          // takes that number; the critic takes the book it came off, because the
          // prompt half also has to ask whether this book's opening is ours to
          // commit at all.
          const lastPageIndex = options.input.targetPages;
          // Nothing about page 1's contract is decided here. This handler used to
          // pass `plan.openingHook` through as a string, which made it the one
          // place the imported-manuscript exemption had to be spelled a second
          // time — and it was not, so an imported book that had been replanned
          // once briefed its page 1 to deliver a hook a plan revision invented
          // without ever reading it. `input` and `plan` go over whole and
          // `openingContractForRange` (`packages/core`) answers it there, beside
          // the rule it gates.
          const patch = await critiquePageMap({
            textModel: options.providers.text,
            input: options.input,
            plan: options.plan,
            briefs,
            promises: options.plan.promises ?? []
          });
          return mergePageMapCriticPatch(briefs, patch, lastPageIndex);
        },
        fallback: briefs,
        warning: "Page-map critic skipped for plan"
      });
    }
    if (await quality("beatDedup")) {
      mapped = await dedupeBriefBeats({
        briefs: mapped,
        input: options.input,
        plan: options.plan,
        textModel: options.providers.text,
        generationJobId: options.generationJobId
      });
    }
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
    await updateJobProgress(options.generationJobId, {
      progress: 15 + Math.round((chapterIndex / Math.max(chapterRanges.length, 1)) * 40),
      message: `Chapter brief ${chapterIndex + 1}/${chapterRanges.length}`
    });
    return options.strategy.generateChapterBrief({
      input: options.input,
      plan: options.plan,
      chapter: setup.chapter,
      chapterPageStart: setup.startPage,
      chapterPageEnd: setup.endPage,
      textModel: options.providers.text
    });
  });
  // The dedup matters most on this path: each chapter's brief is written with
  // no sight of the others (three at a time, concurrently), so a beat repeated
  // across chapters has never been seen beside its twin by anything.
  const deduped = (await quality("beatDedup"))
    ? await dedupeBriefBeats({
        briefs,
        input: options.input,
        plan: options.plan,
        textModel: options.providers.text,
        generationJobId: options.generationJobId
      })
    : briefs;
  return chapterRanges.map((setup, index) => ({ ...setup, brief: deduped[index]! }));
}

/**
 * Planner-side beat dedup (`packages/core/src/generation/pageBeatDedup.ts`):
 * deterministic detection over the finished map, one bounded rewrite call only
 * when collisions were found, and — on any model failure — the deterministic
 * distinctness notes alone, so a colliding page never reaches the drafter with
 * nothing said about the collision. A brief-production failure must not fail
 * the book; only a user stop escapes.
 */
async function dedupeBriefBeats(options: {
  briefs: ChapterBrief[];
  input: CreateProjectInput;
  plan: BookPlan;
  textModel: TextModelAdapter;
  generationJobId?: string | undefined;
}): Promise<ChapterBrief[]> {
  const lastPageIndex = options.input.targetPages;
  // Detection is a guarded pass in its own right, because a detector that threw
  // and a rewrite that threw are different failures wanting different fixes, and
  // the run log is where an operator tells them apart: the rewrite's line
  // promises the deterministic distinctness notes, which a map nothing measured
  // has none of. It answers `[]`, which is what a clean map answers too, so the
  // return below is true of both — nothing was found to say, so nothing is said.
  const findings = await bestEffortPass<DuplicateBeatFinding[]>({
    attempt: () => findDuplicatePageBeats(options.briefs),
    fallback: [],
    warning: "Page-beat dedup detection failed; keeping the page map as briefed, with no distinctness notes"
  });
  if (findings.length === 0) {
    return options.briefs;
  }
  // The operator's line, and a guarded pass of its own. It is a Postgres update
  // on a `GenerationJob` row a retention sweep or a queue reconciliation may
  // have retired — a P2025 on a message nobody's book depends on — so it
  // degrades like everything else in this function. What it may not do is
  // degrade *anything else*. It used to be the first statement of the rewrite's
  // `attempt`, which made the cheapest write in the pass the gate on the most
  // expensive one: any blip on that row landed in the rewrite's catch, was
  // logged as "rewrite skipped", and answered `undefined` — so `dedupePageBeats`
  // was never called at all. The model call this pass had already decided to buy
  // went unspent because a progress message could not be written, the book
  // shipped its collisions with the deterministic distinctness notes alone, and
  // the drafter then burned its whole per-page rewrite budget re-executing each
  // one. Nothing reads the result, so there is nothing to hand back on a
  // failure: `void`, the shape the compile-export write uses.
  //
  // **A stop still ends the pass**, and that is why this goes through
  // `bestEffortPass` rather than a bare catch: `updateJobProgress` is also this
  // pass's stop check (`assertJobNotStopped`), and the one error the guard
  // rethrows is exactly that one.
  await bestEffortPass<void>({
    attempt: () =>
      updateJobProgress(options.generationJobId, {
        message: `Rewriting ${findings.length} near-duplicate page beat${findings.length === 1 ? "" : "s"} in the page map`
      }),
    fallback: undefined,
    warning: "Page-beat dedup progress message skipped; the rewrite it announces still runs"
  });
  // The rewrite pass produces the model's patch and nothing else. The merge
  // that turns a patch into briefs is a separate pass below, because a merge
  // inside this one would be answering its own failure by merging again — see
  // there.
  const rewritten = await bestEffortPass<PageMapCriticPatch | undefined>({
    attempt: () =>
      dedupePageBeats({
        textModel: options.textModel,
        briefs: options.briefs,
        findings,
        promises: options.plan.promises ?? [],
        lastPageIndex
      }),
    fallback: undefined,
    warning: "Page-beat dedup rewrite skipped; keeping deterministic distinctness notes"
  });
  // The merge is its own pass, and both patches go through this one call.
  // `mergePageMapCriticPatch` used to be the rewrite try's *last statement*, so
  // a patch the merge choked on — a brief whose pages reached it from a producer
  // that never went through `chapterBriefSchema`, or a field the merge learns to
  // read later — arrived in the catch, whose answer was to call the identical
  // function a second time with the deterministic patch. It threw the same way,
  // this time with nothing behind it, and the failure this pass exists to absorb
  // failed the whole GENERATE_BOOK job. So the deterministic stand-in is built
  // *here*, inside the attempt: it costs nothing when the model answered, and
  // when it is reached it is covered by the same guard as the merge that
  // consumes it, whose fallback is the briefs themselves and cannot fail in its
  // turn. Undeduped beats cost the drafter rewrites it would rather not spend; a
  // thrown merge costs the reader the book.
  return bestEffortPass({
    attempt: () => mergePageMapCriticPatch(options.briefs, rewritten ?? beatDedupPatch(findings), lastPageIndex),
    fallback: options.briefs,
    warning: "Page-beat dedup merge skipped; keeping the page map as briefed"
  });
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
