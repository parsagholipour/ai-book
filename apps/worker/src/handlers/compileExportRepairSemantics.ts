import { writePreparedEmbedding, type PreparedEmbedding } from "../generation/embeddingWrites.js";
import { updateEntityStateFromPage } from "../generation/entityState.js";
import { persistStoryExtract } from "../generation/qualityEnrichment.js";
import { isStopRequestedError } from "../runtime/jobTypes.js";
import { ExportRepairFenceUnreadableError, ExportRepairSupersededError } from "./compileExportFence.js";
import type { BookPlan, StoryExtractResult, StoryState } from "@book-maker/core";
import { pageScope, Prisma, prisma } from "@book-maker/db";

export type FinalQaOwnershipClient = Pick<Prisma.TransactionClient, "project">;
export type FinalQaOwnershipClaim = (client?: FinalQaOwnershipClient) => Promise<void>;

type FinalQaSemanticClient = Pick<
  Prisma.TransactionClient,
  "page" | "project" | "continuityNote" | "character" | "location" | "$executeRawUnsafe"
>;

/**
 * Publishes every durable memory derived from one repaired keeper behind the
 * same project revision and exact page claim. Provider work is deliberately
 * absent: the caller prepares the story extract and embedding before opening
 * this transaction.
 */
export async function persistFinalQaPageSemantics(options: {
  assertOwnership?: FinalQaOwnershipClaim;
  projectId: string;
  pageId: string;
  pageIndex: number;
  title: string;
  markdown: string;
  summary: string;
  imagePrompt: string | null;
  revision: number;
  status: "COMPLETED" | "FAILED_QA";
  updatedAt: Date;
  plan: BookPlan;
  keeperExtract: StoryExtractResult | null;
  continuityNotes: string[];
  usesSemanticMemory: boolean;
  preparedEmbedding: PreparedEmbedding | null;
}): Promise<StoryState | null> {
  const hasSemanticWrites =
    options.keeperExtract !== null ||
    options.continuityNotes.length > 0 ||
    (options.usesSemanticMemory && options.preparedEmbedding !== null);
  if (!hasSemanticWrites) {
    return null;
  }
  try {
    return await prisma.$transaction(async (tx: FinalQaSemanticClient) => {
      await options.assertOwnership?.(tx);
      const owned = await tx.page.updateMany({
        where: {
          id: options.pageId,
          title: options.title,
          markdown: options.markdown,
          summary: options.summary,
          imagePrompt: options.imagePrompt,
          revision: options.revision,
          status: options.status,
          updatedAt: options.updatedAt
        },
        // A no-op write is an exact row lock. A reader edit either committed
        // before it (and misses the predicate) or waits and becomes the later
        // owner; it cannot land in the semantic tail.
        data: { updatedAt: options.updatedAt }
      });
      if (owned.count !== 1) {
        throw new ExportRepairSupersededError();
      }

      let storyState: StoryState | null = null;
      if (options.keeperExtract) {
        storyState = await persistStoryExtract({
          projectId: options.projectId,
          pageIndex: options.pageIndex,
          plan: options.plan,
          extract: options.keeperExtract,
          client: tx
        });
      }
      if (options.continuityNotes.length > 0) {
        await tx.continuityNote.createMany({
          data: options.continuityNotes.map((body) => ({
            projectId: options.projectId,
            pageId: options.pageId,
            scope: pageScope(options.pageIndex),
            body,
            tags: ["page", String(options.pageIndex), "final-qa-repair"]
          }))
        });
      }
      if (options.usesSemanticMemory && options.continuityNotes.length > 0) {
        await updateEntityStateFromPage(options.projectId, options.pageIndex, options.continuityNotes, tx);
      }
      if (options.usesSemanticMemory && options.preparedEmbedding) {
        await writePreparedEmbedding(
          {
            projectId: options.projectId,
            scope: pageScope(options.pageIndex),
            sourceId: options.pageId,
            text: options.summary
          },
          options.preparedEmbedding,
          tx
        );
      }
      return storyState;
    });
  } catch (error) {
    if (
      error instanceof ExportRepairSupersededError ||
      error instanceof ExportRepairFenceUnreadableError ||
      isStopRequestedError(error)
    ) {
      throw error;
    }
    console.warn("Final-QA semantic memory publication failed; keeping the repaired page", {
      projectId: options.projectId,
      pageId: options.pageId,
      pageIndex: options.pageIndex,
      error
    });
    return null;
  }
}
