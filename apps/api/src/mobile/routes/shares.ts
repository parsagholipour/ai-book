import { creditCostForOperation, type GenerationTextModelRouting } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { hasActiveProjectEntitlement } from "@book-maker/db/billing";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sendContentRestricted } from "../../contentRestrictions.js";
import { liveRoutingLoader } from "../../generationTextModelRouting.js";
import { recordInlineDecisionAttempt } from "../../inlineDecisionUsage.js";
import { InMemoryRateLimiter } from "../../rateLimit.js";
import { containsLink, moderateUserText, type UserTextModerationDeps } from "../../userTextModeration.js";
import {
  ensureExportEntitlementForDownload,
  hitAuthenticatedLimit,
  requireMobileAuth,
  sendMobileError,
  sendProjectNotFound
} from "../httpErrors.js";
import type { MobileRouteContext } from "../routeContext.js";
import { idParamsSchema, mobileAuthError } from "../schemas.js";
import {
  bookShowsRealLikeness,
  loadSharedPdfLayout,
  screenSharedBookText,
  shareAvailability,
  shareBookKind,
  shareProjectSelect,
  type ShareProject
} from "../shares/shareBook.js";
import { CAPTION_REFUSALS, sendCaptionRefused, sendShareError } from "../shares/shareCopy.js";
import { maxPreviewPages, readingPageCount } from "../shares/sharePageRange.js";
import { sharePreviewPrefix } from "../shares/sharePreviewPdf.js";
import {
  captionDecisionFromModeration,
  loadShareBySlug,
  loadShareForProject,
  noCaptionDecision,
  normalizeCaption,
  serializeBookShare,
  writeShare,
  type BookShareRecord,
  type CaptionDecision,
  type MobileShareBookDto,
  type MobileShareStateDto,
  type MobileShareWriteDto
} from "../shares/shareRecords.js";
import { remixPresetsForProject, type MobileShareRemixDto } from "../shares/shareRemix.js";
import {
  SHARE_CAPTION_MAX_CHARS,
  shareBodySchema,
  shareOpenApiBody,
  shareRouteErrors,
  shareSlugParamsSchema
} from "../shares/shareSchemas.js";
import { objectStore } from "@book-maker/storage";

/**
 * The author's side of book sharing: read, create/update, and stop sharing
 * one book (`/api/mobile/projects/:id/share`), and the remix presets a signed-in
 * reader fetches after tapping "Make a book like this"
 * (`/api/mobile/shares/:slug/remix`). The public page is `publicShareRoutes.ts`.
 *
 * **Every check runs before anything is charged or written, and the unlock
 * settles last.** The order in `PUT` is: the body, the book, a published PDF,
 * the rights and likeness confirmations, the preview cap, the unlock the author
 * agreed to (read-only), the book text screen, the note's link check, the
 * note's moderation — and only then `ensureExportEntitlementForDownload`, the
 * same helper and idempotency key the PDF download uses (`sendUnlocked` in
 * `exports.ts`). A refused note or a refused book therefore costs nothing,
 * and a FULL share of a book already unlocked costs nothing either. The unlock
 * is the book's, not the share's: a later downgrade to a preview refunds
 * nothing, and a write that fails after the charge leaves the book unlocked, so
 * the retry is free.
 */

const DEFAULT_CAPTION_RATE_LIMIT = { maxAttempts: 20, windowMs: 60 * 60 * 1000 };

