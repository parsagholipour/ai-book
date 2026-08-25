import { getProjectOrThrow, invalidateProjectExports, strategyForInput } from "../generation/bookHelpers.js";
import {
  characterReferencePromptInstruction,
  imageAssetPlanId,
  imageCapabilities,
  librarySnapshotForSheet,
  resolveLibraryPortraitSeed,
  selectReferenceImagePaths,
  toWorkerImageAsset,
  type CharacterReferenceSelection
} from "../generation/characterReferences.js";
import {
  imageAltFromSubject,
  markdownWithAppendedImage,
  markdownWithReplacedImage
} from "../generation/imageMarkdown.js";
import {
  claimAppliedEditPublication,
  restoreEditProjectStatus
} from "../generation/editProjectStatus.js";
import { claimEditOperationForDelivery } from "../generation/editOperationDelivery.js";
import { inputForPlanVersion } from "../generation/projectInput.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { maybeEnqueueCompile } from "../runtime/dispatch.js";
import { advanceJobStep } from "../runtime/jobLifecycle.js";
import {
  bookPlanSchema,
  createProviders,
  jsonRecord,
  libraryCharactersFromMediaSettings,
  markdownLabels,
  matchLibraryCharacter,
  optimizeImageForStorage,
  preEditProjectStatus,
  publicAssetUrl,
  type BookPlan,
  type ImageAdapter,
  type SettledProjectStatus
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import type { ApplyBookEditJob } from "../runtime/jobPayloads.js";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The `apply-book-edit` image fork: render one chat-requested illustration.
 * A new picture is appended to a saved page's markdown — never a new Page row,
 * which would trip EMPTY_PAGE / PAGE_COUNT_MISMATCH and re-partition the
 * audiobook. A replacement of a generation ImageAsset updates that row in
 * place (compile and the in-app preview both read `page.images[0]`); a
 * replacement of a chat-added line swaps the markdown marker. Undo restores
 * the snapshot, and for an asset replace the previous path/prompt too.
 *
 * Failures THROW. A bundled page illustration may be swallowed because the page
 * it decorates is already paid for; this image is the whole purchase, so the
 * attempt settlement must refund it. `StopRequestedError` propagates untouched.
 */

/** The queue-time contract; the worker re-validates the target against the live book. */
export type ImageInsertionPayload = {
  subject: string;
  placement: "end_of_book" | "page";
  targetPageIndex: number;
  /**
   * Present for a replacement: the `chat-image-<operationId>` marker of the
   * earlier insertion whose line the new image takes over, in place. When the
   * marker is gone by delivery time (undone or hand-deleted in the race
   * window), the new image is appended instead — the old one is already gone,
   * so appending still matches what the reader asked for.
   */
  replaceMarker?: string;
  /**
   * Present when replacing a generation-time interior illustration. The
   * worker updates that ImageAsset in place and does not append a markdown
   * line — compile would otherwise print both.
   */
  replaceAssetId?: string;
};

/**
 * The insertion as the operation's own classifier holds it.
 *
 * `applyBookEdit` forks here on the operation's `kind`, never on this payload
 * field, so a job whose `imageInsertion` was rebuilt away still arrives — and
 * the Apply wrote the resolved intent onto the classifier in the same
 * transaction that created the row. The intent's `imageEdit` is the queue-time
 * contract in a different shape: its `replace` names the old picture by asset
 * id, or by the marker its markdown line carries, or by the operation id that
 * marker is built from, which is `queueChatAddImage`'s own rule
 * (`apps/api/src/mobile/addImageOperations.ts`).
 *
 * Only the *subject* is irreplaceable. Every other field is re-validated against
 * the live book below, so a stale one costs nothing; without a subject there is
 * no picture to draw and no honest way to guess one, and `null` says so.
 */
export function insertionFromClassifier(classifier: unknown): ImageInsertionPayload | null {
  const edit = jsonRecord(jsonRecord(classifier).imageEdit);
  const subject = typeof edit.subject === "string" ? edit.subject.trim() : "";
  if (!subject) {
    return null;
  }
  const pageIndex = typeof edit.pageIndex === "number" ? edit.pageIndex : null;
  const placement = edit.placement === "page" && pageIndex !== null ? "page" : "end_of_book";
  const replace = jsonRecord(edit.replace);
  const replaceAssetId = typeof replace.assetId === "string" && replace.assetId ? replace.assetId : null;
  const replaceMarker =
    typeof replace.marker === "string" && replace.marker
      ? replace.marker
      : typeof replace.operationId === "string" && replace.operationId
        ? `chat-image-${replace.operationId}`
        : null;
  return {
    subject,
    placement,
    // Read only for `placement: "page"` — an `end_of_book` insertion re-resolves
    // the book's last page, which is what that placement means.
    targetPageIndex: pageIndex ?? 0,
    ...(replaceAssetId ? { replaceAssetId } : replaceMarker ? { replaceMarker } : {})
  };
}

export async function applyImageInsertion(job: ApplyBookEditJob, operation: { status: string; classifier: unknown }) {
  const { projectId, operationId, request, planId, imageInsertion, generationJobId } = job.data;
  // Read once: the project has already been committed as EDITING, including on
  // redelivery. The payload stamp is the only surviving settled status.
  const fallbackStatus = preEditProjectStatus(job.data);

  if (operation.status === "APPLIED") {
    await replayAppliedInsertion(projectId, operationId, planId, fallbackStatus);
    return;
  }

  const delivery = await claimEditOperationForDelivery(operationId);
  if (delivery.outcome === "replay") {
    // A previous delivery committed the append and crashed before its durable
    // COMPLETED write; the page already holds this operation's image line.
    await replayAppliedInsertion(projectId, operationId, planId, fallbackStatus);
    return;
  }
  if (delivery.outcome === "settled") {
    // CANCELED (or deleted): another actor settled this operation; whatever it
    // decided stands.
    return;
  }
  // The payload's copy first, the classifier's second, the same way the
  // structural and layout forks read theirs. Asked *after* the two settle checks
  // above — a redelivery of an APPLIED insertion still owes the book its export
  // refresh, and the image it is replaying is already on the page whatever the
  // payload now says — and *before* the EDITING write, so a job that cannot run
  // does not drag a finished book into a status only a compile leaves.
  const insertion = imageInsertion ?? insertionFromClassifier(operation.classifier);
  if (!insertion) {
    // Nothing to draw. Thrown rather than settled, which is this handler's rule
    // for every other unusable target: the reader bought exactly this image, and
    // only the failure path hands the credits back — `markFailed` fails the
    // operation through the attempt, refunds the charge and the free-tier image
    // slot with it, and restores the project out of EDITING. Settling it APPLIED
    // would keep the money for a picture the book never gets.
    throw new Error("This illustration edit carries no subject to draw");
  }
  await prisma.project.update({ where: { id: projectId }, data: { status: "EDITING" } });
  await advanceJobStep(generationJobId, "prepare", 20, "Preparing the illustration");

  const [project, payloadPlanVersion] = await Promise.all([
    getProjectOrThrow(projectId),
    planId ? prisma.planVersion.findUnique({ where: { id: planId } }) : null
  ]);
  const planVersion =
    payloadPlanVersion ??
    (project.currentPlanId ? await prisma.planVersion.findUnique({ where: { id: project.currentPlanId } }) : null);
  if (!planVersion) {
    throw new Error("Current plan not found");
  }
  const input = inputForPlanVersion(project, planVersion.inputSnapshot);
  const plan = bookPlanSchema.parse(planVersion.planningPackage);
  const strategy = strategyForInput(input);
  const providers = createLoggedProviders(job, createProviders(config, input), input);

  // Re-validate the target against the live book: the quote was made against a
  // book the reader can edit. A replacement follows its marker to whatever page
  // holds it now; "end of the book" re-resolves to whatever the last page is
  // now; an explicit page that vanished fails cleanly and the attempt
  // settlement refunds the charge.
  const replaceMarker = typeof insertion.replaceMarker === "string" ? insertion.replaceMarker : undefined;
  const replaceAssetId = typeof insertion.replaceAssetId === "string" ? insertion.replaceAssetId : undefined;
  const replaceAsset = replaceAssetId
    ? await prisma.imageAsset.findFirst({
        where: { id: replaceAssetId, projectId, type: { in: ["SCENE_ILLUSTRATION", "DIAGRAM"] } },
        select: { id: true, path: true, prompt: true, page: true }
      })
    : null;
  if (replaceAssetId && !replaceAsset?.page) {
    throw new Error("The illustration to replace is no longer in this book");
  }
  const markerPage = replaceMarker
    ? await prisma.page.findFirst({ where: { projectId, markdown: { contains: replaceMarker } } })
    : null;
  const targetPage =
    replaceAsset?.page ??
    markerPage ??
    (insertion.placement === "end_of_book"
      ? await prisma.page.findFirst({ where: { projectId }, orderBy: { index: "desc" } })
      : await prisma.page.findFirst({ where: { projectId, index: insertion.targetPageIndex } }));
  if (!targetPage) {
    throw new Error(
      insertion.placement === "end_of_book"
        ? "This book has no pages to add an illustration to"
        : `Page ${insertion.targetPageIndex} no longer exists, so the illustration has nowhere to go`
    );
  }

  await advanceJobStep(generationJobId, "snapshot", 35, `Snapshotting page ${targetPage.index}`);
  await advanceJobStep(generationJobId, "apply", 45, `Rendering an illustration for page ${targetPage.index}`, {
    pageIndex: targetPage.index
  });
  const selection = await insertionReferenceSelection({
    projectId,
    planVersionId: planVersion.id,
    subject: insertion.subject,
    input,
    plan,
    image: providers.image,
    projectUserId: project.userId ?? null
  });
  const trimmedRequest = request?.trim() ?? "";
  const imagePrompt = [
    `Create one interior book illustration depicting: ${insertion.subject}.`,
    // The stored request carries the reader's wording and any appended library
    // character sheets (`requestWithCharacterContext`) — the only channel the
    // appearance rules travel through to this model.
    trimmedRequest && trimmedRequest !== insertion.subject.trim()
      ? `The reader's request, including any character notes:\n${trimmedRequest}`
      : "",
    characterReferencePromptInstruction(selection),
    `Global visual style: ${plan.illustrationPlan.globalStyle}`,
    `Continuity rules: ${plan.illustrationPlan.pageRules.join(" ")}`
  ]
    .filter(Boolean)
    .join("\n");
  // No try/catch: a failed render must fail the job (and refund through the
  // attempt settlement). The FallbackImageAdapter chain inside the logged
  // provider is the resilience budget, exactly as for generated pages.
  const image = await strategy.generateImageBytes({
    image: providers.image,
    prompt: imagePrompt,
    projectId,
    pageId: targetPage.id,
    referenceImagePaths: selection.paths
  });

  await advanceJobStep(generationJobId, "apply", 70, `Storing the illustration for page ${targetPage.index}`, {
    pageIndex: targetPage.index
  });
  const optimizedImage = await optimizeImageForStorage({ bytes: image.bytes, mimeType: image.mimeType });
  // The marker is the operationId prefix, shared by every delivery of this
  // operation, so the belt check below recognises any delivery's line. The
  // filename is delivery-unique on top of it: two stalled deliveries render
  // *different* images, and with one deterministic name the loser's writeFile
  // silently swapped the artwork under the winner's published markdown.
  // A losing delivery's file is a harmless orphan instead, removed below.
  const marker = `chat-image-${operationId}`;
  const filename = replaceAsset
    ? `page-${targetPage.index}-${operationId}-${randomUUID()}.${optimizedImage.extension}`
    : `${marker}-${randomUUID()}.${optimizedImage.extension}`;
  const projectImageDir = join(config.IMAGE_STORAGE_DIR, projectId);
  const imagePath = join(projectImageDir, filename);
  await mkdir(projectImageDir, { recursive: true });
  await writeFile(imagePath, optimizedImage.bytes);

  const alt = imageAltFromSubject(insertion.subject, markdownLabels(project.language).illustration);
  const imageLine = `![${alt}](/assets/images/${projectId}/${filename})`;
  const publicPath = publicAssetUrl(
    config.PUBLIC_API_URL ?? "http://localhost:4001",
    `/assets/images/${projectId}/${filename}`
  );
  // One transaction holds everything that must live or die with the APPLIED
  // claim: the page re-read, the append, the undo snapshot, and the
  // contentRevision bump. `markActive` deliberately re-claims ACTIVE rows for
  // stalled deliveries, so two deliveries of this job can run concurrently —
  // the conditional claim makes exactly one of them append, and the loser
  // writes nothing at all.
  let applied: boolean;
  try {
    applied = await prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: projectId },
        data: { contentRevision: { increment: 0 } }
      });
      const claimed = await tx.bookEditOperation.updateMany({
        where: { id: operationId, status: { in: ["QUEUED", "ACTIVE"] } },
        data: { automaticRetryCount: { increment: 0 } }
      });
      if (claimed.count !== 1) {
        return false;
      }
      const current = await tx.page.findUnique({ where: { id: targetPage.id } });
      if (!current) {
        throw new Error(`Page ${targetPage.index} disappeared while the illustration was being added`);
      }
      if (replaceAsset) {
        return applyAssetReplacementInTx(tx as unknown as InsertionTransaction, {
          operationId,
          projectId,
          current,
          replaceAsset,
          subject: insertion.subject,
          publicPath,
          storedPrompt: imagePrompt
        });
      }
      if (current.markdown.includes(marker)) {
        // Belt over the claim: this operation's line is already on the page, so
        // appending again would double the image — and the delivery that
        // appended already wrote the undo snapshot. A second snapshot here
        // would hand undo a markdownBefore that already holds the image it
        // exists to remove.
        return true;
      }
      // A replacement swaps the old marker's line in place, keeping its spot;
      // with the line gone by now, appending is the honest fallback (the old
      // image is already gone, so the net result is what the reader asked for)
      // and the operation records that the swap became an add.
      const replacedMarkdown = replaceMarker ? markdownWithReplacedImage(current.markdown, replaceMarker, imageLine) : null;
      if (replaceMarker && replacedMarkdown === null) {
        const row = await tx.bookEditOperation.findUnique({ where: { id: operationId }, select: { classifier: true } });
        await tx.bookEditOperation.update({
          where: { id: operationId },
          data: {
            classifier: {
              ...(row && typeof row.classifier === "object" && row.classifier !== null ? row.classifier : {}),
              replacedMissing: true
            }
          }
        });
      }
      // The revision bump is load-bearing: manual Edit Mode detects conflicts
      // solely by revision, so without it a stale save would silently delete the
      // paid image.
      const saved = await tx.page.update({
        where: { id: current.id },
        data: {
          markdown: replacedMarkdown ?? markdownWithAppendedImage(current.markdown, imageLine),
          revision: { increment: 1 }
        }
      });
      // Before-fields from the in-tx read: a snapshot created outside this
      // transaction could capture a concurrent delivery's append as "before"
      // and make undo restore the very image it removes.
      await tx.pageEditSnapshot.create({
        data: {
          projectId,
          pageId: current.id,
          operationId,
          pageIndex: current.index,
          titleBefore: current.title,
          markdownBefore: current.markdown,
          summaryBefore: current.summary,
          revisionBefore: current.revision,
          ...(current.storyDelta != null ? { storyDeltaBefore: current.storyDelta as Prisma.InputJsonValue } : {}),
          titleAfter: saved.title,
          markdownAfter: saved.markdown,
          summaryAfter: saved.summary,
          revisionAfter: saved.revision
        }
      });
      // In the same transaction as the append: a throw between a committed
      // append and this bump used to reach markFailed, which refunds the
      // charge and the free-tier image slot while the image is durably on the
      // page.
      const published = await tx.project.update({
        where: { id: projectId },
        data: { contentRevision: { increment: 1 } },
        select: { contentRevision: true }
      });
      await tx.bookEditOperation.update({
        where: { id: operationId },
        data: {
          status: "APPLIED",
          publicationRevision: published.contentRevision,
          affectedPageIndexes: [targetPage.index],
          appliedAt: new Date()
        }
      });
      return true;
    });
  } catch (error) {
    // The file this delivery wrote is referenced by nothing — its unique name
    // only enters the page through its own committed append.
    await removeInsertionImage(imagePath);
    throw error;
  }
  if (!applied) {
    // Another delivery settled this operation after both deliveries passed the
    // ACTIVE fence. This delivery has already written EDITING, so an APPLIED
    // winner's idempotent export/status tail must be replayed: the winner may
    // have restored the stamped status before this loser wrote EDITING.
    const settled = await prisma.bookEditOperation.findUnique({ where: { id: operationId } });
    if (settled?.status === "APPLIED") {
      await replayAppliedInsertion(projectId, operationId, planId, fallbackStatus);
    } else {
      // CANCELED (or any non-APPLIED outcome) stands. This delivery's unique
      // file is unreferenced because it lost the mutation claim.
      await removeInsertionImage(imagePath);
    }
    return;
  }

  // Nothing after the committed append may throw: any failure past this point
  // reaches markFailed, refunding the charge and the quota slot for an image
  // that is durably on the page. Progress is cosmetic, the export invalidation
  // swallows per-file errors, and finishWithCompile catches its own enqueue
  // failures.
  try {
    await advanceJobStep(generationJobId, "export", 85, "Refreshing exports");
  } catch {
    // Progress display only — even a stop request may not fail a spent charge.
  }
  await refreshExports(projectId, planVersion.id, operationId, fallbackStatus);
}

