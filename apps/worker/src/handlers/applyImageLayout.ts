import { getProjectOrThrow, invalidateProjectExports } from "../generation/bookHelpers.js";
import { maybeEnqueueCompile } from "../runtime/dispatch.js";
import { advanceJobStep } from "../runtime/jobLifecycle.js";
import {
  extractMarkdownImageLine,
  imageAltFromSubject,
  markdownWithAppendedImage,
  markdownWithRemovedImage
} from "./applyImageInsertion.js";
import { markdownLabels } from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { Job } from "bullmq";

/**
 * The `apply-book-edit` layout fork: move or remove an existing illustration
 * with no generation. A chat-added line is cut from its page (and appended on
 * a move). A generation ImageAsset is unlinked or reassigned; if the dest page
 * already has a hero, that hero is demoted to an in-body markdown line so it
 * is not lost. Undo restores `pageId` from the classifier plus the snapshots.
 */

const INTERIOR_ASSET_TYPES = ["SCENE_ILLUSTRATION", "DIAGRAM"] as const;

export type ImageLayoutPayload = {
  action: "move" | "remove";
  source: {
    pageIndex: number;
    replaceMarker?: string;
    replaceAssetId?: string;
  };
  dest?: {
    placement: "end_of_book" | "page";
    pageIndex: number;
  };
};

type PageRow = {
  id: string;
  index: number;
  title: string;
  markdown: string;
  summary: string;
  revision: number;
  imagePrompt: string | null;
};

class LayoutUnavailableError extends Error {
  constructor() {
    super("The illustration to move or remove is no longer in this book");
    this.name = "LayoutUnavailableError";
  }
}

export async function applyImageLayout(job: Job, operation: { status: string; classifier: unknown }) {
  const { projectId, operationId, planId, imageLayout } = job.data as {
    projectId: string;
    operationId: string;
    planId?: string;
    imageLayout: ImageLayoutPayload;
  };
  const generationJobId = job.data.generationJobId as string | undefined;

  if (operation.status === "APPLIED") {
    await replayAppliedLayout(projectId, planId, operation.classifier);
    return;
  }

  const activated = await prisma.bookEditOperation.updateMany({
    where: { id: operationId, status: { notIn: ["APPLIED", "CANCELED"] } },
    data: { status: "ACTIVE" }
  });
  if (activated.count === 0) {
    const settled = await prisma.bookEditOperation.findUnique({ where: { id: operationId } });
    if (settled?.status === "APPLIED") {
      await replayAppliedLayout(projectId, planId, settled.classifier);
    }
    return;
  }
  const prior = await prisma.project.findUnique({
    where: { id: projectId },
    select: { status: true, currentPlanId: true }
  });
  const fallbackStatus = prior?.status === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "COMPLETE";
  await prisma.project.update({ where: { id: projectId }, data: { status: "EDITING" } });
  await advanceJobStep(generationJobId, "prepare", 20, "Preparing the illustration change");

  const source = await resolveLayoutSource(projectId, imageLayout.source);
  const dest =
    imageLayout.action === "move" ? await resolveLayoutDest(projectId, imageLayout.dest) : null;
  if (!source || (imageLayout.action === "move" && !dest) || (dest && dest.id === source.page.id)) {
    await markLayoutSkipped(projectId, operationId, fallbackStatus);
    return;
  }

  await advanceJobStep(generationJobId, "snapshot", 35, `Snapshotting page ${source.page.index}`);
  await advanceJobStep(
    generationJobId,
    "apply",
    50,
    imageLayout.action === "move"
      ? `Moving the illustration to page ${dest!.index}`
      : `Removing the illustration on page ${source.page.index}`
  );

  let applied: boolean;
  try {
    applied = await prisma.$transaction(async (tx) => {
      const claimed = await tx.bookEditOperation.updateMany({
        where: { id: operationId, status: { in: ["QUEUED", "ACTIVE"] } },
        data: {
          status: "APPLIED",
          affectedPageIndexes:
            dest && dest.id !== source.page.id ? [source.page.index, dest.index] : [source.page.index],
          appliedAt: new Date()
        }
      });
      if (claimed.count !== 1) {
        return false;
      }
      const currentSource = await tx.page.findUnique({ where: { id: source.page.id } });
      if (!currentSource) {
        throw new Error(`Page ${source.page.index} disappeared while the illustration was being changed`);
      }
      let wrote: boolean;
      if (source.kind === "asset") {
        const language = (await tx.project.findUnique({ where: { id: projectId }, select: { language: true } }))
          ?.language;
        wrote = await applyAssetLayoutInTx(tx, {
          operationId,
          projectId,
          action: imageLayout.action,
          source: currentSource,
          assetId: source.assetId,
          dest,
          ...(language ? { language } : {})
        });
      } else {
        wrote = await applyMarkdownLayoutInTx(tx, {
          operationId,
          projectId,
          action: imageLayout.action,
          source: currentSource,
          marker: source.marker,
          dest
        });
      }
      if (!wrote) {
        throw new LayoutUnavailableError();
      }
      await tx.project.update({ where: { id: projectId }, data: { contentRevision: { increment: 1 } } });
      return true;
    });
  } catch (error) {
    if (error instanceof LayoutUnavailableError) {
      await markLayoutSkipped(projectId, operationId, fallbackStatus);
      return;
    }
    throw error;
  }

  if (!applied) {
    return;
  }
  try {
    await advanceJobStep(generationJobId, "export", 85, "Refreshing exports");
  } catch {
    // Progress display only.
  }
  const compilePlanId = planId ?? prior?.currentPlanId;
  if (!compilePlanId) {
    await prisma.project
      .updateMany({ where: { id: projectId, status: "EDITING" }, data: { status: fallbackStatus } })
      .catch(() => undefined);
    return;
  }
  await refreshExports(projectId, compilePlanId, fallbackStatus);
}

