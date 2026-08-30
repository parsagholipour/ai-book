import {
  parseChapterBrief,
  styleExcerptsForPage,
  toPriorPageContext,
  type strategyForInput
} from "../generation/bookHelpers.js";
import { runBestEffortPageMemoryWrite } from "../generation/bestEffortSavepoint.js";
import { prepareEmbedding, strategyUsesSemanticMemory, writePreparedEmbedding } from "../generation/embeddingWrites.js";
import { loadContinuityNotes, loadResearchNotesForGeneration } from "../generation/generationContext.js";
import { keeperStoryExtractForSave, persistStoryExtract } from "../generation/qualityEnrichment.js";
import { reviewAndSaveGeneratedPage } from "../generation/pageReview.js";
import { revisePageDraftWithRestart } from "../generation/pageRevision.js";
import {
  renewStructuralPageLeaseTx,
  StructuralPageLeaseLostError
} from "../generation/structuralPageLease.js";
import { loadProjectStoryState } from "../generation/storyStateStore.js";
import type { inputForPlanVersion } from "../generation/projectInput.js";
import { loadQualityContext } from "../generation/qualitySettings.js";
import type { createLoggedProviders } from "../providers/loggedAdapters.js";
import { advanceJobStep } from "../runtime/jobLifecycle.js";
import {
  claimDurableEditCompletionTx,
  settleDurableEditAttemptTx,
  type DurableEditCompletionClaim
} from "../runtime/durableEditCompletion.js";
import {
  applyStoryDelta,
  jsonRecord,
  reviewAppliedBookEdit,
  type ChapterBrief,
  type ChapterPlan,
  type EditAdherenceVerdict,
  type PageDraft,
  type PageQualityReport,
  type PriorPageContext
} from "@book-maker/core";
import type { bookPlanSchema } from "@book-maker/core";
import { EDIT_ADHERENCE_FAILED, ReaderEditFailure } from "@book-maker/core/editFailure";
import { PAGE_RESTRUCTURE_TRANSACTION_OPTIONS, pageScope, Prisma, prisma } from "@book-maker/db";

type InsertedPage = {
  id: string;
  index: number;
  chapterId: string | null;
  title: string;
  markdown: string;
  summary: string;
  imagePrompt: string | null;
  status: string;
  revision: number;
  chapter: { index: number; productionBrief: unknown } | null;
};

type CandidateContext = {
  page: InsertedPage;
  chapter?: ChapterPlan | undefined;
  chapterBrief?: ChapterBrief | undefined;
  previousPages: PriorPageContext[];
  nextPages: PriorPageContext[];
  continuityNotes: string[];
  researchNotes: string[];
  styleExcerpts: string[];
};

type InsertedCandidate = CandidateContext & {
  draft: PageDraft;
  qualityReport: PageQualityReport;
};

type AdherenceAudit = {
  verdict: EditAdherenceVerdict;
  attempts: number;
  missingRequirements: string[];
  checkedAt: string;
  proseApproved: boolean;
};

type PreparedInsertedCandidate = InsertedCandidate & {
  preparedEmbedding: Awaited<ReturnType<typeof prepareEmbedding>> | null;
  storyExtract: Awaited<ReturnType<typeof keeperStoryExtractForSave>>;
};

export type DraftedInsertedPages = {
  pageIds: string[];
  pageIndexes: number[];
  candidates: PreparedInsertedCandidate[];
  /** Null only when recovering a legacy split publication, which reviewed nothing here. */
  audit: AdherenceAudit | null;
};

