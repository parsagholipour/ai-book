import {
  jsonPayloadToRecord,
  type SettledProjectStatus,
  type StoryState
} from "@book-maker/core";
import {
  MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS,
  Prisma,
  prisma
} from "@book-maker/db";
import { randomUUID } from "node:crypto";
import { assertTextEditLeaseTx } from "./textEditLease.js";
import {
  claimAppliedEditPublication,
  restoreEditProjectStatus
} from "./editProjectStatus.js";
import {
  followUpClassifier,
  stampExportInvalidationBarrierTx,
  type TextEditMemoryEntry,
  type TextEditPublicationIdentity
} from "./textEditFollowUp.js";
import {
  claimDurableEditCompletionTx,
  settleDurableEditAttemptTx,
  type DurableEditCompletionClaim
} from "../runtime/durableEditCompletion.js";
import { UnownedTextEditDeliveryError } from "../runtime/jobTypes.js";
import type { PreparedEmbedding } from "./embeddingWrites.js";

// The follow-up tail is a module of its own — it grew past what this file has
// room for — but it is this file's callers that own an edit end to end, so its
// entry points stay reachable from here.
export {
  textEditPublicationCompletion,
  textEditPublicationIdentity,
  textEditTailNeedsMemory,
  type TextEditMemoryEntry,
  type TextEditPublicationIdentity
} from "./textEditFollowUp.js";

export type TextEditPublicationPage = {
  pageId: string;
  pageIndex: number;
  revisionBefore: number;
  titleBefore: string;
  markdownBefore: string;
  summaryBefore: string;
  imagePromptBefore: string | null;
  qualityReportBefore: unknown;
  storyDeltaBefore: unknown;
  titleAfter: string;
  markdownAfter: string;
  summaryAfter: string;
  imagePromptAfter: string | null;
  qualityReportAfter: unknown;
  storyDeltaAfter: unknown;
  /**
   * The rewrite loop's verdict, saved honestly. A page whose best candidate
   * still failed review stays flagged so the next full compile's repair pass
   * can target it, and so the failed count the quality report is built from
   * keeps counting it.
   */
  statusAfter: "COMPLETED" | "FAILED_QA";
  continuityNotes: string[];
  preparedEmbedding: PreparedEmbedding | null;
};

type PublicationCountRow = {
  inputCount: number;
  distinctPageCount: number;
  resolvedSnapshotCount: number;
  validSnapshotCount: number;
  updatedPageCount: number;
  updatedSnapshotCount: number;
};

/**
 * Publishes an accepted text-edit candidate set behind one small interface.
 * All page/snapshot work is two set-based statements; the surrounding
 * transaction has a bounded number of database round trips independent of the
 * number of edited pages.
 */