/**
 * A previous delivery committed the append — APPLIED, the page write, the undo
 * snapshot and the contentRevision bump share one transaction — and crashed
 * before its durable COMPLETED write. Only the idempotent export refresh is
 * replayed; bumping contentRevision again would order a second compile of a
 * manuscript the appending transaction already versioned.
 *
 * If the plan disappeared after the append became durable, there is nothing to
 * compile. Restore the queue-time settled status instead of sending a paid,
 * already-applied image through failure settlement.
 */
async function replayAppliedInsertion(
  projectId: string,
  operationId: string,
  planId: string | undefined,
  fallbackStatus: SettledProjectStatus
): Promise<void> {
  const project = await getProjectOrThrow(projectId);
  const compilePlanId = planId ?? project.currentPlanId;
  if (!compilePlanId) {
    console.error(
      `Cannot replay APPLIED image insertion ${operationId} for project ${projectId}: no plan version is available`
    );
    await restoreInsertionStatus(projectId, operationId, fallbackStatus);
    return;
  }
  await refreshExports(projectId, compilePlanId, operationId, fallbackStatus);
}

/** The shared success tail: rebuild the exports from what the page now says. */
async function refreshExports(
  projectId: string,
  planVersionId: string,
  operationId: string,
  fallbackStatus: SettledProjectStatus
): Promise<void> {
  const claimed = await prisma.$transaction(async (tx) => {
    if (!(await claimAppliedEditPublication(tx, projectId, operationId, fallbackStatus))) {
      return false;
    }
    await invalidateProjectExports(projectId);
    return true;
  });
  if (!claimed) return;
  await finishWithCompile(projectId, planVersionId, operationId, fallbackStatus);
}