/** Drafts and reviews the inserted page set without publishing manuscript state. */
export async function draftInsertedPages(options: {
  projectId: string;
  operationId: string;
  ownerToken: string;
  planVersionId: string;
  input: ReturnType<typeof inputForPlanVersion>;
  plan: ReturnType<typeof bookPlanSchema.parse>;
  strategy: ReturnType<typeof strategyForInput>;
  providers: ReturnType<typeof createLoggedProviders>;
  insertedPageIds: string[];
  editInstruction: string;
  characterContext?: string | undefined;
  generationJobId?: string | undefined;
  assertLease: () => Promise<void>;
}): Promise<DraftedInsertedPages> {
  const pages = (
    await Promise.all(
      options.insertedPageIds.map((id) =>
        prisma.page
          .findUnique({ where: { id }, include: { chapter: true } })
          .then((page) => (page ? { ...page, id } : null))
      )
    )
  )
    .filter((page): page is NonNullable<typeof page> => page !== null)
    .sort((left, right) => left.index - right.index) as InsertedPage[];
  const missingPageCount = logMissingPages(options, pages);
  if (missingPageCount > 0) {
    throw new Error(
      `Structural insert is missing ${missingPageCount} of ${options.insertedPageIds.length} recorded pages`
    );
  }
  if (pages.length === 0) {
    return { pageIds: [], pageIndexes: [], candidates: [], audit: null };
  }

  const storedAudit = await prisma.bookEditOperation.findUnique({
    where: { id: options.operationId },
    select: { adherenceAudit: true }
  });
  // What the former split publication *wrote*, which is not the same question as
  // what the reviewer approved: it saved every page it drafted, COMPLETED when
  // the quality report approved it and FAILED_QA when it did not, exactly as the
  // publication below still does. Counting only COMPLETED read a finished
  // five-page insert holding one FAILED_QA page — an ordinary terminal outcome —
  // as four of five published, and refused it through the partial door, which
  // rolls the set back and deletes prose the reader already has.
  const publishedPages = pages.filter(
    (page) => page.status === "COMPLETED" || page.status === "FAILED_QA"
  );
  const wholeSetPublished = publishedPages.length === pages.length;
  if (wholeSetPublished && publishedPagesMaySettle(storedAudit?.adherenceAudit)) {
    // Recovery for rows written by the former split publication. The caller
    // still runs the final ACTIVE -> APPLIED transaction, but it must not spend
    // provider calls or overwrite the already-reviewed prose to do so.
    return {
      pageIds: pages.map((page) => page.id),
      pageIndexes: pages.map((page) => page.index),
      candidates: [],
      audit: null
    };
  }
  if (publishedPages.length > 0 && !wholeSetPublished) {
    // The same legacy shape, stopped part way through its page set. Neither
    // half can be delivered: the written half is not redraftable while any of it
    // is COMPLETED, because the publication below claims a page that is *not*
    // COMPLETED and would miss on it, and the unwritten half is not an edit on
    // its own. So the set rolls back whole, exactly as a partly surviving one
    // does — and it says so here rather than after paying for a draft of every
    // page first.
    throw new Error(
      `Structural insert already published ${publishedPages.length} of ${pages.length} recorded pages`
    );
  }

  const candidates = new Map<number, InsertedCandidate>();
  const researchByChapter = new Map<number | null, string[]>();
  const quality = await loadQualityContext(options.input);
  await advanceJobStep(options.generationJobId, "apply", 40, "Writing the new pages", {
    done: 0,
    total: pages.length
  });

  for (const [offset, page] of pages.entries()) {
    await options.assertLease();
    await reportPage(options, page, offset, pages.length);
    const context = await candidateContext(options, page, candidates, researchByChapter, quality);
    const draft = await options.strategy.generatePageDraft({
      input: options.input,
      plan: options.plan,
      ...(context.chapter ? { chapter: context.chapter } : {}),
      ...(context.chapterBrief ? { chapterBrief: context.chapterBrief } : {}),
      pageIndex: page.index,
      editInstruction: options.editInstruction,
      ...(options.characterContext ? { characterContext: options.characterContext } : {}),
      previousSummaries: context.previousPages.map((entry) => entry.summary).slice(-40),
      previousPages: context.previousPages.slice(-6),
      ...(context.nextPages.length ? { nextPages: context.nextPages } : {}),
      continuityNotes: context.continuityNotes,
      researchNotes: context.researchNotes,
      textModel: options.providers.text,
      ...(context.styleExcerpts.length ? { styleExcerpts: context.styleExcerpts } : {})
    });
    candidates.set(page.index, await reviewCandidate(options, context, draft));
  }

  let verdict = await reviewCandidates(options, candidates);
  let attempts = 1;
  let proseApproved = allApproved(candidates);
  while ((!verdict.satisfied || !proseApproved) && attempts < 3) {
    attempts += 1;
    // A verdict the reviewer never reached says nothing about which pages are
    // wrong or what would fix them, so it flags nobody and repairs to nothing;
    // the re-ask at the bottom of this round is the whole of the response. Its
    // one generic "missing requirement" is not a requirement, so redrafting to
    // it spent a revise and a review on every inserted page, twice, and could
    // not have helped. Page QA's own refusals still flag, because those the
    // reviewer did reach.
    const unverified = verdict.basis === "unverified";
    if (unverified) {
      console.warn("Inserted-page adherence review could not be verified; re-asking without redrafting", {
        event: "generation.consistency_warning",
        warning: "structural_insert_adherence_unverified",
        projectId: options.projectId,
        operationId: options.operationId,
        attempt: attempts
      });
    }
    const flagged = new Set(unverified ? [] : verdict.pageIndexesToRevise);
    for (const candidate of candidates.values()) {
      if (!candidate.qualityReport.approved) flagged.add(candidate.page.index);
    }
    if (flagged.size === 0 && !unverified) {
      for (const index of candidates.keys()) flagged.add(index);
    }
    const repairRequirements = unverified ? [] : [...verdict.missingRequirements, ...verdict.contradictions];
    for (const [offset, page] of pages.entries()) {
      const current = candidates.get(page.index);
      if (!current || !flagged.has(page.index)) continue;
      await options.assertLease();
      await reportPage(options, page, offset, pages.length);
      const context = await candidateContext(options, page, candidates, researchByChapter, quality);
      const draft = await revisePageDraftWithRestart({
        strategy: options.strategy,
        generationJobId: options.generationJobId,
        context: `Inserted page ${page.index}`,
        reviseOptions: {
          input: options.input,
          plan: options.plan,
          ...(context.chapter ? { chapter: context.chapter } : {}),
          ...(context.chapterBrief ? { chapterBrief: context.chapterBrief } : {}),
          pageIndex: page.index,
          draft: current.draft,
          report: repairReport(current.qualityReport, repairRequirements),
          editInstruction: options.editInstruction,
          ...(options.characterContext ? { characterContext: options.characterContext } : {}),
          adherenceRepair: repairRequirements,
          previousPages: context.previousPages,
          ...(context.nextPages.length ? { nextPages: context.nextPages } : {}),
          continuityNotes: context.continuityNotes,
          researchNotes: context.researchNotes,
          textModel: options.providers.text,
          ...(context.styleExcerpts.length ? { styleExcerpts: context.styleExcerpts } : {})
        }
      });
      candidates.set(page.index, await reviewCandidate(options, context, draft));
    }
    verdict = await reviewCandidates(options, candidates);
    proseApproved = allApproved(candidates);
  }

  const audit: AdherenceAudit = {
    verdict,
    attempts,
    missingRequirements: verdict.missingRequirements,
    checkedAt: new Date().toISOString(),
    proseApproved
  };
  // Adherence only. An inserted page whose best candidate still fails review is
  // published FAILED_QA, the way every generated page is — the insert stays
  // indivisible on the pages it *has*, and the restructure's own recompile runs
  // full QA, so the repair pass has a target. Folding page QA in here rolled the
  // whole insert back and refunded it over one page the reviewer would not pass.
  //
  // And a verdict the reviewer never *reached* is not a refusal at all: it is
  // the review failing to run, which says nothing about whether the edit landed.
  // Failing on one threw away every drafted and reviewed page, reverted the
  // shift that made room for them and refunded — over a provider blip — when the
  // paragraph above already describes the recoverable route: publish, let page
  // QA's own FAILED_QA stand where it stands, and let the recompile's repair
  // pass have its target. Publishing an unverified insert can be repaired;
  // discarding it is final, and the reader asked for these pages and paid for
  // them. The basis rides the stored audit so nothing downstream reads it as a
  // refusal either — see `publishedPagesMaySettle`.
  if (!verdict.satisfied && verdict.basis !== "unverified") {
    await prisma.$transaction(async (tx) => {
      await requireLease(tx, options.operationId, options.ownerToken);
      await tx.bookEditOperation.update({
        where: { id: options.operationId },
        data: { adherenceAudit: audit as unknown as Prisma.InputJsonValue }
      });
    }, PAGE_RESTRUCTURE_TRANSACTION_OPTIONS);
    throw new ReaderEditFailure(EDIT_ADHERENCE_FAILED);
  }

  const prepared = await prepareCandidatesForPublication(
    options,
    [...candidates.values()],
    quality
  );
  return {
    pageIds: prepared.map((candidate) => candidate.page.id),
    pageIndexes: prepared.map((candidate) => candidate.page.index),
    candidates: prepared,
    audit
  };
}