export async function publishTextEditManuscript(options: {
  projectId: string;
  operationId: string;
  ownerToken: string;
  planVersionId: string;
  fallbackStatus: SettledProjectStatus;
  editInstruction: string;
  audit: unknown | null;
  skippedPageIndexes: number[];
  pages: readonly TextEditPublicationPage[];
  storyStateAfter: StoryState;
  completion: DurableEditCompletionClaim;
}): Promise<{
  identity: TextEditPublicationIdentity;
  memory: TextEditMemoryEntry[];
}> {
  if (options.pages.length === 0) {
    throw new Error("Text edit publication requires at least one changed page");
  }
  const pagePayload = options.pages.map((page) => ({
    snapshot_id: randomUUID(),
    page_id: page.pageId,
    page_index: page.pageIndex,
    revision_before: page.revisionBefore,
    title_before: page.titleBefore,
    markdown_before: page.markdownBefore,
    summary_before: page.summaryBefore,
    image_prompt_before: page.imagePromptBefore,
    quality_report_before: page.qualityReportBefore,
    story_delta_before: page.storyDeltaBefore,
    title_after: page.titleAfter,
    markdown_after: page.markdownAfter,
    summary_after: page.summaryAfter,
    image_prompt_after: page.imagePromptAfter,
    quality_report_after: page.qualityReportAfter,
    story_delta_after: page.storyDeltaAfter,
    status_after: page.statusAfter
  }));
  const continuityNotes = options.pages.flatMap((page) =>
    page.continuityNotes.map((body) => ({
      projectId: options.projectId,
      pageId: page.pageId,
      scope: `page:${page.pageIndex}:edit:${options.operationId}`,
      body,
      tags: ["page", String(page.pageIndex), "edit"]
    }))
  );

  const identity = await prisma.$transaction(async (tx) => {
    // Project -> durable GenerationJob -> operation is the Stop/publication
    // order. The no-op Project update is the row lock, not a state change.
    await tx.project.update({
      where: { id: options.projectId },
      data: { contentRevision: { increment: 0 } }
    });
    if (!(await claimDurableEditCompletionTx(tx, options.completion))) {
      throw new UnownedTextEditDeliveryError();
    }
    const owned = await assertTextEditLeaseTx(tx, options.operationId, options.ownerToken);
    // The lease CAS is shared with the tail, so it admits an APPLIED row too.
    // A publication is a first delivery's write by definition: re-stamping an
    // operation that already published would overwrite its `publicationRevision`
    // and reset `completedSteps` to `[]` under a tail that is still checkpointing
    // against them, whose next read then throws on the identity it can no longer
    // find. Every sibling names the status it is settling from — the skip CAS,
    // `stageOwnedReplan`, `linkReplanSuccessor` — and this one did not.
    if (owned.status !== "ACTIVE") {
      throw new UnownedTextEditDeliveryError();
    }
    if (owned.generationJobId && owned.generationJobId !== options.completion.generationJobId) {
      throw new UnownedTextEditDeliveryError();
    }
    if (options.skippedPageIndexes.length > 0) {
      await tx.pageEditSnapshot.deleteMany({
        where: {
          operationId: options.operationId,
          pageIndex: { in: options.skippedPageIndexes }
        }
      });
    }

    await bulkPublishPages(tx, options.projectId, options.operationId, pagePayload);
    if (continuityNotes.length > 0) {
      await tx.continuityNote.createMany({ data: continuityNotes });
    }

    const revisions = await tx.$queryRawUnsafe<Array<{ contentRevision: number }>>(
      `UPDATE "Project"
          SET "contentRevision" = "contentRevision" + 1,
              "storyState" = $2::jsonb,
              "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1
        RETURNING "contentRevision"`,
      options.projectId,
      JSON.stringify(options.storyStateAfter)
    );
    const publicationRevision = revisions[0]?.contentRevision;
    if (!Number.isInteger(publicationRevision)) {
      throw new Error("Text edit publication could not advance the manuscript revision");
    }
    // No compiler may install files until the post-commit tail has removed the
    // previous exports and cleared this exact value. It is a named primitive
    // rather than another column on the statement above because three other
    // publications unlink post-commit with no barrier at all, and the thing they
    // are missing has to be something they can call.
    await stampExportInvalidationBarrierTx(tx, options.projectId, publicationRevision!);
    const nextIdentity: TextEditPublicationIdentity = {
      projectId: options.projectId,
      operationId: options.operationId,
      planVersionId: options.planVersionId,
      publicationRevision: publicationRevision!,
      fallbackStatus: options.fallbackStatus
    };
    const root = jsonPayloadToRecord(owned.classifier);
    const classifier = {
      ...followUpClassifier(root, nextIdentity, []),
      ...(options.skippedPageIndexes.length > 0
        ? { skippedPageIndexes: options.skippedPageIndexes }
        : {})
    } as Prisma.InputJsonObject;
    // `updateMany`, so the row this transaction read under the lease is the row
    // it stamps: an `update` by id alone would take an APPLIED row back through
    // the whole publication write, and the lease CAS above cannot refuse that.
    const applied = await tx.bookEditOperation.updateMany({
      where: { id: options.operationId, status: "ACTIVE" },
      data: {
        status: "APPLIED",
        publicationRevision: nextIdentity.publicationRevision,
        affectedPageIndexes: options.pages.map((page) => page.pageIndex),
        editInstruction: options.editInstruction,
        ...(options.audit ? { adherenceAudit: options.audit as Prisma.InputJsonValue } : {}),
        classifier: classifier as Prisma.InputJsonValue,
        appliedAt: new Date()
      }
    });
    if (applied.count !== 1) {
      throw new UnownedTextEditDeliveryError();
    }
    if (!(await settleDurableEditAttemptTx(tx, options.completion))) {
      throw new UnownedTextEditDeliveryError();
    }
    return nextIdentity;
  }, MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS);

  return {
    identity,
    memory: options.pages.flatMap((page) =>
      page.preparedEmbedding
        ? [{
            pageId: page.pageId,
            pageIndex: page.pageIndex,
            pageRevision: page.revisionBefore + 1,
            summary: page.summaryAfter,
            preparedEmbedding: page.preparedEmbedding
          }]
        : []
    )
  };
}

