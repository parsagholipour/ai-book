import {
  nextPageVersion,
  pageIllustrationKeeperToken,
  retireGeneratedPageIllustrations,
  type PageIllustrationKeeper
} from "./pageIllustrationOwnership.js";
import { enqueueWorkerJob } from "../runtime/dispatch.js";
import type { PageQualityLoopOutcome } from "./pageReview.js";
import { type PageDraft, type PageQualityReport, type PriorPageContext } from "@book-maker/core";
import {
  pageScope,
  Prisma,
  prisma
} from "@book-maker/db";

type GeneratedPageWriteClient = Pick<Prisma.TransactionClient, "page" | "imageAsset">;

function illustrationKeeper(
  projectId: string,
  pageId: string,
  page: Omit<PageIllustrationKeeper, "projectId" | "pageId">
): PageIllustrationKeeper {
  return { projectId, pageId, ...page };
}

export type StagedGeneratedPage = {
  id: string;
  revision: number;
  updatedAt: Date;
};

export type GeneratedPagePublicationSnapshot = {
  id: string;
  status: string;
  title: string;
  markdown: string;
  summary: string;
  imagePrompt: string | null;
  revision: number;
  updatedAt: Date;
};

export class GeneratedPagePublicationClaimLostError extends Error {
  constructor(readonly pageIndex: number) {
    super(`Page ${pageIndex} lost its optimistic publication claim`);
    this.name = "GeneratedPagePublicationClaimLostError";
  }
}

type StageGeneratedPageOptions = {
  projectId: string;
  chapterId: string | null;
  pageIndex: number;
  draft: PageDraft;
  revision: number;
  qualityReport: PageQualityReport;
  status: "GENERATING" | "FAILED_QA" | "COMPLETED";
  assertOwnership?: () => Promise<void>;
  existingPage: GeneratedPagePublicationSnapshot | null;
};

export async function loadGeneratedPagePublicationSnapshot(
  projectId: string,
  pageIndex: number
): Promise<GeneratedPagePublicationSnapshot | null> {
  return prisma.page.findUnique({
    where: { projectId_index: { projectId, index: pageIndex } },
    select: {
      id: true,
      status: true,
      title: true,
      markdown: true,
      summary: true,
      imagePrompt: true,
      revision: true,
      updatedAt: true
    }
  });
}

export function settledGeneratedPageContext(
  page: GeneratedPagePublicationSnapshot | null,
  pageIndex: number
): PriorPageContext | undefined {
  return page?.status === "COMPLETED"
    ? { index: pageIndex, title: page.title, markdown: page.markdown, summary: page.summary }
    : undefined;
}

/**
 * Publish a keeper as non-terminal under an optimistic row claim. The page and
 * a kept chapter-brief repair share the same transaction and therefore the
 * same win. A claim miss asks a lease-backed caller's fence once more so its
 * domain-specific stand-down error wins; an unfenced direct pass fails and
 * retries instead of publishing stale prose or chapter memory.
 */
export async function stageGeneratedPageAndBrief(options: {
  pendingBriefRepair: PageQualityLoopOutcome["pendingBriefRepair"];
} & StageGeneratedPageOptions): Promise<StagedGeneratedPage> {
  const replacementKeeper = replacesIllustrationKeeper(options);
  const publish = (client: GeneratedPageWriteClient) => stageGeneratedPageWithClient(client, options);
  if (!options.pendingBriefRepair && !replacementKeeper) {
    return publish(prisma);
  }
  return prisma.$transaction(async (tx) => {
    const staged = await publish(tx);
    await options.pendingBriefRepair?.(tx);
    return staged;
  });
}

/**
 * The transaction-friendly half of keeper staging. Whole-book publication has
 * chapter/page reset work of its own, so opening another transaction here
 * would either split one manuscript replacement or hold a transaction across
 * the image queue. Callers supply only a database client; no provider or queue
 * work is performed in this function.
 */