/**
 * Publishes prose, optional memory, the adherence audit and APPLIED together.
 *
 * Project is the root lock shared with Stop. Once this transaction owns it,
 * Stop either already canceled and cleared the exact lease (so this rolls back
 * without publishing), or waits until the operation is APPLIED and can no
 * longer refund it. There is deliberately no committed ACTIVE state between
 * the inserted prose/audit and the operation verdict.
 */
export async function publishDraftedInsertedPages(
  options: Pick<
    Parameters<typeof draftInsertedPages>[0],
    "projectId" | "operationId" | "ownerToken" | "editInstruction" | "strategy" | "plan"
  >,
  drafted: DraftedInsertedPages,
  completion: { generationJobId: string; attemptId?: string | undefined }
): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const published = await tx.project.update({
      where: { id: options.projectId },
      data: { contentRevision: { increment: 1 } },
      select: { contentRevision: true }
    });
    const durableCompletion: DurableEditCompletionClaim = {
      generationJobId: completion.generationJobId,
      projectId: options.projectId,
      operationId: options.operationId,
      attemptId: completion.attemptId,
      type: "APPLY_BOOK_EDIT",
      message: "Page structure updated"
    };
    if (!(await claimDurableEditCompletionTx(tx, durableCompletion))) {
      throw new StructuralPageLeaseLostError();
    }
    const owned = await renewStructuralPageLeaseTx(tx, options.operationId, options.ownerToken);
    if (!owned || owned.status !== "ACTIVE") {
      throw new StructuralPageLeaseLostError();
    }
    if (owned.generationJobId && owned.generationJobId !== completion.generationJobId) {
      throw new StructuralPageLeaseLostError();
    }

    for (const { page, draft, qualityReport, preparedEmbedding, storyExtract } of drafted.candidates) {
      const saved = await tx.page.updateMany({
        where: { id: page.id, projectId: options.projectId, index: page.index, status: { not: "COMPLETED" } },
        data: {
          title: draft.title,
          markdown: draft.markdown,
          summary: draft.summary,
          imagePrompt: draft.imagePrompt ?? null,
          status: qualityReport.approved ? "COMPLETED" : "FAILED_QA",
          revision: { increment: 1 },
          qualityReport: qualityReport as Prisma.InputJsonValue
        }
      });
      if (saved.count !== 1) throw new Error(`Inserted page ${page.index} lost its publication claim`);
      if (draft.continuityNotes.length) {
        await tx.continuityNote.createMany({
          data: draft.continuityNotes.map((body) => ({
            projectId: options.projectId,
            pageId: page.id,
            scope: pageScope(page.index),
            body,
            tags: ["page", String(page.index), options.strategy.id, "edit"]
          }))
        });
      }
      if (preparedEmbedding) {
        await runBestEffortPageMemoryWrite(tx, () =>
          writePreparedEmbedding(
            { projectId: options.projectId, scope: pageScope(page.index), sourceId: page.id, text: draft.summary },
            preparedEmbedding,
            tx
          )
        );
      }
      if (storyExtract) {
        await runBestEffortPageMemoryWrite(tx, () =>
          persistStoryExtract({
            projectId: options.projectId,
            pageIndex: page.index,
            plan: options.plan,
            extract: storyExtract,
            client: tx
          })
        );
      }
    }

    await tx.bookEditOperation.update({
      where: { id: options.operationId },
      data: {
        status: "APPLIED",
        publicationRevision: published.contentRevision,
        affectedPageIndexes: drafted.pageIndexes,
        appliedAt: new Date(),
        editInstruction: options.editInstruction,
        ...(drafted.audit
          ? { adherenceAudit: drafted.audit as unknown as Prisma.InputJsonValue }
          : {})
      }
    });
    if (!(await settleDurableEditAttemptTx(tx, durableCompletion))) {
      throw new StructuralPageLeaseLostError();
    }
    return published.contentRevision;
  }, PAGE_RESTRUCTURE_TRANSACTION_OPTIONS);
}

