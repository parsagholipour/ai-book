import { persistPreparedDeferredPageMemory, type PreparedDeferredPageMemory } from "./deferredPageMemory.js";
import { planMediaSettingsSnapshot } from "./bookHelpers.js";
import { assertReplanEditLeaseTx, ReplanEditLeaseLostError } from "./replanEditLease.js";
import { replanFollowUpClassifier, type ReplanFollowUpIdentity } from "./replanFollowUp.js";
import { stampExportInvalidationBarrierTx } from "./textEditFollowUp.js";
import {
  claimDurableEditCompletionTx,
  settleReplanAttemptTx
} from "../runtime/durableEditCompletion.js";
import { UnownedReplanDeliveryError, type ChapterSetup } from "../runtime/jobTypes.js";
import {
  mediaSettingsRowWriteback,
  seedStoryStateFromPromises,
  type BookGenerationStrategy,
  type BookPlan,
  type CreateProjectInput,
  type EditAdherenceVerdict,
  type PageDraft,
  type PageQualityReport,
  type PriorPageContext
} from "@book-maker/core";
import {
  MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS,
  PAGE_SCOPE_PREFIX,
  Prisma,
  prisma
} from "@book-maker/db";

/**
 * The one transaction that hands a replanned manuscript to the reader, and the
 * shapes it is built from.
 *
 * Split out of `replanEditCandidates.ts` for the reason `textEditPublication.ts`
 * and `restructurePagesPublication.ts` are split out of their drafting loops:
 * the drafting half is a sequence of provider calls that may be abandoned at any
 * point, and this half is a single all-or-nothing write whose statement order is
 * the lock order Stop takes. They are read for different questions.
 */

/** The pre-replan page an adherence review is measured against. */
export type SourcePage = {
  id: string;
  index: number;
  title: string;
  markdown: string;
  summary: string;
  imagePrompt: string | null;
  revision: number;
};

export type ReplanCandidate = {
  pageIndex: number;
  setup: ChapterSetup;
  sourcePage: SourcePage | undefined;
  draft: PageDraft;
  qualityReport: PageQualityReport;
  previousPages: PriorPageContext[];
  continuityNotes: string[];
  researchNotes: string[];
  styleExcerpts: string[];
};

export type ReplanAudit = {
  verdict: EditAdherenceVerdict;
  attempts: number;
  missingRequirements: string[];
  checkedAt: string;
  proseApproved: boolean;
};