export async function stageGeneratedPageWithClient(
  client: GeneratedPageWriteClient,
  options: StageGeneratedPageOptions
): Promise<StagedGeneratedPage> {
  const existing = options.existingPage;
  const replacementKeeper = replacesIllustrationKeeper(options);
  const updatedAt = nextPageVersion(existing?.updatedAt instanceof Date ? existing.updatedAt : new Date(0));
  const data = {
    chapterId: options.chapterId,
    title: options.draft.title,
    markdown: options.draft.markdown,
    summary: options.draft.summary,
    imagePrompt: options.draft.imagePrompt ?? null,
    status: options.status,
    revision: options.revision,
    qualityReport: options.qualityReport as Prisma.InputJsonValue,
    updatedAt
  };
  let staged: StagedGeneratedPage;
  if (!existing) {
    const created = await client.page.create({
      data: {
        projectId: options.projectId,
        index: options.pageIndex,
        ...data
      }
    });
    staged = { id: created.id, revision: options.revision, updatedAt };
  } else {
    const claimed = await client.page.updateMany({
      where: {
        id: existing.id,
        // Structural ordering deliberately preserves updatedAt so stable page
        // identity and in-flight illustrations survive a move. Staging prose
        // drafted for the old position must not: the caller has to restart
        // from the page's new brief and neighbours instead of overwriting the
        // moved row under an otherwise-valid version claim.
        index: options.pageIndex,
        status: existing.status,
        updatedAt: existing.updatedAt
      },
      data
    });
    if (claimed.count !== 1) {
      await options.assertOwnership?.();
      throw new GeneratedPagePublicationClaimLostError(options.pageIndex);
    }
    staged = { id: existing.id, revision: options.revision, updatedAt };
  }

  if (existing && replacementKeeper) {
    await retireGeneratedPageIllustrations(client, {
      pageIndex: options.pageIndex,
      priorKeeper: illustrationKeeper(options.projectId, existing.id, existing)
    });
  }
  return staged;
}

function replacesIllustrationKeeper(options: StageGeneratedPageOptions): boolean {
  const existing = options.existingPage;
  return existing
    ? pageIllustrationKeeperToken(illustrationKeeper(options.projectId, existing.id, existing)) !==
        pageIllustrationKeeperToken(
          illustrationKeeper(options.projectId, existing.id, { ...options.draft, revision: options.revision })
        )
    : false;
}

export type GeneratedPagePublicationResult = "completed" | "enqueue-declined" | "superseded";

/**
 * Finish the shared illustrated-keeper protocol without spanning the external
 * queue call with a database transaction: the exact keeper is already staged,
 * its tokened job becomes durable, and only then may that keeper become
 * terminal together with its page-owned continuity notes.
 */
export async function publishStagedGeneratedPage(options: {
  projectId: string;
  planId: string;
  pageIndex: number;
  draft: PageDraft;
  stagedPage: StagedGeneratedPage;
  willIllustrate: boolean;
  continuityTags: string[];
}): Promise<GeneratedPagePublicationResult> {
  if (options.willIllustrate) {
    const keeperToken = pageIllustrationKeeperToken({
      projectId: options.projectId,
      pageId: options.stagedPage.id,
      ...options.draft,
      revision: options.stagedPage.revision
    });
    const imageJob = await enqueueWorkerJob({
      projectId: options.projectId,
      type: "GENERATE_IMAGE",
      payload: {
        pageId: options.stagedPage.id,
        planId: options.planId,
        prompt: options.draft.imagePrompt,
        keeperToken
      },
      dedupeKey: `generate-image:${options.stagedPage.id}:${options.planId}:${options.stagedPage.revision}:${keeperToken}`
    });
    if (!imageJob) {
      return "enqueue-declined";
    }
  }

  const completedVersion = nextPageVersion(options.stagedPage.updatedAt);
  const complete = async (client: Pick<Prisma.TransactionClient, "page" | "continuityNote">) => {
    const claimed = await client.page.updateMany({
      where: {
        id: options.stagedPage.id,
        // Structural ordering deliberately preserves updatedAt so an image job
        // for the same stable page can survive a move. Continuity scopes and
        // their numeric tags do not: they name the page's index at publication.
        // Keep that index in this completion claim so a move after staging
        // supersedes the stale note publication instead of committing page:N
        // facts under the page's former position.
        index: options.pageIndex,
        status: "GENERATING",
        updatedAt: options.stagedPage.updatedAt,
        title: options.draft.title,
        markdown: options.draft.markdown,
        summary: options.draft.summary,
        imagePrompt: options.draft.imagePrompt ?? null,
        revision: options.stagedPage.revision
      },
      data: { status: "COMPLETED", updatedAt: completedVersion }
    });
    if (claimed.count !== 1) {
      return false;
    }
    if (options.draft.continuityNotes.length > 0) {
      await client.continuityNote.createMany({
        data: options.draft.continuityNotes.map((body) => ({
          projectId: options.projectId,
          pageId: options.stagedPage.id,
          scope: pageScope(options.pageIndex),
          body,
          tags: options.continuityTags
        }))
      });
    }
    return true;
  };
  const completed =
    options.draft.continuityNotes.length > 0
      ? await prisma.$transaction((tx) => complete(tx))
      : await complete(prisma);
  return completed ? "completed" : "superseded";
}