async function resolveLayoutSource(
  projectId: string,
  source: ImageLayoutPayload["source"]
): Promise<
  | { kind: "asset"; assetId: string; page: PageRow }
  | { kind: "markdown"; marker: string; page: PageRow }
  | null
> {
  if (source.replaceAssetId) {
    const asset = await prisma.imageAsset.findFirst({
      where: { id: source.replaceAssetId, projectId, type: { in: [...INTERIOR_ASSET_TYPES] } },
      select: { id: true, page: true }
    });
    return asset?.page ? { kind: "asset", assetId: asset.id, page: asset.page as PageRow } : null;
  }
  const marker = source.replaceMarker;
  if (!marker) {
    return null;
  }
  const page = await prisma.page.findFirst({
    where: { projectId, markdown: { contains: marker } }
  });
  return page ? { kind: "markdown", marker, page: page as PageRow } : null;
}

async function resolveLayoutDest(
  projectId: string,
  dest: ImageLayoutPayload["dest"] | undefined
): Promise<PageRow | null> {
  if (!dest) {
    return null;
  }
  if (dest.placement === "end_of_book") {
    return (await prisma.page.findFirst({
      where: { projectId },
      orderBy: { index: "desc" }
    })) as PageRow | null;
  }
  return (await prisma.page.findFirst({
    where: { projectId, index: dest.pageIndex }
  })) as PageRow | null;
}

async function markLayoutSkipped(
  projectId: string,
  operationId: string,
  fallbackStatus: "COMPLETE" | "REVIEW_REQUIRED"
): Promise<void> {
  const row = await prisma.bookEditOperation.findUnique({
    where: { id: operationId },
    select: { classifier: true }
  });
  await prisma.bookEditOperation.update({
    where: { id: operationId },
    data: {
      status: "APPLIED",
      appliedAt: new Date(),
      affectedPageIndexes: [],
      classifier: {
        ...(row && typeof row.classifier === "object" && row.classifier !== null ? row.classifier : {}),
        layoutMissing: true
      }
    }
  });
  await prisma.project.updateMany({
    where: { id: projectId, status: "EDITING" },
    data: { status: fallbackStatus }
  });
}

