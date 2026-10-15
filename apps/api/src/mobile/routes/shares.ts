import type { GenerationTextModelRouting } from "@book-maker/core";
import { prisma, type Prisma } from "@book-maker/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sendContentRestricted } from "../../contentRestrictions.js";
import { liveRoutingLoader } from "../../generationTextModelRouting.js";
import { recordInlineDecisionAttempt } from "../../inlineDecisionUsage.js";
import { InMemoryRateLimiter } from "../../rateLimit.js";
import { containsLink, moderateUserText, type UserTextModerationDeps } from "../../userTextModeration.js";
import { hitAuthenticatedLimit, requireMobileAuth, sendMobileError, sendProjectNotFound } from "../httpErrors.js";
import type { MobileRouteContext } from "../routeContext.js";
import { idParamsSchema, mobileAuthError } from "../schemas.js";
import {
  bookShowsRealLikeness,
  loadSharedPdfLayout,
  readSharedBookText,
  screenSharedBook,
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
  shareServesCurrentText,
  ShareTakenDownError,
  SharingDisabledError,
  accountMayShare,
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
 * A share costs nothing, preview or full: no book carries an export unlock any
 * more (2026-10-15), so `acceptExportUnlock` is accepted and ignored, the state
 * reports every book unlocked at 0 credits and a save never charges, for the
 * installed builds that still ask.
 *
 * The order in `PUT` is: the body, the account (an operator may have turned
 * its sharing off — `SHARING_DISABLED`, which also refuses a remix), the book,
 * a published PDF, the rights and likeness confirmations, the preview cap, the
 * book text screen (the deterministic rules, then the sexual-content filter's
 * model screen, which may hold the share for review), the note's link check,
 * the note's moderation, and the write. The text screen runs at create, at
 * every mode change, and whenever the book's revision has moved past the
 * share's stamp, over one snapshot of the text and its revision; the write
 * stamps that revision (`shareRescreen.ts` has the rest of that rule). The
 * share transaction independently rejects takedowns and a disabled account
 * under row locks.
 */

const DEFAULT_CAPTION_RATE_LIMIT = { maxAttempts: 20, windowMs: 60 * 60 * 1000 };

export async function registerMobileShareRoutes(fastify: FastifyInstance, context: MobileRouteContext): Promise<void> {
  const { appConfig, options } = context;
  const captionLimiter = new InMemoryRateLimiter({ ...DEFAULT_CAPTION_RATE_LIMIT, ...options.shareCaptionRateLimit });
  // Built on first use: nothing reads the Quality tab until a note is moderated.
  let liveLoader: (() => Promise<GenerationTextModelRouting>) | undefined;
  const loadRouting = options.userTextModeration?.loadRouting ?? (() => (liveLoader ??= liveRoutingLoader(appConfig))());

  const moderationDeps = (projectId: string, userId: string): UserTextModerationDeps => ({
    config: appConfig,
    loadRouting,
    recordAttempt: (attempt) => recordInlineDecisionAttempt(attempt, { projectId, userId }),
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
      if (!(await accountMayShare(prisma, auth.user.id))) {
        return sendShareError(reply, "SHARING_DISABLED");
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

      // The book text screen, at create, at every mode change, and whenever
      // the book has moved past the live share's stamp: the deterministic
      // rules, then the sexual-content filter's model screen, whose windows
      // without a verdict hold the share for review. One snapshot of the text
      // and its revision, so the write stamps exactly what was read.
      let screenedContentRevision: number | null = null;
      let textReview: Prisma.InputJsonValue | null = null;
      if (!live || live.mode !== mode || !shareServesCurrentText(live, project)) {
        const text = await readSharedBookText(project.id);
        if (!text) {
          return sendProjectNotFound(reply);
        }
        const screened = await screenSharedBook(text, moderationDeps(project.id, auth.user.id), request.log);
        if (screened.verdict === "refused") {
          return sendContentRestricted(reply, screened.refusal);
        }
        screenedContentRevision = screened.contentRevision;
        textReview = screened.verdict === "held" ? screened.review : null;
      }

      const captionWrite = await decideCaption({
        request,
        reply,
        caption,
        existing,
        userId: auth.user.id,
        limiter: captionLimiter,
        deps: moderationDeps(project.id, auth.user.id)
      });
      if (captionWrite === null) {
        return;
      }

      let share: BookShareRecord;
      try {
        share = await writeShare({
          userId: auth.user.id,
          projectId: project.id,
          projectTitle: project.title,
          mode,
          previewPages,
          showAuthorName: body.showAuthorName,
          caption: captionWrite,
          textReview,
          screenedContentRevision,
          confirmRights: body.rightsConfirmed === true,
          confirmLikeness: likenessRequired && body.likenessConfirmed === true
        });
      } catch (error) {
        if (error instanceof ShareTakenDownError) {
          return sendShareError(reply, "SHARE_TAKEN_DOWN");
        }
        if (error instanceof SharingDisabledError) {
          return sendShareError(reply, "SHARING_DISABLED");
        }
        throw error;
      }
      return {
        share: serializeBookShare(share, appConfig.PUBLIC_API_URL),
        book: await shareBookState(project, auth.user.id),
        exportUnlockCharged: false
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
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 403: mobileAuthError, 404: mobileAuthError, 410: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!(await accountMayShare(prisma, auth.user.id))) {
        return sendShareError(reply, "SHARING_DISABLED");
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
        select: { title: true, contentRevision: true, mediaSettings: true, category: true, subcategory: true, targetPages: true }
      });
      if (!project) {
        return sendShareError(reply, "SHARE_NOT_FOUND");
      }
      // The title is the one piece of the book this answer carries, so a share
      // whose book changed since its last screen sends none: the app then
      // writes its opening line without one.
      return {
        title: shareServesCurrentText(share, project) ? project.title : "",
        presets: remixPresetsForProject(project)
      } satisfies MobileShareRemixDto;
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
  const [availability, likenessRequired] = await Promise.all([
    shareAvailability(project),
    bookShowsRealLikeness(userId, project.mediaSettings)
  ]);
  const loaded = availability === "available" ? await loadSharedPdfLayout(project) : null;
  const readingPages = loaded ? readingPageCount(loaded.layout) : null;
  return {
    shareable: availability === "available" && loaded !== null,
    unavailableReason: availability === "available" ? (loaded ? null : "being_updated") : availability,
    kind: shareBookKind(project.mediaSettings),
    readingPages,
    maxPreviewPages: loaded ? maxPreviewPages(readingPages) : null,
    likenessRequired,
    // A full share is free; installed builds ask for an unlock when these say otherwise.
    exportUnlocked: true,
    exportUnlockCredits: 0
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