/**
 * Exported for `textEditPublication.integration.test.ts`. Every unit suite
 * replaces `$queryRawUnsafe` with a `vi.fn()`, so a real PostgreSQL is the only
 * thing that can say what these two statements do.
 */
export async function bulkPublishPages(
  tx: Prisma.TransactionClient,
  projectId: string,
  operationId: string,
  pagePayload: readonly Record<string, unknown>[]
): Promise<void> {
  const payloadJson = JSON.stringify(pagePayload);
  // Nothing creates a text edit's snapshots before this call, so on an ordinary
  // first delivery every one of them is born here. It cannot be born inside the
  // publication below: PostgreSQL runs all of a statement's `WITH`
  // sub-statements against one snapshot, so a sibling
  // `UPDATE "PageEditSnapshot"` scans the table as it was before the statement
  // began and matches none of the rows that statement's own `INSERT` produced.
  // Folded in there, `updatedSnapshotCount` was 0 on every page_rewrite and
  // local_patch, the count check below rolled the whole publication back, and
  // the edit failed after paying for each rewrite — and had the check not
  // caught it, the snapshots would have carried a NULL `titleAfter` /
  // `revisionAfter`, which is what Undo and the resume stamp read. So the
  // insert is its own statement, still set-based, and the round trips stay
  // independent of the number of edited pages.
  await tx.$executeRawUnsafe(
    `INSERT INTO "PageEditSnapshot" (
       "id", "projectId", "pageId", "operationId", "pageIndex",
       "titleBefore", "markdownBefore", "summaryBefore", "revisionBefore",
       "storyDeltaBefore", "createdAt"
     )
     SELECT item.snapshot_id, $1, item.page_id, $2, item.page_index,
            item.title_before, item.markdown_before, item.summary_before,
            item.revision_before, item.story_delta_before, CURRENT_TIMESTAMP
       FROM jsonb_to_recordset($3::jsonb) AS item(
         snapshot_id text, page_id text, page_index integer,
         revision_before integer,
         title_before text, markdown_before text, summary_before text,
         story_delta_before jsonb
       )
      WHERE NOT EXISTS (
        SELECT 1
          FROM "PageEditSnapshot" snapshot
         WHERE snapshot."operationId" = $2
           AND snapshot."pageId" = item.page_id
      )`,
    projectId,
    operationId,
    payloadJson
  );
  const rows = await tx.$queryRawUnsafe<PublicationCountRow[]>(
    `WITH input AS MATERIALIZED (
       SELECT *
         FROM jsonb_to_recordset($3::jsonb) AS item(
           snapshot_id text, page_id text, page_index integer,
           revision_before integer,
           title_before text, markdown_before text, summary_before text,
           image_prompt_before text, quality_report_before jsonb, story_delta_before jsonb,
           title_after text, markdown_after text, summary_after text,
           image_prompt_after text, quality_report_after jsonb, story_delta_after jsonb,
           status_after text
         )
     ),
     resolved_snapshots AS MATERIALIZED (
       SELECT snapshot.*
         FROM "PageEditSnapshot" snapshot
         JOIN input item ON item.page_id = snapshot."pageId"
        WHERE snapshot."operationId" = $2
     ),
     valid_snapshots AS MATERIALIZED (
       SELECT snapshot."id", snapshot."pageId"
         FROM resolved_snapshots snapshot
         JOIN input item ON item.page_id = snapshot."pageId"
        WHERE snapshot."projectId" = $1
          AND snapshot."pageIndex" = item.page_index
          AND snapshot."revisionBefore" = item.revision_before
          AND snapshot."titleBefore" = item.title_before
          AND snapshot."markdownBefore" = item.markdown_before
          AND snapshot."summaryBefore" = item.summary_before
          AND snapshot."storyDeltaBefore" IS NOT DISTINCT FROM item.story_delta_before
     ),
     updated_pages AS MATERIALIZED (
       UPDATE "Page" page
          SET "title" = item.title_after,
              "markdown" = item.markdown_after,
              "summary" = item.summary_after,
              "imagePrompt" = item.image_prompt_after,
              "qualityReport" = item.quality_report_after,
              "storyDelta" = item.story_delta_after,
              "status" = item.status_after,
              "revision" = page."revision" + 1,
              "updatedAt" = CURRENT_TIMESTAMP
         FROM input item
        WHERE page."id" = item.page_id
          AND page."projectId" = $1
          AND page."index" = item.page_index
          AND page."revision" = item.revision_before
          AND page."title" = item.title_before
          AND page."markdown" = item.markdown_before
          AND page."summary" = item.summary_before
          AND page."imagePrompt" IS NOT DISTINCT FROM item.image_prompt_before
          AND page."qualityReport" IS NOT DISTINCT FROM item.quality_report_before
          AND page."storyDelta" IS NOT DISTINCT FROM item.story_delta_before
          AND EXISTS (
            SELECT 1 FROM valid_snapshots snapshot
             WHERE snapshot."pageId" = item.page_id
          )
       RETURNING page."id", page."revision", page."title", page."markdown", page."summary"
     ),
     updated_snapshots AS (
       UPDATE "PageEditSnapshot" snapshot
          SET "titleAfter" = page."title",
              "markdownAfter" = page."markdown",
              "summaryAfter" = page."summary",
              "revisionAfter" = page."revision"
         FROM updated_pages page
        WHERE snapshot."operationId" = $2
          AND snapshot."pageId" = page."id"
          AND EXISTS (
            SELECT 1 FROM valid_snapshots valid
             WHERE valid."id" = snapshot."id"
          )
       RETURNING snapshot."id"
     )
     SELECT
       (SELECT count(*)::integer FROM input) AS "inputCount",
       (SELECT count(DISTINCT page_id)::integer FROM input) AS "distinctPageCount",
       (SELECT count(*)::integer FROM resolved_snapshots) AS "resolvedSnapshotCount",
       (SELECT count(*)::integer FROM valid_snapshots) AS "validSnapshotCount",
       (SELECT count(*)::integer FROM updated_pages) AS "updatedPageCount",
       (SELECT count(*)::integer FROM updated_snapshots) AS "updatedSnapshotCount"`,
    projectId,
    operationId,
    payloadJson
  );
  const counts = rows[0];
  const expected = pagePayload.length;
  if (
    !counts ||
    counts.inputCount !== expected ||
    counts.distinctPageCount !== expected ||
    counts.resolvedSnapshotCount !== expected ||
    counts.validSnapshotCount !== expected ||
    counts.updatedPageCount !== expected ||
    counts.updatedSnapshotCount !== expected
  ) {
    throw new Error("Text edit bulk publication did not update every exact page/snapshot pair");
  }
}