async function applyMarkdownLayoutInTx(
  tx: Prisma.TransactionClient,
  options: {
    operationId: string;
    projectId: string;
    action: "move" | "remove";
    source: PageRow;
    marker: string;
    dest: PageRow | null;
  }
): Promise<boolean> {
  const line = extractMarkdownImageLine(options.source.markdown, options.marker);
  const removed = markdownWithRemovedImage(options.source.markdown, options.marker);
  const hasSourceLine = Boolean(line && removed !== null);

  if (options.action === "move" && options.dest) {
    const currentDest = await tx.page.findUnique({ where: { id: options.dest.id } });
    if (!currentDest) {
      throw new Error(`Page ${options.dest.index} disappeared while the illustration was being moved`);
    }
    const destHas = currentDest.markdown.includes(options.marker);
    if (!hasSourceLine) {
      return false;
    }
    if (!destHas && line) {
      const savedDest = await tx.page.update({
        where: { id: currentDest.id },
        data: { markdown: markdownWithAppendedImage(currentDest.markdown, line), revision: { increment: 1 } }
      });
      await writeSnapshot(tx, {
        projectId: options.projectId,
        operationId: options.operationId,
        before: currentDest,
        after: savedDest
      });
    }
    const savedSource = await tx.page.update({
      where: { id: options.source.id },
      data: { markdown: removed!, revision: { increment: 1 } }
    });
    await writeSnapshot(tx, {
      projectId: options.projectId,
      operationId: options.operationId,
      before: options.source,
      after: savedSource
    });
    return true;
  }

  if (!hasSourceLine) {
    return false;
  }
  const savedSource = await tx.page.update({
    where: { id: options.source.id },
    data: { markdown: removed!, revision: { increment: 1 } }
  });
  await writeSnapshot(tx, {
    projectId: options.projectId,
    operationId: options.operationId,
    before: options.source,
    after: savedSource
  });
  return true;
}

async function applyAssetLayoutInTx(
  tx: Prisma.TransactionClient,
  options: {
    operationId: string;
    projectId: string;
    action: "move" | "remove";
    source: PageRow;
    assetId: string;
    dest: PageRow | null;
    language?: string | null;
  }
): Promise<boolean> {
  const live = await tx.imageAsset.findUnique({ where: { id: options.assetId } });
  if (!live) {
    return false;
  }
  const currentDest =
    options.action === "move" && options.dest ? await tx.page.findUnique({ where: { id: options.dest.id } } ) : null;
  if (options.action === "move" && !currentDest) {
    throw new Error("The destination page disappeared while the illustration was being moved");
  }

  const destHero =
    currentDest &&
    (await tx.imageAsset.findFirst({
      where: {
        projectId: options.projectId,
        pageId: currentDest.id,
        type: { in: [...INTERIOR_ASSET_TYPES] },
        NOT: { id: live.id }
      }
    }));

  const row = await tx.bookEditOperation.findUnique({
    where: { id: options.operationId },
    select: { classifier: true }
  });
  const previousImagePrompt = options.source.imagePrompt;
  await tx.bookEditOperation.update({
    where: { id: options.operationId },
    data: {
      classifier: {
        ...(row && typeof row.classifier === "object" && row.classifier !== null ? row.classifier : {}),
        previousAsset: {
          id: live.id,
          pageId: options.source.id,
          path: live.path,
          prompt: live.prompt,
          ...(typeof previousImagePrompt === "string" || previousImagePrompt === null
            ? { imagePrompt: previousImagePrompt }
            : {}),
          ...(currentDest
            ? {
                destPageId: currentDest.id,
                destImagePrompt: currentDest.imagePrompt
              }
            : {})
        },
        ...(destHero
          ? {
              demotedAsset: {
                id: destHero.id,
                pageId: currentDest!.id,
                path: destHero.path,
                prompt: destHero.prompt,
                imagePrompt: currentDest!.imagePrompt
              }
            }
          : {})
      }
    }
  });

  if (destHero && currentDest) {
    const src = assetsMarkdownSrc(destHero.path);
    const alt = imageAltFromSubject(destHero.prompt, markdownLabels(options.language ?? "en").illustration);
    const savedDest = await tx.page.update({
      where: { id: currentDest.id },
      data: {
        ...(src ? { markdown: markdownWithAppendedImage(currentDest.markdown, `![${alt}](${src})`) } : {}),
        imagePrompt: live.prompt,
        revision: { increment: 1 }
      }
    });
    await writeSnapshot(tx, {
      projectId: options.projectId,
      operationId: options.operationId,
      before: currentDest,
      after: savedDest
    });
    await tx.imageAsset.update({ where: { id: destHero.id }, data: { pageId: null } });
  } else if (currentDest) {
    const savedDest = await tx.page.update({
      where: { id: currentDest.id },
      data: { imagePrompt: live.prompt, revision: { increment: 1 } }
    });
    await writeSnapshot(tx, {
      projectId: options.projectId,
      operationId: options.operationId,
      before: currentDest,
      after: savedDest
    });
  }

  await tx.imageAsset.update({
    where: { id: live.id },
    data: { pageId: currentDest ? currentDest.id : null }
  });
  const savedSource = await tx.page.update({
    where: { id: options.source.id },
    data: { imagePrompt: null, revision: { increment: 1 } }
  });
  await writeSnapshot(tx, {
    projectId: options.projectId,
    operationId: options.operationId,
    before: options.source,
    after: savedSource
  });
  return true;
}

