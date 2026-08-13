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
import { inputForPlanVersion } from "../generation/projectInput.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { maybeEnqueueCompile } from "../runtime/dispatch.js";
import { advanceJobStep } from "../runtime/jobLifecycle.js";
import {
  bookPlanSchema,
  createProviders,
  libraryCharactersFromMediaSettings,
  markdownLabels,
  matchLibraryCharacter,
  optimizeImageForStorage,
  unwrapWholePageMarkdownFence,
  type BookPlan,
  type ImageAdapter
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { Job } from "bullmq";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The `apply-book-edit` image fork: render one chat-requested illustration and
 * append it to a saved page's markdown. Never a new Page row — an image-only
 * page trips the EMPTY_PAGE and PAGE_COUNT_MISMATCH QA blockers and re-partitions
 * the audiobook — and never an ImageAsset row, so the markdown line is the single
 * source of truth and undo removes it with the snapshot restore.
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
};

export async function applyImageInsertion(job: Job, operation: { status: string }) {
  const { projectId, operationId, request, planId, imageInsertion } = job.data as {
    projectId: string;
    operationId: string;
    request: string;
    planId?: string;
    imageInsertion: ImageInsertionPayload;
  };
  const generationJobId = job.data.generationJobId as string | undefined;

  if (operation.status === "APPLIED") {
    await replayAppliedInsertion(projectId, planId);
    return;
  }

  // Conditional, so a stalled redelivery can never regress APPLIED back to
  // ACTIVE or revive a CANCELED operation. FAILED must still re-activate: the
  // paid /resume retry lane reuses the FAILED operation row.
  const activated = await prisma.bookEditOperation.updateMany({
    where: { id: operationId, status: { notIn: ["APPLIED", "CANCELED"] } },
    data: { status: "ACTIVE" }
  });
  if (activated.count === 0) {
    const settled = await prisma.bookEditOperation.findUnique({ where: { id: operationId } });
    if (settled?.status === "APPLIED") {
      // A previous delivery committed the append and crashed before its durable
      // COMPLETED write; the page already holds this operation's image line.
      await replayAppliedInsertion(projectId, planId);
    }
    // CANCELED (or deleted): another actor settled this operation; whatever it
    // decided stands.
    return;
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
  const replaceMarker = typeof imageInsertion.replaceMarker === "string" ? imageInsertion.replaceMarker : undefined;
  const markerPage = replaceMarker
    ? await prisma.page.findFirst({ where: { projectId, markdown: { contains: replaceMarker } } })
    : null;
  const targetPage =
    markerPage ??
    (imageInsertion.placement === "end_of_book"
      ? await prisma.page.findFirst({ where: { projectId }, orderBy: { index: "desc" } })
      : await prisma.page.findFirst({ where: { projectId, index: imageInsertion.targetPageIndex } }));
  if (!targetPage) {
    throw new Error(
      imageInsertion.placement === "end_of_book"
        ? "This book has no pages to add an illustration to"
        : `Page ${imageInsertion.targetPageIndex} no longer exists, so the illustration has nowhere to go`
    );
  }

  await advanceJobStep(generationJobId, "snapshot", 35, `Snapshotting page ${targetPage.index}`);
  await advanceJobStep(generationJobId, "apply", 45, `Rendering an illustration for page ${targetPage.index}`, {
    pageIndex: targetPage.index
  });
  const selection = await insertionReferenceSelection({
    projectId,
    planVersionId: planVersion.id,
    subject: imageInsertion.subject,
    input,
    plan,
    image: providers.image,
    projectUserId: project.userId ?? null
  });
  const trimmedRequest = request?.trim() ?? "";
  const imagePrompt = [
    `Create one interior book illustration depicting: ${imageInsertion.subject}.`,
    // The stored request carries the reader's wording and any appended library
    // character sheets (`requestWithCharacterContext`) — the only channel the
    // appearance rules travel through to this model.
    trimmedRequest && trimmedRequest !== imageInsertion.subject.trim()
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
  const filename = `${marker}-${randomUUID()}.${optimizedImage.extension}`;
  const projectImageDir = join(config.IMAGE_STORAGE_DIR, projectId);
  const imagePath = join(projectImageDir, filename);
  await mkdir(projectImageDir, { recursive: true });
  await writeFile(imagePath, optimizedImage.bytes);

  const alt = imageAltFromSubject(imageInsertion.subject, markdownLabels(project.language).illustration);
  const imageLine = `![${alt}](/assets/images/${projectId}/${filename})`;
  // One transaction holds everything that must live or die with the APPLIED
  // claim: the page re-read, the append, the undo snapshot, and the
  // contentRevision bump. `markActive` deliberately re-claims ACTIVE rows for
  // stalled deliveries, so two deliveries of this job can run concurrently —
  // the conditional claim makes exactly one of them append, and the loser
  // writes nothing at all.
  let applied: boolean;
  try {
    applied = await prisma.$transaction(async (tx) => {
      const claimed = await tx.bookEditOperation.updateMany({
        where: { id: operationId, status: { in: ["QUEUED", "ACTIVE"] } },
        data: { status: "APPLIED", affectedPageIndexes: [targetPage.index], appliedAt: new Date() }
      });
      if (claimed.count !== 1) {
        return false;
      }
      const current = await tx.page.findUnique({ where: { id: targetPage.id } });
      if (!current) {
        throw new Error(`Page ${targetPage.index} disappeared while the illustration was being added`);
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
      await tx.project.update({ where: { id: projectId }, data: { contentRevision: { increment: 1 } } });
      return true;
    });
  } catch (error) {
    // The file this delivery wrote is referenced by nothing — its unique name
    // only enters the page through its own committed append.
    await removeInsertionImage(imagePath);
    throw error;
  }
  if (!applied) {
    // Another delivery settled this operation; whatever it decided stands.
    // This delivery's file is an orphan and is cleaned up — unless the
    // operation is APPLIED, where nothing may be deleted near the published
    // image (the same-name overwrite is gone with unique filenames, but the
    // guard stays).
    const settled = await prisma.bookEditOperation.findUnique({ where: { id: operationId } });
    if (settled?.status !== "APPLIED") {
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
  await refreshExports(projectId, planVersion.id);
}

/**
 * A previous delivery committed the append — APPLIED, the page write, the undo
 * snapshot and the contentRevision bump share one transaction — and crashed
 * before its durable COMPLETED write. Only the idempotent export refresh is
 * replayed; bumping contentRevision again would order a second compile of a
 * manuscript the appending transaction already versioned.
 *
 * The plan lookup here can still throw after the append is durable — the one
 * accepted residual failure window on this path, matching the text edit's own
 * post-commit lookups.
 */
async function replayAppliedInsertion(projectId: string, planId: string | undefined): Promise<void> {
  const project = await getProjectOrThrow(projectId);
  const compilePlanId = planId ?? project.currentPlanId;
  if (!compilePlanId) {
    throw new Error("Current plan not found");
  }
  await refreshExports(projectId, compilePlanId);
}

/** The shared success tail: rebuild the exports from what the page now says. */
async function refreshExports(projectId: string, planVersionId: string): Promise<void> {
  await invalidateProjectExports(projectId);
  await finishWithCompile(projectId, planVersionId);
}

/** Best-effort: an orphaned image file is storage noise, never a failure. */
async function removeInsertionImage(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Including ENOENT: the other end of the race working is not an error.
  }
}

/**
 * The applyBookEdit success tail: queue the recompile, and on `not-ready` (or an
 * enqueue outage) hand the book to the on-demand export repair lane — COMPLETE
 * with missing files is exactly the state the app's status stream rebuilds,
 * while EDITING is a state no sweep and no route can reach.
 *
 * `withoutQualityVerdict`, because the appended image line moved the markdown
 * without touching prose: the model-QA findings the book earned still describe
 * every page, and this recompile's deterministic-only report must not replace
 * them.
 */
async function finishWithCompile(projectId: string, planVersionId: string): Promise<void> {
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
    await prisma.project
      .updateMany({ where: { id: projectId, status: "EDITING" }, data: { status: "COMPLETE" } })
      .catch(() => undefined);
  }
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

/**
 * Append the image line after the page's prose, blank-line separated. A page
 * whose whole body is one fence-wrapped block is unwrapped first: appended
 * after the closing ``` the compiler's own unwrap no longer matches and the
 * fence turns the prose into a literal code block in both exports. But the
 * compiler's pattern spans the first opener to the LAST closer, so a page that
 * merely starts and ends with distinct fences would "unwrap" to a body whose
 * interior fence lines swap prose and code in both exports — and this handler
 * SAVES its result to `Page.markdown`, making that permanent. Such a page is
 * left exactly as written: a plain append after it compiles correctly.
 */
export function markdownWithAppendedImage(markdown: string, imageLine: string): string {
  const trimmed = markdown.trim();
  const unwrapped = unwrapWholePageMarkdownFence(trimmed);
  const base = unwrapped.includes("```") ? trimmed : unwrapped;
  return base ? `${base}\n\n${imageLine}` : imageLine;
}

/**
 * Swaps the line carrying `replaceMarker` for the new image line, in place —
 * a replacement keeps the old picture's spot. Null when no line carries the
 * marker, which is the caller's cue to append instead.
 */
export function markdownWithReplacedImage(markdown: string, replaceMarker: string, imageLine: string): string | null {
  const markerLine = new RegExp(`^.*${replaceMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*$`, "m");
  return markerLine.test(markdown) ? markdown.replace(markerLine, imageLine) : null;
}

/**
 * Alt text from the subject. `]` or `)` breaks the exporters' image-markdown
 * regex and the image silently vanishes from both exports, and the exact
 * "Illustration for page N" shape is rejected by `findBookLikeMarkdownIssues`
 * as a generation artifact — both degrade to the localized generic label.
 */
export function imageAltFromSubject(subject: string, fallbackLabel: string): string {
  const stripped = subject
    .replace(/[[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
  if (!stripped || /^illustration for page \d+$/i.test(stripped)) {
    return fallbackLabel;
  }
  return stripped;
}