/** Best-effort: an orphaned image file is storage noise, never a failure. */
async function removeInsertionImage(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Including ENOENT: the other end of the race working is not an error.
  }
}

type InsertionTransaction = {
  imageAsset: {
    findUnique: (args: { where: { id: string } }) => Promise<{ id: string; path: string; prompt: string } | null>;
    update: (args: { where: { id: string }; data: { path: string; prompt: string } }) => Promise<unknown>;
  };
  bookEditOperation: {
    findUnique: (args: { where: { id: string }; select: { classifier: true } }) => Promise<{ classifier: unknown } | null>;
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
  };
  page: {
    update: (args: {
      where: { id: string };
      data: { imagePrompt: string; revision: { increment: number } };
    }) => Promise<{
      id: string;
      index: number;
      title: string;
      markdown: string;
      summary: string;
      revision: number;
    }>;
  };
  pageEditSnapshot: {
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
  };
  project: {
    update: (args: {
      where: { id: string };
      data: { contentRevision: { increment: number } };
      select: { contentRevision: true };
    }) => Promise<{ contentRevision: number }>;
  };
};

/**
 * Swap a generation illustration in place: new file, same ImageAsset id, no
 * markdown line. The previous path/prompt ride the classifier so undo can
 * put the old picture back without the old bytes having been overwritten.
 */