export async function registerMobileShareRoutes(fastify: FastifyInstance, context: MobileRouteContext): Promise<void> {
  const { appConfig, options } = context;
  const captionLimiter = new InMemoryRateLimiter({ ...DEFAULT_CAPTION_RATE_LIMIT, ...options.shareCaptionRateLimit });
  // Built on first use: nothing reads the Quality tab until a note is moderated.
  let liveLoader: (() => Promise<GenerationTextModelRouting>) | undefined;
  const loadRouting = options.userTextModeration?.loadRouting ?? (() => (liveLoader ??= liveRoutingLoader(appConfig))());

  const moderationDeps = (projectId: string): UserTextModerationDeps => ({
    config: appConfig,
    loadRouting,
    recordAttempt: (attempt) => recordInlineDecisionAttempt(attempt, { projectId }),
    ...options.userTextModeration
  });

  fastify.get(
    "/api/mobile/projects/:id/share",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const project = await loadOwnedProject(id, auth.user.id);
      if (!project) {
        return sendProjectNotFound(reply);
      }
      const share = await loadShareForProject(project.id);
      return {
        share: share ? serializeBookShare(share, appConfig.PUBLIC_API_URL) : null,
        book: await shareBookState(project, auth.user.id)
      } satisfies MobileShareStateDto;
    }
  );

  fastify.put(
    "/api/mobile/projects/:id/share",
    { attachValidation: true, schema: { tags: ["mobile"], body: shareOpenApiBody, response: shareRouteErrors } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const parsed = shareBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Choose how to share this book.");
      }
      const body = parsed.data;
      const caption = normalizeCaption(body.caption);
      if (caption && [...caption].length > SHARE_CAPTION_MAX_CHARS) {
        return sendShareError(reply, "CAPTION_TOO_LONG");
      }

      const project = await loadOwnedProject(id, auth.user.id);
      if (!project) {
        return sendProjectNotFound(reply);
      }
      const existing = await loadShareForProject(project.id);
      if (existing?.status === "TAKEN_DOWN") {
        return sendShareError(reply, "SHARE_TAKEN_DOWN");
      }
      const live = existing?.status === "ACTIVE" ? existing : null;

      const availability = await shareAvailability(project);
      if (availability === "not_finished") {
        return sendShareError(reply, "SHARE_NOT_AVAILABLE");
      }
      if (availability === "being_updated") {
        return sendShareError(reply, "SHARE_BEING_UPDATED");
      }
      if (!live && body.rightsConfirmed !== true) {
        return sendShareError(reply, "SHARE_RIGHTS_REQUIRED");
      }
      const likenessRequired = await bookShowsRealLikeness(auth.user.id, project.mediaSettings);
      const likenessOnRecord = Boolean(live?.likenessConfirmedAt);
      if (likenessRequired && body.likenessConfirmed !== true && !likenessOnRecord) {
        return sendShareError(reply, "SHARE_LIKENESS_REQUIRED");
      }

      const mode = body.mode === "full" ? "FULL" : "PREVIEW";
      let previewPages: number | null = null;
      if (mode === "PREVIEW") {
        if (body.previewPages === undefined) {
          return sendShareError(reply, "PREVIEW_PAGES_REQUIRED");
        }
        const loaded = await loadSharedPdfLayout(project);
        if (!loaded) {
          return sendShareError(reply, "SHARE_BEING_UPDATED");
        }
        if (body.previewPages > maxPreviewPages(readingPageCount(loaded.layout))) {
          return sendShareError(reply, "PREVIEW_TOO_LONG");
        }
        previewPages = body.previewPages;
      }

      const unlocked =
        mode === "FULL" ? await hasActiveProjectEntitlement({ userId: auth.user.id, projectId: project.id, type: "EXPORT_UNLOCK" }) : true;
      if (!unlocked && body.acceptExportUnlock !== true) {
        return sendShareError(reply, "EXPORT_UNLOCK_REQUIRED", {
          creditsRequired: creditCostForOperation("EXPORT_UNLOCK")
        });
      }

      // The book text screen, at create and at every mode change.
      if (!live || live.mode !== mode) {
        const screened = await screenSharedBookText(project);
        if (!screened.allowed) {
          return sendContentRestricted(reply, screened);
        }
      }

      const captionWrite = await decideCaption({
        request,
        reply,
        caption,
        existing,
        userId: auth.user.id,
        limiter: captionLimiter,
        deps: moderationDeps(project.id)
      });
      if (captionWrite === null) {
        return;
      }

      let exportUnlockCharged = false;
      if (!unlocked) {
        // Every other check has passed; the unlock settles now or not at all.
        const entitlement = await ensureExportEntitlementForDownload(reply, auth.user.id, project.id);
        if (!entitlement) {
          return;
        }
        exportUnlockCharged = true;
      }

      const share = await writeShare({
        userId: auth.user.id,
        projectId: project.id,
        projectTitle: project.title,
        mode,
        previewPages,
        showAuthorName: body.showAuthorName,
        caption: captionWrite,
        confirmRights: body.rightsConfirmed === true,
        confirmLikeness: likenessRequired && body.likenessConfirmed === true
      });
      return {
        share: serializeBookShare(share, appConfig.PUBLIC_API_URL),
        book: await shareBookState(project, auth.user.id),
        exportUnlockCharged
      } satisfies MobileShareWriteDto;
    }
  );

  fastify.delete(
    "/api/mobile/projects/:id/share",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const project = await loadOwnedProject(id, auth.user.id);
      if (!project) {
        return sendProjectNotFound(reply);
      }
      // Only a live share stops; a taken-down one stays taken down, so the
      // author cannot clear the operator's reason by revoking and re-sharing.
      await prisma.bookShare.updateMany({
        where: { projectId: project.id, status: "ACTIVE" },
        data: { status: "REVOKED" }
      });
      try {
        await objectStore().deletePrefix(sharePreviewPrefix(project.id));
      } catch (error) {
        request.log.warn({ err: error, projectId: project.id }, "share preview cleanup failed");
      }
      const share = await loadShareForProject(project.id);
      return {
        share: share ? serializeBookShare(share, appConfig.PUBLIC_API_URL) : null,
        book: await shareBookState(project, auth.user.id)
      } satisfies MobileShareStateDto;
    }
  );

  fastify.get(
    "/api/mobile/shares/:slug/remix",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError, 410: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { slug } = shareSlugParamsSchema.parse(request.params);
      const share = await loadShareBySlug(slug);
      if (!share) {
        return sendShareError(reply, "SHARE_NOT_FOUND");
      }
      if (share.status !== "ACTIVE") {
        return sendShareError(reply, "REMIX_NOT_AVAILABLE");
      }
      // Format only. Nothing below reads the brief, plan, chat, cast or text.
      const project = await prisma.project.findUnique({
        where: { id: share.projectId },
        select: { title: true, mediaSettings: true, category: true, subcategory: true, targetPages: true }
      });
      if (!project) {
        return sendShareError(reply, "SHARE_NOT_FOUND");
      }
      return { title: project.title, presets: remixPresetsForProject(project) } satisfies MobileShareRemixDto;
    }
  );
}