async function writeSnapshot(
  tx: Prisma.TransactionClient,
  options: { projectId: string; operationId: string; before: PageRow; after: PageRow }
): Promise<void> {
  await tx.pageEditSnapshot.create({
    data: {
      projectId: options.projectId,
      pageId: options.before.id,
      operationId: options.operationId,
      pageIndex: options.before.index,
      titleBefore: options.before.title,
      markdownBefore: options.before.markdown,
      summaryBefore: options.before.summary,
      revisionBefore: options.before.revision,
      titleAfter: options.after.title,
      markdownAfter: options.after.markdown,
      summaryAfter: options.after.summary,
      revisionAfter: options.after.revision
    }
  });
}

function assetsMarkdownSrc(path: string): string | null {
  if (path.startsWith("/assets/images/")) {
    return path.split(/[?#]/)[0] ?? null;
  }
  try {
    const url = new URL(path);
    if (url.pathname.startsWith("/assets/images/")) {
      return url.pathname;
    }
  } catch {
    const match = path.match(/\/assets\/images\/[^\s?#)]+/);
    return match?.[0] ?? null;
  }
  return null;
}

async function replayAppliedLayout(projectId: string, planId: string | undefined, classifier: unknown): Promise<void> {
  if (
    classifier &&
    typeof classifier === "object" &&
    classifier !== null &&
    (classifier as { layoutMissing?: unknown }).layoutMissing === true
  ) {
    return;
  }
  const project = await getProjectOrThrow(projectId);
  const compilePlanId = planId ?? project.currentPlanId;
  if (!compilePlanId) {
    return;
  }
  const fallbackStatus = project.status === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "COMPLETE";
  await refreshExports(projectId, compilePlanId, fallbackStatus);
}

async function refreshExports(
  projectId: string,
  planVersionId: string,
  fallbackStatus: "COMPLETE" | "REVIEW_REQUIRED"
): Promise<void> {
  await invalidateProjectExports(projectId);
  let dispatched: Awaited<ReturnType<typeof maybeEnqueueCompile>>;
  try {
    dispatched = await maybeEnqueueCompile(projectId, planVersionId, {
      skipFinalReview: true,
      withoutQualityVerdict: true
    });
  } catch (error) {
    console.error(`Failed to enqueue the export refresh for layout-edited project ${projectId}:`, error);
    dispatched = "not-ready";
  }
  if (dispatched === "not-ready") {
    await prisma.project
      .updateMany({ where: { id: projectId, status: "EDITING" }, data: { status: fallbackStatus } })
      .catch(() => undefined);
  }
}