async function applyAssetReplacementInTx(
  tx: InsertionTransaction,
  options: {
    operationId: string;
    projectId: string;
    current: {
      id: string;
      index: number;
      title: string;
      markdown: string;
      summary: string;
      revision: number;
      imagePrompt?: string | null;
      storyDelta?: unknown;
    };
    replaceAsset: { id: string; path: string; prompt: string };
    subject: string;
    publicPath: string;
    storedPrompt: string;
  }
): Promise<boolean> {
  const live = await tx.imageAsset.findUnique({ where: { id: options.replaceAsset.id } });
  if (!live) {
    throw new Error("The illustration to replace is no longer in this book");
  }
  if (live.path.includes(options.operationId)) {
    return true;
  }
  const row = await tx.bookEditOperation.findUnique({
    where: { id: options.operationId },
    select: { classifier: true }
  });
  const previousImagePrompt = options.current.imagePrompt;
  await tx.bookEditOperation.update({
    where: { id: options.operationId },
    data: {
      classifier: {
        ...(row && typeof row.classifier === "object" && row.classifier !== null ? row.classifier : {}),
        previousAsset: {
          id: live.id,
          pageId: options.current.id,
          path: live.path,
          afterPath: options.publicPath,
          prompt: live.prompt,
          ...(typeof previousImagePrompt === "string" || previousImagePrompt === null
            ? { imagePrompt: previousImagePrompt }
            : {})
        }
      }
    }
  });
  await tx.imageAsset.update({
    where: { id: live.id },
    data: { path: options.publicPath, prompt: options.storedPrompt }
  });
  const saved = await tx.page.update({
    where: { id: options.current.id },
    data: { imagePrompt: options.subject, revision: { increment: 1 } }
  });
  await tx.pageEditSnapshot.create({
    data: {
      projectId: options.projectId,
      pageId: options.current.id,
      operationId: options.operationId,
      pageIndex: options.current.index,
      titleBefore: options.current.title,
      markdownBefore: options.current.markdown,
      summaryBefore: options.current.summary,
      revisionBefore: options.current.revision,
      ...(options.current.storyDelta != null
        ? { storyDeltaBefore: options.current.storyDelta as Prisma.InputJsonValue }
        : {}),
      titleAfter: saved.title,
      markdownAfter: saved.markdown,
      summaryAfter: saved.summary,
      revisionAfter: saved.revision
    }
  });
  const published = await tx.project.update({
    where: { id: options.projectId },
    data: { contentRevision: { increment: 1 } },
    select: { contentRevision: true }
  });
  await tx.bookEditOperation.update({
    where: { id: options.operationId },
    data: {
      status: "APPLIED",
      publicationRevision: published.contentRevision,
      affectedPageIndexes: [options.current.index],
      appliedAt: new Date()
    }
  });
  return true;
}