async function candidateContext(
  options: Parameters<typeof draftInsertedPages>[0],
  page: InsertedPage,
  candidates: Map<number, InsertedCandidate>,
  researchByChapter: Map<number | null, string[]>,
  quality: Awaited<ReturnType<typeof loadQualityContext>>
): Promise<CandidateContext> {
  const [previous, following, storedNotes] = await Promise.all([
    prisma.page.findMany({
      where: { projectId: options.projectId, index: { lt: page.index }, status: "COMPLETED" },
      orderBy: { index: "desc" },
      take: 18
    }),
    prisma.page.findMany({
      where: { projectId: options.projectId, index: { gt: page.index }, status: "COMPLETED" },
      orderBy: { index: "asc" },
      take: 2
    }),
    loadContinuityNotes(options.projectId, { beforePageIndex: null })
  ]);
  const previousByIndex = new Map(previous.reverse().map(toPriorPageContext).map((entry) => [entry.index, entry]));
  for (const candidate of candidates.values()) {
    if (candidate.page.index < page.index) {
      previousByIndex.set(candidate.page.index, toContext(candidate));
    }
  }
  const previousPages = [...previousByIndex.values()].sort((left, right) => left.index - right.index).slice(-18);
  const nextPages = following.map(toPriorPageContext);
  const chapter = options.plan.chapters.find((entry) => entry.index === page.chapter?.index);
  const chapterKey = chapter?.index ?? null;
  let researchNotes = researchByChapter.get(chapterKey);
  if (!researchNotes) {
    researchNotes = await loadResearchNotesForGeneration(options.projectId, options.strategy, chapter);
    researchByChapter.set(chapterKey, researchNotes);
  }
  const styleExcerpts = await styleExcerptsForPage({
    projectId: options.projectId,
    pageIndex: page.index,
    recencyPages: previousPages,
    input: options.input,
    quality
  });
  return {
    page,
    ...(chapter ? { chapter } : {}),
    ...(page.chapter?.productionBrief
      ? { chapterBrief: parseChapterBrief(page.chapter.productionBrief) }
      : {}),
    previousPages,
    nextPages,
    continuityNotes: [
      ...storedNotes,
      ...[...candidates.values()]
        .filter((candidate) => candidate.page.index < page.index)
        .flatMap((candidate) => candidate.draft.continuityNotes)
    ],
    researchNotes,
    styleExcerpts
  };
}