async function loadOwnedProject(id: string, userId: string): Promise<ShareProject | null> {
  return (await prisma.project.findFirst({
    where: { id, userId },
    select: shareProjectSelect
  })) as ShareProject | null;
}

async function shareBookState(project: ShareProject, userId: string): Promise<MobileShareBookDto> {
  const [availability, likenessRequired, exportUnlocked] = await Promise.all([
    shareAvailability(project),
    bookShowsRealLikeness(userId, project.mediaSettings),
    hasActiveProjectEntitlement({ userId, projectId: project.id, type: "EXPORT_UNLOCK" })
  ]);
  const loaded = availability === "available" ? await loadSharedPdfLayout(project) : null;
  const readingPages = loaded ? readingPageCount(loaded.layout) : null;
  return {
    shareable: availability === "available" && loaded !== null,
    unavailableReason: availability === "available" ? (loaded ? null : "being_updated") : availability,
    kind: shareBookKind(project.mediaSettings),
    readingPages,
    maxPreviewPages: readingPages === null ? null : maxPreviewPages(readingPages),
    likenessRequired,
    exportUnlocked,
    exportUnlockCredits: exportUnlocked ? 0 : creditCostForOperation("EXPORT_UNLOCK")
  };
}

/**
 * The note's fate, or `null` when this function has already answered.
 *
 * An unchanged note is not re-moderated: it keeps the status it has, including
 * an operator's REMOVED, which is what makes that decision stick to the text.
 * A changed one is refused on a link before any model runs, rate limited, and
 * then gated — and the gate's "no verdict" holds the note for review rather
 * than allowing it.
 */
async function decideCaption(input: {
  request: FastifyRequest;
  reply: FastifyReply;
  caption: string | null;
  existing: BookShareRecord | null;
  userId: string;
  limiter: InMemoryRateLimiter;
  deps: UserTextModerationDeps;
}): Promise<CaptionDecision | "unchanged" | null> {
  const { caption, existing, reply } = input;
  if (existing && existing.caption === caption) {
    return "unchanged";
  }
  if (caption === null) {
    return noCaptionDecision();
  }
  if (containsLink(caption)) {
    sendShareError(reply, "CAPTION_LINK_NOT_ALLOWED");
    return null;
  }
  if (!hitAuthenticatedLimit(input.limiter, reply, input.userId, "share-caption-moderation")) {
    return null;
  }
  const signal = requestSignal(reply);
  const result = await moderateUserText({ text: caption, surface: "book_share_caption", signal }, input.deps);
  if (result.verdict === "refused") {
    input.request.log.info(
      { event: "share.caption_refused", violation: result.violation, code: CAPTION_REFUSALS[result.violation].code },
      "share note refused"
    );
    sendCaptionRefused(reply, result.violation);
    return null;
  }
  return captionDecisionFromModeration(caption, "book_share_caption", result);
}

/**
 * Aborts when the client goes away before the answer is written: a closed
 * connection is a cancellation, and a cancelled gate writes nothing.
 *
 * The response's `close`, never the request's state: Node destroys an
 * `IncomingMessage` as soon as its body has been read, so by the time a
 * handler runs `request.raw.destroyed` is already true on every PUT with a
 * body — reading it as "the client left" cancelled every gate over a real
 * socket while `inject` never showed it.
 */
function requestSignal(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.once("close", () => {
    if (!reply.raw.writableEnded) {
      controller.abort();
    }
  });
  return controller.signal;
}