export async function publishReplannedBook(options: {
  projectId: string;
  planId: string;
  operationId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  strategy: BookGenerationStrategy;
  candidates: Map<number, ReplanCandidate>;
  preparedMemory: PreparedDeferredPageMemory[];
  setups: ChapterSetup[];
  editInstruction: string;
  characterContext?: string | undefined;
  audit: ReplanAudit;
  ownerToken: string;
  generationJobId?: string | undefined;
  attemptId?: string | undefined;
}): Promise<ReplanFollowUpIdentity> {
  return prisma.$transaction(async (tx) => {
    // Project is the root of the edit publication lock order. Stop takes this
    // same row before GenerationJob and BookEditOperation, so publication must
    // not renew the operation lease and then wait behind Stop for Project.
    // The no-op update both proves the project still exists and keeps the live
    // row-owned media settings stable until the replacement commit lands.
    const liveProject = await tx.project.update({
      where: { id: options.projectId },
      data: { contentRevision: { increment: 0 } },
      select: { mediaSettings: true }
    });
    const durableCompletion = options.generationJobId
      ? {
          generationJobId: options.generationJobId,
          projectId: options.projectId,
          operationId: options.operationId,
          ...(options.attemptId ? { attemptId: options.attemptId } : {}),
          type: "GENERATE_BOOK" as const,
          message: "Revised book published"
        }
      : null;
    if (durableCompletion) {
      // Stop locks Project -> GenerationJob -> BookEditOperation. Claim and
      // terminalize this row in that same order, in the manuscript transaction,
      // so nothing after APPLIED can enter the failure/refund lifecycle.
      if (!(await claimDurableEditCompletionTx(tx, durableCompletion))) {
        throw new UnownedReplanDeliveryError();
      }
    }
    const owned = await assertActiveReplanEditLeaseTx(tx, options.operationId, options.ownerToken);
    if (durableCompletion && !(await settleReplanAttemptTx(tx, durableCompletion))) {
      // A stopped/refunded attempt or a payload/job linkage mismatch has the
      // same ownership answer: roll back the manuscript and stand down without
      // a second failure/refund settlement.
      throw new UnownedReplanDeliveryError();
    }

    await tx.imageAsset.deleteMany({ where: { projectId: options.projectId } });
    await tx.page.deleteMany({ where: { projectId: options.projectId } });
    await tx.chapter.deleteMany({ where: { projectId: options.projectId } });
    await tx.continuityNote.deleteMany({ where: { projectId: options.projectId } });
    await tx.embedding.deleteMany({ where: { projectId: options.projectId, scope: { startsWith: PAGE_SCOPE_PREFIX } } });
    await replaceReferenceRecords(tx, options.projectId, options.plan);

    await tx.chapter.createMany({
      data: options.setups.map((setup) => ({
        projectId: options.projectId,
        index: setup.chapter.index,
        title: setup.chapter.title,
        summary: setup.chapter.summary,
        targetPages: setup.chapter.targetPages,
        productionBrief: setup.brief as Prisma.InputJsonValue,
        status: "COMPLETED"
      }))
    });
    const createdChapters = await tx.chapter.findMany({
      where: { projectId: options.projectId, index: { in: options.setups.map((setup) => setup.chapter.index) } },
      select: { id: true, index: true }
    });
    const chapterIds = new Map(createdChapters.map((chapter) => [chapter.index, chapter.id]));
    if (chapterIds.size !== options.setups.length) {
      throw new Error("Replan publication could not resolve every replacement chapter");
    }
    await tx.page.createMany({
      data: [...options.candidates.values()]
        .sort((left, right) => left.pageIndex - right.pageIndex)
        .map((candidate) => ({
          projectId: options.projectId,
          chapterId: chapterIds.get(candidate.setup.chapter.index) ?? null,
          index: candidate.pageIndex,
          title: candidate.draft.title,
          markdown: candidate.draft.markdown,
          summary: candidate.draft.summary,
          imagePrompt: candidate.draft.imagePrompt ?? null,
          qualityReport: candidate.qualityReport as Prisma.InputJsonValue,
          // Terminal for the export, and the replan recompile's full QA repairs it.
          status: candidate.qualityReport.approved ? "COMPLETED" : "FAILED_QA",
          revision: (candidate.sourcePage?.revision ?? 0) + 1
        }))
    });
    const createdPages = await tx.page.findMany({
      where: { projectId: options.projectId, index: { in: [...options.candidates.keys()] } },
      select: { id: true, index: true }
    });
    const pageIds = new Map(createdPages.map((page) => [page.index, page.id]));
    if (pageIds.size !== options.candidates.size) {
      throw new Error("Replan publication could not resolve every replacement page");
    }

    await tx.planVersion.updateMany({
      where: { projectId: options.projectId, id: { not: options.planId } },
      data: { status: "SUPERSEDED" }
    });
    await tx.planVersion.update({
      where: { id: options.planId },
      data: { status: "APPROVED", approvedAt: new Date() }
    });
    const published = await tx.project.update({
      where: { id: options.projectId },
      data: {
        currentPlanId: options.planId,
        // The manuscript is committed, but its old exports are not. The exact
        // APPLIED tail below owns the EDITING -> settled handoff.
        status: "EDITING",
        title: options.plan.title,
        language: options.input.language,
        targetPages: options.input.targetPages,
        mediaSettings: mediaSettingsRowWriteback(
          liveProject.mediaSettings,
          planMediaSettingsSnapshot(options.input) as Record<string, unknown>
        ) as Prisma.InputJsonValue,
        storyState: seedStoryStateFromPromises(options.plan.promises ?? []) as Prisma.InputJsonValue,
        contentRevision: { increment: 1 }
      },
      select: { contentRevision: true }
    });
    // Same transaction as the bump, so no reader sees the new revision without
    // the barrier that holds the window open until the tail's unlink is done.
    await stampExportInvalidationBarrierTx(tx, options.projectId, published.contentRevision);
    await persistPreparedDeferredPageMemory({
      tx,
      projectId: options.projectId,
      plan: options.plan,
      strategyId: options.strategy.id,
      pageIds,
      prepared: options.preparedMemory,
      tags: ["edit", "replan"]
    });
    const identity: ReplanFollowUpIdentity = {
      projectId: options.projectId,
      operationId: options.operationId,
      planVersionId: options.planId,
      publicationRevision: published.contentRevision
    };
    await tx.bookEditOperation.update({
      where: { id: options.operationId },
      data: {
        status: "APPLIED",
        editInstruction: options.editInstruction,
        ...(options.characterContext ? { characterContext: options.characterContext } : {}),
        adherenceAudit: options.audit as unknown as Prisma.InputJsonValue,
        affectedPageIndexes: [...options.candidates.keys()].sort((left, right) => left - right),
        publicationRevision: published.contentRevision,
        classifier: replanFollowUpClassifier(owned.classifier, identity),
        appliedAt: new Date()
      }
    });
    return identity;
  }, MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS);
}

async function replaceReferenceRecords(
  tx: Prisma.TransactionClient,
  projectId: string,
  plan: BookPlan
): Promise<void> {
  await tx.character.deleteMany({ where: { projectId } });
  await tx.location.deleteMany({ where: { projectId } });
  await tx.researchSource.deleteMany({ where: { projectId } });
  if (plan.characters.length) {
    await tx.character.createMany({
      data: plan.characters.map((character) => ({
        projectId,
        name: character.name,
        role: character.role,
        description: character.description,
        traits: character.traits,
        visualRules: character.visualRules
      }))
    });
  }
  if (plan.locations.length) {
    await tx.location.createMany({
      data: plan.locations.map((location) => ({
        projectId,
        name: location.name,
        description: location.description,
        rules: location.rules
      }))
    });
  }
  if (plan.researchNotes.length) {
    await tx.researchSource.createMany({
      data: plan.researchNotes.map((source) => ({
        projectId,
        query: source.query,
        title: source.title,
        url: source.url ?? null,
        summary: source.summary,
        publishedAt: source.publishedAt ? new Date(source.publishedAt) : null
      }))
    });
  }
}

export async function assertActiveReplanEditLeaseTx(
  tx: Prisma.TransactionClient,
  operationId: string,
  ownerToken: string
): Promise<{ classifier: unknown }> {
  const owned = await assertReplanEditLeaseTx(tx, operationId, ownerToken);
  if (owned.status !== "ACTIVE") throw new ReplanEditLeaseLostError();
  return { classifier: owned.classifier };
}