/**
 * The applyBookEdit success tail: queue the recompile, and on `not-ready` (or an
 * enqueue outage) hand the book to the on-demand export repair lane — a settled
 * status with missing files is exactly the state the app's status stream rebuilds,
 * while leaving EDITING would discard this handler's immediate handoff and
 * wait for the delayed stranded-generation sweep's grace period.
 *
 * `withoutQualityVerdict`, because the appended image line moved the markdown
 * without touching prose: the model-QA findings the book earned still describe
 * every page, and this recompile's deterministic-only report must not replace
 * them.
 */
async function finishWithCompile(
  projectId: string,
  planVersionId: string,
  operationId: string,
  fallbackStatus: SettledProjectStatus
): Promise<void> {
  let dispatched: Awaited<ReturnType<typeof maybeEnqueueCompile>>;
  try {
    dispatched = await maybeEnqueueCompile(projectId, planVersionId, {
      skipFinalReview: true,
      withoutQualityVerdict: true
    });
  } catch (error) {
    console.error(`Failed to enqueue the export refresh for illustrated project ${projectId}:`, error);
    dispatched = "not-ready";
  }
  if (dispatched === "not-ready") {
    await restoreInsertionStatus(projectId, operationId, fallbackStatus);
  }
}

async function restoreInsertionStatus(
  projectId: string,
  operationId: string,
  fallbackStatus: SettledProjectStatus
): Promise<void> {
  await prisma
    .$transaction((tx) => restoreEditProjectStatus(tx, projectId, operationId, fallbackStatus))
    .catch(() => undefined);
}

