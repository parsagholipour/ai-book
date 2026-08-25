import { getProjectOrThrow, imageGenerationMetadata, imageStorageMetadata, strategyForInput } from "../generation/bookHelpers.js";
import { inputForPlanVersion } from "../generation/projectInput.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { advanceJobStep, updateJobProgress } from "../runtime/jobLifecycle.js";
import { isStopRequestedError } from "../runtime/jobTypes.js";
import { jsonPayloadToRecord } from "../runtime/serialization.js";
import {
  characterReferencePromptInstruction,
  ensureCharacterReferenceAssets,
  selectReferenceImagePaths
} from "../generation/characterReferences.js";
import { generateCover } from "./generateCover.js";
import {
  ownsPageIllustration,
  pageIllustrationKeeperTokens,
  type PageIllustrationKeeper
} from "../generation/pageIllustrationOwnership.js";
import {
  bookPlanSchema,
  createProviders,
  errorMessage,
  isDiagramFriendlyBookCategory,
  optimizeImageForStorage,
  publicAssetUrl,
  safePathPart
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import type { GenerateImageJob } from "../runtime/jobPayloads.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * `generate-image` job: render and store one page illustration.
 */

type TokenIllustrationOwnership = {
  kind: "token";
  keeperToken: string;
  prompt: string;
};

type LegacyIllustrationOwnership = {
  kind: "legacy";
  generationJobId: string;
  queuedAt: Date;
  projectId: string;
  pageId: string;
  prompt: string;
};

type IllustrationOwnership = TokenIllustrationOwnership | LegacyIllustrationOwnership;

export async function generateImage(job: GenerateImageJob) {
  if (job.data.assetType === "COVER") {
    await generateCover(job);
    return;
  }

  const { projectId, pageId, planId, prompt, keeperToken, generationJobId } = job.data;
  const [project, page, planVersion] = await Promise.all([
    getProjectOrThrow(projectId),
    prisma.page.findUnique({ where: { id: pageId } }),
    prisma.planVersion.findUnique({ where: { id: planId } })
  ]);
  if (!page || !planVersion) {
    throw new Error("Page or plan not found for image generation");
  }
  const ownership = keeperToken
    ? ({ kind: "token", keeperToken, prompt } satisfies TokenIllustrationOwnership)
    : await loadLegacyIllustrationOwnership({ generationJobId, projectId, pageId, planId, prompt });
  if (!ownership || !pageOwnsIllustration(page, ownership)) {
    return;
  }
  const input = inputForPlanVersion(project, planVersion.inputSnapshot);
  const strategy = strategyForInput(input);
  const providers = createLoggedProviders(job, createProviders(config, input), input);
  const plan = bookPlanSchema.parse(planVersion.planningPackage);
  try {
    await renderAndStorePageIllustration({
      projectId,
      pageId,
      planId,
      prompt,
      ownership,
      generationJobId,
      input,
      strategy,
      providers,
      plan,
      page
    });
  } catch (error) {
    if (isStopRequestedError(error)) {
      throw error;
    }
    // Claim the exact keeper atomically with the failure marker. A separate
    // read here allowed a newer page to land between the check and the write.
    const marked = await markOwnedIllustrationFailure(pageId, ownership)
      .catch((markError: unknown) => {
        // Preserve interior-image failure isolation when the marker itself
        // cannot be written. No page was changed, so this cannot violate the
        // keeper fence; the provider failure remains in the run log.
        console.error(`Failed to record the lost illustration on page ${pageId}`, markError);
        return undefined;
      });
    if (marked === false) {
      return;
    }
    // An interior illustration is decoration on a page that is already written
    // and paid for, and this only fires after the provider fallback tried every
    // image provider. Failing the job would mark the whole project FAILED and
    // refund FULL_BOOK_GENERATION for one lost image; record it and let the
    // book finish without this illustration instead. The provider failure is in
    // the run log; the job row's message says what happened, and the Page row's
    // imageFailureReason is the durable marker that lets the app tell a lost
    // illustration from a page that was never meant to have one.
    console.warn("Interior illustration failed; continuing without it", {
      event: "generation.consistency_warning",
      warning: "interior_image_failed",
      projectId,
      pageId,
      pageIndex: page.index,
      error: errorMessage(error)
    });
    await updateJobProgress(generationJobId, {
      message: `Illustration for page ${page.index} failed; the book will finish without it`
    });
  }
  // The compile check runs after this job's row is COMPLETED
  // (maybeCompileAfterCompletedJob); from in here the gate always counted this
  // job as open and could never fire.
}

async function renderAndStorePageIllustration(options: {
  projectId: string;
  pageId: string;
  planId: string;
  prompt: string;
  ownership: IllustrationOwnership;
  generationJobId: string | undefined;
  input: ReturnType<typeof inputForPlanVersion>;
  strategy: ReturnType<typeof strategyForInput>;
  providers: ReturnType<typeof createLoggedProviders>;
  plan: ReturnType<typeof bookPlanSchema.parse>;
  page: {
    id: string;
    projectId: string;
    index: number;
    title: string;
    summary: string;
    markdown: string;
    imagePrompt: string | null;
    revision: number;
  };
}) {
  const { projectId, pageId, planId, prompt, ownership, generationJobId, input, strategy, providers, plan, page } = options;
  const characterReferences = await ensureCharacterReferenceAssets({
    projectId,
    planId,
    input,
    plan,
    providers,
    strategy,
    generationJobId
  });
  const references = await selectReferenceImagePaths({
    input,
    plan,
    assets: characterReferences,
    projectId,
    image: providers.image,
    context: [prompt, page.title, page.summary, page.markdown].filter(Boolean).join("\n")
  });
  const referenceImagePaths = references.paths;
  const imagePrompt = [
    prompt,
    characterReferencePromptInstruction(references),
    `Global visual style: ${plan.illustrationPlan.globalStyle}`,
    `Continuity rules: ${plan.illustrationPlan.pageRules.join(" ")}`
  ].filter(Boolean).join("\n");
  await advanceJobStep(generationJobId, "prompt", 25, `Building prompt for page ${page.index}`);
  await advanceJobStep(generationJobId, "render", 45, `Rendering page ${page.index}`);
  const image = await strategy.generateImageBytes({
    image: providers.image,
    prompt: imagePrompt,
    projectId,
    pageId,
    referenceImagePaths
  });

  await advanceJobStep(generationJobId, "store", 80, `Storing image for page ${page.index}`);
  const optimizedImage = await optimizeImageForStorage({ bytes: image.bytes, mimeType: image.mimeType });
  if (!(await currentPageOwnsIllustration(prisma, pageId, ownership))) {
    return;
  }
  const ext = optimizedImage.extension;
  const projectImageDir = join(config.IMAGE_STORAGE_DIR, projectId);
  await mkdir(projectImageDir, { recursive: true });
  // Every migration path writes immutably. A replacement can commit after the
  // read above and before this write; its final row lock will reject this job,
  // while the orphan file cannot overwrite either the replacement or a page
  // that moved into this job's old numeric index.
  const filename =
    ownership.kind === "token"
      ? `page-${safePathPart(pageId)}-${ownership.keeperToken}.${ext}`
      : `page-${safePathPart(pageId)}-legacy-${safePathPart(ownership.generationJobId)}.${ext}`;
  const filePath = join(projectImageDir, filename);
  await writeFile(filePath, optimizedImage.bytes);

  const assetType = isDiagramFriendlyBookCategory(input.category) ? "DIAGRAM" : "SCENE_ILLUSTRATION";
  await prisma.$transaction(async (tx) => {
    // Lock before deciding. A newer keeper either committed before the lock
    // and fails ownership, or waits until this asset publication commits.
    const lockedPage = await lockPageForIllustration(tx, pageId);
    if (!lockedPage || !pageOwnsIllustration(lockedPage, ownership)) {
      return;
    }
    if (lockedPage.imageFailureReason !== null) {
      // Preserve the generation transition's optimistic version: this row is
      // locked, so writing its current updatedAt back is safe and prevents an
      // image-only marker change from invalidating page finalization.
      await tx.page.updateMany({
        where: { id: pageId, updatedAt: lockedPage.updatedAt },
        data: { imageFailureReason: null, updatedAt: lockedPage.updatedAt }
      });
    }
    const keeperTokenAliases =
      ownership.kind === "token" ? pageIllustrationKeeperTokens(illustrationKeeperForStoredPage(lockedPage)) : [];
    // Replace only this generated owner's redelivery. A page can also carry a
    // user-inserted SCENE_ILLUSTRATION/DIAGRAM, which is not ours to sweep.
    await tx.imageAsset.deleteMany({
      where: {
        projectId,
        pageId,
        type: assetType,
        OR:
          ownership.kind === "token"
            ? [
                ...keeperTokenAliases.map((keeperToken) => ({
                  metadata: { path: ["keeperToken"], equals: keeperToken }
                })),
                ...keeperTokenAliases.map((keeperToken) => ({ path: { contains: `-${keeperToken}.` } }))
              ]
            : [
                {
                  metadata: {
                    path: ["legacyGenerationJobId"],
                    equals: ownership.generationJobId
                  }
                },
                {
                  path: {
                    contains: `/page-${safePathPart(pageId)}-legacy-${safePathPart(ownership.generationJobId)}.`
                  }
                }
              ]
      }
    });
    await tx.imageAsset.create({
      data: {
        projectId,
        pageId,
        type: assetType,
        prompt: imagePrompt,
        provider: image.provider,
        path: publicAssetUrl(config.PUBLIC_API_URL, `/assets/images/${projectId}/${filename}`),
        metadata: {
          model: image.model,
          ...imageStorageMetadata(optimizedImage),
          revisedPrompt: image.revisedPrompt,
          ...imageGenerationMetadata(image),
          characterReferenceCount: referenceImagePaths.length,
          keeperProjectId: projectId,
          keeperPageId: pageId,
          ...(ownership.kind === "token"
            ? {
                keeperToken: ownership.keeperToken,
                keeperTokenVersion: ownership.keeperToken.startsWith("v2-") ? 2 : 1
              }
            : { legacyGenerationJobId: ownership.generationJobId })
        }
      }
    });
  });
}

type IllustrationOwnershipClient = Pick<Prisma.TransactionClient, "page">;

async function loadLegacyIllustrationOwnership(options: {
  generationJobId: string | undefined;
  projectId: string;
  pageId: string;
  planId: string;
  prompt: string;
}): Promise<LegacyIllustrationOwnership | undefined> {
  if (!options.generationJobId) {
    return undefined;
  }
  const generationJob = await prisma.generationJob.findUnique({
    where: { id: options.generationJobId },
    select: { projectId: true, type: true, payload: true, createdAt: true }
  });
  if (!generationJob || generationJob.projectId !== options.projectId || generationJob.type !== "GENERATE_IMAGE") {
    return undefined;
  }
  const payload = jsonPayloadToRecord(generationJob.payload);
  if (
    payload.pageId !== options.pageId ||
    payload.planId !== options.planId ||
    payload.prompt !== options.prompt ||
    typeof payload.keeperToken === "string" ||
    payload.assetType === "COVER"
  ) {
    return undefined;
  }
  return {
    kind: "legacy",
    generationJobId: options.generationJobId,
    queuedAt: generationJob.createdAt,
    projectId: options.projectId,
    pageId: options.pageId,
    prompt: options.prompt
  };
}

function pageOwnsIllustration(page: StoredIllustrationPage, ownership: IllustrationOwnership): boolean {
  if (ownership.kind === "token") {
    return (
      page.imagePrompt === ownership.prompt &&
      ownsPageIllustration(illustrationKeeperForStoredPage(page), ownership.keeperToken)
    );
  }
  // Old payloads carried no keeper snapshot. The durable job row proves when
  // the command was minted: its prompt must still be the page's prompt, and no
  // keeper publication may have advanced the page since. Staging always writes
  // a fresh monotonic updatedAt, including when replacement enqueue later
  // fails, so stale tokenless work cannot regain ownership in that gap.
  return (
    page.id === ownership.pageId &&
    page.projectId === ownership.projectId &&
    page.imagePrompt === ownership.prompt &&
    // Equality is ambiguous at JavaScript's millisecond precision: a keeper
    // staged just after the job row in the same millisecond can round to the
    // same Date. Only a page version that strictly predates the command proves
    // legacy ownership.
    page.updatedAt.getTime() < ownership.queuedAt.getTime()
  );
}

function illustrationKeeperForStoredPage(page: StoredIllustrationPage): PageIllustrationKeeper {
  return {
    projectId: page.projectId,
    pageId: page.id,
    title: page.title,
    markdown: page.markdown,
    summary: page.summary,
    imagePrompt: page.imagePrompt,
    revision: page.revision
  };
}

async function currentPageOwnsIllustration(
  client: IllustrationOwnershipClient,
  pageId: string,
  ownership: IllustrationOwnership
): Promise<boolean> {
  const page = await client.page.findUnique({
    where: { id: pageId },
    select: {
      id: true,
      projectId: true,
      title: true,
      markdown: true,
      summary: true,
      imagePrompt: true,
      revision: true,
      updatedAt: true
    }
  });
  return Boolean(page && pageOwnsIllustration(page, ownership));
}

type StoredIllustrationPage = Omit<PageIllustrationKeeper, "pageId"> & {
  id: string;
  updatedAt: Date;
};

type LockedIllustrationPage = StoredIllustrationPage & {
  imageFailureReason: string | null;
};

type IllustrationLockClient = Pick<Prisma.TransactionClient, "$queryRaw">;

async function lockPageForIllustration(
  client: IllustrationLockClient,
  pageId: string
): Promise<LockedIllustrationPage | undefined> {
  const rows = await client.$queryRaw<LockedIllustrationPage[]>`
    SELECT "id", "projectId", "title", "markdown", "summary", "imagePrompt", "revision", "imageFailureReason", "updatedAt"
    FROM "Page"
    WHERE "id" = ${pageId}
    FOR UPDATE
  `;
  return rows[0];
}

async function markOwnedIllustrationFailure(pageId: string, ownership: IllustrationOwnership): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const lockedPage = await lockPageForIllustration(tx, pageId);
    if (!lockedPage || !pageOwnsIllustration(lockedPage, ownership)) {
      return false;
    }
    const marked = await tx.page.updateMany({
      where: { id: pageId, updatedAt: lockedPage.updatedAt },
      data: {
        imageFailureReason: "interior_image_failed",
        // See the success path: marker writes do not steal the generation
        // state machine's version while holding the same row lock.
        updatedAt: lockedPage.updatedAt
      }
    });
    return marked.count === 1;
  });
}