async function reviewCandidate(
  options: Parameters<typeof draftInsertedPages>[0],
  context: CandidateContext,
  draft: PageDraft
): Promise<InsertedCandidate> {
  const reviewed = await reviewAndSaveGeneratedPage({
    projectId: options.projectId,
    planId: options.planVersionId,
    strategy: options.strategy,
    input: options.input,
    plan: options.plan,
    providers: options.providers,
    ...(context.chapter ? { chapter: context.chapter } : {}),
    ...(context.chapterBrief ? { chapterBrief: context.chapterBrief } : {}),
    draft: { ...draft, index: context.page.index },
    chapterId: context.page.chapterId,
    previousPages: context.previousPages,
    ...(context.nextPages.length ? { nextPages: context.nextPages } : {}),
    generationJobId: options.generationJobId,
    illustrate: false,
    assertOwnership: options.assertLease,
    deferPublication: true,
    editInstruction: options.editInstruction,
    ...(options.characterContext ? { characterContext: options.characterContext } : {}),
    maxCandidates: 1,
  });
  const candidate = reviewed.candidate;
  if (!candidate) {
    throw new Error(`Deferred review for inserted page ${context.page.index} returned no candidate`);
  }
  return {
    ...context,
    draft: candidate.draft,
    qualityReport: candidate.qualityReport
  };
}

async function reviewCandidates(
  options: Parameters<typeof draftInsertedPages>[0],
  candidates: Map<number, InsertedCandidate>
): Promise<EditAdherenceVerdict> {
  const afterPages = [...candidates.values()].map((candidate) => ({
    index: candidate.page.index,
    title: candidate.draft.title,
    markdown: candidate.draft.markdown,
    summary: candidate.draft.summary
  }));
  return reviewAppliedBookEdit({
    instruction: options.editInstruction,
    beforePages: [],
    afterPages,
    textModel: options.providers.text
  });
}