/**
 * Reference images for a one-off insertion.
 *
 * Never `ensureCharacterReferenceAssets`: it filters sheets by
 * `metadata.planId` and would delete and re-render the whole cast after any
 * continuation or replan — one unbilled image call per character inside a job
 * quoted at one image — and for a non-illustrated book it returns nothing,
 * dropping library faces with it. Existing sheets are read as they are: the
 * current plan's, falling back to any earlier plan's, which still show the
 * same cast.
 */
async function insertionReferenceSelection(options: {
  projectId: string;
  planVersionId: string;
  subject: string;
  input: ReturnType<typeof inputForPlanVersion>;
  plan: BookPlan;
  image: ImageAdapter;
  projectUserId: string | null;
}): Promise<CharacterReferenceSelection> {
  const allSheets = await prisma.imageAsset.findMany({
    where: { projectId: options.projectId, type: "CHARACTER_REFERENCE" },
    orderBy: { createdAt: "asc" }
  });
  const currentPlanSheets = allSheets.filter((asset) => imageAssetPlanId(asset.metadata) === options.planVersionId);
  const sheets = currentPlanSheets.length > 0 ? currentPlanSheets : allSheets;
  const selection = await selectReferenceImagePaths({
    input: options.input,
    plan: options.plan,
    assets: sheets.map(toWorkerImageAsset),
    projectId: options.projectId,
    image: options.image,
    context: options.subject
  });
  const budget = imageCapabilities(options.image).maxReferenceImages - selection.paths.length;
  if (budget <= 0) {
    return selection;
  }
  // A saved character named in the subject whose book has no sheet for them —
  // a text-only book has none at all — still gets their portrait attached, or
  // the reader's own character would be drawn from prose alone. The seeding
  // path's ownership trio (`resolveLibraryPortraitSeed`) is the only way a
  // portrait is ever read off a stored snapshot.
  const snapshots = libraryCharactersFromMediaSettings(options.input.mediaSettings);
  const match = matchLibraryCharacter(options.subject, snapshots);
  if (!match || sheets.some((asset) => librarySnapshotForSheet(asset.metadata, [match]) !== null)) {
    return selection;
  }
  const outcome = await resolveLibraryPortraitSeed(match, options.projectUserId);
  if (!outcome.seeded) {
    return selection;
  }
  return {
    paths: [...selection.paths, outcome.seed.path],
    libraryFaceNames: [...selection.libraryFaceNames, match.name]
  };
}

// The page-markdown image helpers moved to `generation/imageMarkdown.ts` when
// the layout handler needed them too — a handler may not import a sibling
// handler. Re-exported here because they are this module's long-standing
// public surface. Their tests are colocated with them
// (`generation/imageMarkdown.test.ts`); they were in this file's suite until it
// reached its size budget, and they need none of its mock harness.
export {
  extractMarkdownImageLine,
  imageAltFromSubject,
  markdownWithAppendedImage,
  markdownWithMovedImage,
  markdownWithPrependedImage,
  markdownWithRemovedImage,
  markdownWithReplacedImage
} from "../generation/imageMarkdown.js";