/**
 * Upgrade bridge for APPLIED rows whose old publication already performed the
 * filesystem invalidation. It adopts only the legacy operation generation
 * that still owns the exact current revision.
 */
export async function adoptLegacyTextEditTail(options: {
  projectId: string;
  operationId: string;
  ownerToken: string;
  planVersionId?: string | undefined;
  fallbackStatus: SettledProjectStatus;
}): Promise<TextEditPublicationIdentity | null> {
  return prisma.$transaction(async (tx) => {
    if (!(await claimAppliedEditPublication(
      tx,
      options.projectId,
      options.operationId,
      options.fallbackStatus
    ))) {
      return null;
    }
    const owned = await assertTextEditLeaseTx(tx, options.operationId, options.ownerToken);
    const project = await tx.project.findUnique({
      where: { id: options.projectId },
      select: { currentPlanId: true, contentRevision: true }
    });
    const planVersionId = options.planVersionId ?? project?.currentPlanId;
    if (!project || !planVersionId) {
      // The claim above already committed this project to EDITING, and only a
      // compile takes it back out. There is no compile to hand it to, so the
      // settled status goes back in the same transaction that took it —
      // otherwise nothing ever moves the book again, and the on-demand export
      // repair lane never sees the settled row it rebuilds from.
      await restoreEditProjectStatus(
        tx,
        options.projectId,
        options.operationId,
        options.fallbackStatus
      );
      return null;
    }
    const identity: TextEditPublicationIdentity = {
      projectId: options.projectId,
      operationId: options.operationId,
      planVersionId,
      publicationRevision: project.contentRevision,
      fallbackStatus: options.fallbackStatus
    };
    await tx.bookEditOperation.update({
      where: { id: options.operationId },
      data: {
        publicationRevision: identity.publicationRevision,
        classifier: followUpClassifier(owned.classifier, identity, ["exports", "memory"]) as Prisma.InputJsonValue
      }
    });
    return identity;
  }, MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS);
}