async function prepareCandidatesForPublication(
  options: Parameters<typeof draftInsertedPages>[0],
  candidates: InsertedCandidate[],
  quality: Awaited<ReturnType<typeof loadQualityContext>>
): Promise<PreparedInsertedCandidate[]> {
  let currentState = await loadProjectStoryState(options.projectId, options.plan.promises ?? []);
  const prepared: PreparedInsertedCandidate[] = [];
  for (const candidate of candidates) {
    const preparedEmbedding = strategyUsesSemanticMemory(options.strategy)
      ? await prepareEmbedding(candidate.draft.summary, options.providers.embedding)
      : null;
    const storyExtract = await keeperStoryExtractForSave({
      projectId: options.projectId,
      pageIndex: candidate.page.index,
      draft: candidate.draft,
      textModel: options.providers.text,
      plan: options.plan,
      input: options.input,
      previousExtract: null,
      keeperWasRevised: true,
      currentState,
      quality
    });
    if (storyExtract) {
      currentState = applyStoryDelta(currentState, storyExtract.storyDelta, candidate.page.index);
    }
    prepared.push({ ...candidate, preparedEmbedding, storyExtract });
  }

  return prepared;
}

async function requireLease(
  tx: Prisma.TransactionClient,
  operationId: string,
  ownerToken: string
): Promise<void> {
  if (!(await renewStructuralPageLeaseTx(tx, operationId, ownerToken))) {
    throw new StructuralPageLeaseLostError();
  }
}

function repairReport(report: PageQualityReport, requirements: string[]): PageQualityReport {
  return {
    ...report,
    approved: false,
    requiredRevisions: [
      ...requirements.map((requirement) => `Apply this missing approved requirement: ${requirement}`),
      ...report.requiredRevisions
    ]
  };
}

function allApproved(candidates: Map<number, InsertedCandidate>): boolean {
  return [...candidates.values()].every((candidate) => candidate.qualityReport.approved);
}

function toContext(candidate: InsertedCandidate): PriorPageContext {
  return {
    index: candidate.page.index,
    title: candidate.draft.title,
    markdown: candidate.draft.markdown,
    summary: candidate.draft.summary
  };
}

/**
 * Whether an already-written page set may settle on the prose it holds.
 *
 * `adherenceAudit` is newer than the rows this recovery exists for: a split
 * publication written before the column carries none at all, so reading its
 * absence as "the prose was not accepted" sent a book that already has its
 * pages back through a redraft it can never publish — every page reviewed
 * against a settled row, no candidate, and a rollback that deletes prose the
 * reader was charged for and already received. A *stored* audit that says the
 * prose was not approved is a different answer and is still not trusted.
 *
 * Three answers live in that column, not two, and only the middle one is a
 * reason to distrust prose the book already holds: the reviewer was satisfied,
 * the reviewer refused, or — since the adherence module grew `basis` — no
 * review was ever reached. An `unverified` audit is the missing audit above
 * written down, and it settles for the same reason the missing one does. That
 * matters now rather than in the abstract: the drafting loop deliberately
 * publishes an unverified insert instead of discarding it, so this column has
 * started carrying that third answer.
 *
 * `proseApproved` stays ANDed as its own signal. It is page QA's verdict on the
 * prose rather than the reviewer's on the instruction, and no basis speaks for it.
 */
function publishedPagesMaySettle(audit: unknown): boolean {
  if (audit === null || audit === undefined) return true;
  const stored = jsonRecord(audit);
  const verdict = jsonRecord(stored.verdict);
  const reviewerRefused = verdict.satisfied !== true && verdict.basis !== "unverified";
  return !reviewerRefused && stored.proseApproved === true;
}

function logMissingPages(options: Parameters<typeof draftInsertedPages>[0], pages: InsertedPage[]): number {
  const found = new Set(pages.map((page) => page.id));
  let missingPageCount = 0;
  for (const pageId of options.insertedPageIds) {
    if (!found.has(pageId)) {
      missingPageCount += 1;
      console.warn("Structural insert skipped a recorded page the book no longer holds", {
        event: "generation.structural_insert_page_missing",
        projectId: options.projectId,
        pageId
      });
    }
  }
  return missingPageCount;
}

async function reportPage(
  options: Parameters<typeof draftInsertedPages>[0],
  page: InsertedPage,
  offset: number,
  total: number
): Promise<void> {
  await advanceJobStep(
    options.generationJobId,
    "apply",
    40 + Math.round((offset / Math.max(total, 1)) * 40),
    `Writing page ${page.index}`,
    { done: offset, total, pageIndex: page.index }
  );
}
