import { prisma } from "@book-maker/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  hitAuthenticatedLimit,
  requireMobileAuth,
  sendMobileError,
  sendProjectNotFound,
  sendUnreadableBodyError
} from "../httpErrors.js";
import {
  enforceStudioFieldRestrictions,
  ManuscriptContentRefusal,
  manuscriptContentRestrictedError,
  sendManuscriptContentRefusal
} from "../manuscript/manuscriptContentScreen.js";
import { manuscriptWireContext } from "../manuscript/manuscriptCover.js";
import {
  addManuscriptChapter,
  deleteManuscriptChapter,
  ManuscriptWriteRefusal,
  reorderManuscriptChapters,
  restoreManuscriptChapter,
  saveManuscriptChapter
} from "../manuscript/manuscriptChapters.js";
import { ensureManuscript, loadManuscriptProject, openManuscript } from "../manuscript/manuscriptDerivation.js";
import type {
  ManuscriptChapterCreateResponseDto,
  ManuscriptChapterResponseDto,
  ManuscriptChapterSaveResponseDto,
  ManuscriptImageUploadResponseDto,
  ManuscriptPublishDryRunResponseDto,
  ManuscriptPublishResponseDto,
  ManuscriptResponseDto,
  ManuscriptVersionResponseDto,
  ManuscriptVersionsResponseDto,
  StudioProjectCreateResponseDto
} from "../manuscript/manuscriptDto.js";
import { manuscriptImageType, storeManuscriptImage } from "../manuscript/manuscriptImages.js";
import { createStudioProject, updateManuscriptSettings } from "../manuscript/manuscriptProjects.js";
import { ManuscriptPublishRefusal, publishChecklist, publishManuscript } from "../manuscript/manuscriptPublish.js";
import {
  manuscriptChapterCreateBodySchema,
  manuscriptChapterCreateOpenApiBody,
  manuscriptChapterParamsSchema,
  manuscriptChapterSaveBodySchema,
  manuscriptChapterSaveOpenApiBody,
  manuscriptImageQuerySchema,
  MANUSCRIPT_IMAGE_MAX_BYTES,
  manuscriptOrderBodySchema,
  manuscriptOrderOpenApiBody,
  manuscriptPublishBodySchema,
  manuscriptPublishOpenApiBody,
  manuscriptSettingsBodySchema,
  manuscriptSettingsOpenApiBody,
  manuscriptVersionParamsSchema,
  studioProjectCreateBodySchema,
  studioProjectCreateOpenApiBody
} from "../manuscript/manuscriptSchemas.js";
import { serializeChapter, serializeChapterSummary, serializeManuscript, serializeVersion, serializeVersionSummary } from "../manuscript/manuscriptSerializers.js";
import { idParamsSchema, mobileAuthError } from "../schemas.js";
import type { MobileRouteContext } from "../routeContext.js";
import { authorProjectOrReply, manuscriptDto, projectSummaryDto } from "./manuscriptRouteSupport.js";

/**
 * The Writing Studio (`.scratch/writing-studio/spec.md`, "HTTP API"): the
 * working copy an author writes in, and Publish, which makes it the book.
 * Everything here is free.
 */

const errorResponses = { 401: mobileAuthError, 404: mobileAuthError } as const;

const CHAPTER_CONFLICT_MESSAGE = "This chapter was changed on another device. Choose which version to keep.";

export async function registerMobileManuscriptRoutes(fastify: FastifyInstance, context: MobileRouteContext): Promise<void> {
  const { appConfig, draftLimiter, attachmentLimiter } = context;

  const authorProject = authorProjectOrReply;
  const projectSummary = (userId: string, projectId: string) => projectSummaryDto(appConfig, userId, projectId);
  const manuscriptResponse = manuscriptDto;

  function sendRefusal(reply: FastifyReply, error: unknown): boolean {
    if (error instanceof ManuscriptContentRefusal) {
      sendManuscriptContentRefusal(reply, error);
      return true;
    }
    if (error instanceof ManuscriptWriteRefusal || error instanceof ManuscriptPublishRefusal) {
      sendMobileError(reply, error.status, error.code, error.message);
      return true;
    }
    return false;
  }

  fastify.post(
    "/api/mobile/projects/studio",
    {
      attachValidation: true,
      schema: {
        tags: ["mobile"],
        body: studioProjectCreateOpenApiBody,
        response: { 200: {}, 201: {}, 401: mobileAuthError, 422: manuscriptContentRestrictedError }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      if (!hitAuthenticatedLimit(draftLimiter, reply, auth.user.id, "studio-create")) return;
      const parsed = studioProjectCreateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Choose what kind of book you're writing.");
      }
      if (!(await enforceStudioFieldRestrictions(reply, { title: parsed.data.title }))) return;
      const { projectId, created } = await createStudioProject(auth.user.id, parsed.data);
      const project = await loadManuscriptProject(auth.user.id, projectId);
      const summary = await projectSummary(auth.user.id, projectId);
      if (!project || !summary) {
        return sendProjectNotFound(reply);
      }
      const manuscript = await ensureManuscript(project);
      const first = manuscript.chapters.find((chapter) => chapter.deletedAt === null) ?? manuscript.chapters[0];
      if (!first) {
        return sendProjectNotFound(reply);
      }
      return reply.code(created ? 201 : 200).send({
        project: summary,
        manuscript: serializeManuscript(project, manuscript, await manuscriptWireContext(project)),
        chapter: serializeChapter(first)
      } satisfies StudioProjectCreateResponseDto);
    }
  );

  fastify.get(
    "/api/mobile/projects/:id/manuscript",
    { schema: { tags: ["mobile"], response: errorResponses } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      const { id } = idParamsSchema.parse(request.params);
      const project = await authorProject(reply, auth.user.id, id);
      if (!project) return;
      const manuscript = await openManuscript(project);
      return {
        manuscript: serializeManuscript(project, manuscript, await manuscriptWireContext(project))
      } satisfies ManuscriptResponseDto;
    }
  );

  fastify.get(
    "/api/mobile/projects/:id/manuscript/chapters/:cid",
    { schema: { tags: ["mobile"], response: errorResponses } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      const { id, cid } = manuscriptChapterParamsSchema.parse(request.params);
      const project = await authorProject(reply, auth.user.id, id);
      if (!project) return;
      const manuscript = await ensureManuscript(project);
      const chapter = manuscript.chapters.find((candidate) => candidate.id === cid && candidate.deletedAt === null);
      if (!chapter) {
        return sendMobileError(reply, 404, "CHAPTER_NOT_FOUND", "That chapter no longer exists.");
      }
      return { chapter: serializeChapter(chapter) } satisfies ManuscriptChapterResponseDto;
    }
  );

  fastify.put(
    "/api/mobile/projects/:id/manuscript/chapters/:cid",
    // The 409 schema is open on purpose: the conflict carries the server's copy
    // inside `error`, and `mobileAuthError` would serialize it away.
    {
      attachValidation: true,
      schema: { tags: ["mobile"], body: manuscriptChapterSaveOpenApiBody, response: { ...errorResponses, 409: {} } }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      const { id, cid } = manuscriptChapterParamsSchema.parse(request.params);
      const parsed = manuscriptChapterSaveBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "This chapter could not be saved as sent.");
      }
      const project = await authorProject(reply, auth.user.id, id);
      if (!project) return;
      const manuscript = await ensureManuscript(project);
      const outcome = await saveManuscriptChapter(project, manuscript.id, cid, parsed.data);
      if (outcome.kind === "not_found") {
        return sendMobileError(reply, 404, "CHAPTER_NOT_FOUND", "That chapter no longer exists.");
      }
      if (outcome.kind === "conflict") {
        // The app's `ApiException.details` is the `error` object and nothing
        // else, so the copy it needs for the three-way choice rides inside it.
        return reply.code(409).send({
          error: { code: "CHAPTER_CONFLICT", message: CHAPTER_CONFLICT_MESSAGE, chapter: serializeChapter(outcome.chapter) }
        });
      }
      return {
        chapter: serializeChapterSummary(outcome.chapter),
        manuscriptRevision: outcome.manuscriptRevision,
        savedAt: outcome.savedAt.toISOString()
      } satisfies ManuscriptChapterSaveResponseDto;
    }
  );

  fastify.post(
    "/api/mobile/projects/:id/manuscript/chapters",
    { attachValidation: true, schema: { tags: ["mobile"], body: manuscriptChapterCreateOpenApiBody, response: errorResponses } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      if (!hitAuthenticatedLimit(draftLimiter, reply, auth.user.id, "studio-chapter")) return;
      const { id } = idParamsSchema.parse(request.params);
      const parsed = manuscriptChapterCreateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "This chapter could not be added as sent.");
      }
      const project = await authorProject(reply, auth.user.id, id);
      if (!project) return;
      const manuscript = await ensureManuscript(project);
      try {
        const chapter = await addManuscriptChapter(manuscript.id, parsed.data);
        const dto = await manuscriptResponse(auth.user.id, id);
        if (!dto) return sendProjectNotFound(reply);
        return { chapter: serializeChapter(chapter), manuscript: dto } satisfies ManuscriptChapterCreateResponseDto;
      } catch (error) {
        if (sendRefusal(reply, error)) return;
        throw error;
      }
    }
  );

  fastify.delete(
    "/api/mobile/projects/:id/manuscript/chapters/:cid",
    { schema: { tags: ["mobile"], response: errorResponses } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      const { id, cid } = manuscriptChapterParamsSchema.parse(request.params);
      const project = await authorProject(reply, auth.user.id, id);
      if (!project) return;
      const manuscript = await ensureManuscript(project);
      try {
        await deleteManuscriptChapter(manuscript.id, cid);
      } catch (error) {
        if (sendRefusal(reply, error)) return;
        throw error;
      }
      const dto = await manuscriptResponse(auth.user.id, id);
      return dto ? ({ manuscript: dto } satisfies ManuscriptResponseDto) : sendProjectNotFound(reply);
    }
  );

  fastify.post(
    "/api/mobile/projects/:id/manuscript/chapters/:cid/restore",
    { schema: { tags: ["mobile"], response: errorResponses } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      const { id, cid } = manuscriptChapterParamsSchema.parse(request.params);
      const project = await authorProject(reply, auth.user.id, id);
      if (!project) return;
      const manuscript = await ensureManuscript(project);
      try {
        await restoreManuscriptChapter(manuscript.id, cid);
      } catch (error) {
        if (sendRefusal(reply, error)) return;
        throw error;
      }
      const dto = await manuscriptResponse(auth.user.id, id);
      return dto ? ({ manuscript: dto } satisfies ManuscriptResponseDto) : sendProjectNotFound(reply);
    }
  );

  fastify.post(
    "/api/mobile/projects/:id/manuscript/order",
    { attachValidation: true, schema: { tags: ["mobile"], body: manuscriptOrderOpenApiBody, response: errorResponses } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      const { id } = idParamsSchema.parse(request.params);
      const parsed = manuscriptOrderBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "ORDER_MISMATCH", "Send every chapter in its new order.");
      }
      const project = await authorProject(reply, auth.user.id, id);
      if (!project) return;
      const manuscript = await ensureManuscript(project);
      try {
        await reorderManuscriptChapters(manuscript.id, parsed.data.chapterIds);
      } catch (error) {
        if (sendRefusal(reply, error)) return;
        throw error;
      }
      const dto = await manuscriptResponse(auth.user.id, id);
      return dto ? ({ manuscript: dto } satisfies ManuscriptResponseDto) : sendProjectNotFound(reply);
    }
  );

  fastify.patch(
    "/api/mobile/projects/:id/manuscript/settings",
    {
      attachValidation: true,
      schema: {
        tags: ["mobile"],
        body: manuscriptSettingsOpenApiBody,
        response: { ...errorResponses, 422: manuscriptContentRestrictedError }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      const { id } = idParamsSchema.parse(request.params);
      const parsed = manuscriptSettingsBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Those book settings could not be saved. A title needs at least two characters.");
      }
      // The body's own fields, as the write stores them (`manuscriptContentScreen.ts`).
      if (!(await enforceStudioFieldRestrictions(reply, parsed.data))) return;
      const project = await authorProject(reply, auth.user.id, id);
      if (!project) return;
      const manuscript = await ensureManuscript(project);
      try {
        await updateManuscriptSettings(project, manuscript.id, parsed.data);
      } catch (error) {
        if (sendRefusal(reply, error)) return;
        throw error;
      }
      const dto = await manuscriptResponse(auth.user.id, id);
      return dto ? ({ manuscript: dto } satisfies ManuscriptResponseDto) : sendProjectNotFound(reply);
    }
  );

  fastify.get(
    "/api/mobile/projects/:id/manuscript/chapters/:cid/versions",
    { schema: { tags: ["mobile"], response: errorResponses } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      const { id, cid } = manuscriptChapterParamsSchema.parse(request.params);
      const project = await authorProject(reply, auth.user.id, id);
      if (!project) return;
      const manuscript = await ensureManuscript(project);
      if (!manuscript.chapters.some((chapter) => chapter.id === cid)) {
        return sendMobileError(reply, 404, "CHAPTER_NOT_FOUND", "That chapter no longer exists.");
      }
      const versions = await prisma.manuscriptVersion.findMany({
        where: { chapterId: cid },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: { id: true, reason: true, title: true, wordCount: true, createdAt: true }
      });
      return { versions: versions.map(serializeVersionSummary) } satisfies ManuscriptVersionsResponseDto;
    }
  );

  fastify.get(
    "/api/mobile/projects/:id/manuscript/chapters/:cid/versions/:vid",
    { schema: { tags: ["mobile"], response: errorResponses } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      const { id, cid, vid } = manuscriptVersionParamsSchema.parse(request.params);
      const project = await authorProject(reply, auth.user.id, id);
      if (!project) return;
      const manuscript = await ensureManuscript(project);
      if (!manuscript.chapters.some((chapter) => chapter.id === cid)) {
        return sendMobileError(reply, 404, "CHAPTER_NOT_FOUND", "That chapter no longer exists.");
      }
      const version = await prisma.manuscriptVersion.findFirst({ where: { id: vid, chapterId: cid } });
      if (!version) {
        return sendMobileError(reply, 404, "VERSION_NOT_FOUND", "That version no longer exists.");
      }
      return { version: serializeVersion(version) } satisfies ManuscriptVersionResponseDto;
    }
  );

  fastify.put(
    "/api/mobile/projects/:id/manuscript/images",
    {
      bodyLimit: MANUSCRIPT_IMAGE_MAX_BYTES + 64 * 1024,
      errorHandler: sendUnreadableBodyError,
      schema: { tags: ["mobile"], response: errorResponses }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      if (!hitAuthenticatedLimit(attachmentLimiter, reply, auth.user.id, "manuscript-image")) return;
      const { id } = idParamsSchema.parse(request.params);
      const query = manuscriptImageQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send the picture with a filename.");
      }
      const data = request.body;
      if (!Buffer.isBuffer(data) || data.length === 0) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send the picture as the request body.");
      }
      const project = await authorProject(reply, auth.user.id, id);
      if (!project) return;
      const mimeType = manuscriptImageType(query.data.contentType, query.data.filename);
      const stored = mimeType ? await storeManuscriptImage(project.id, data, mimeType) : null;
      if (!stored) {
        return sendMobileError(reply, 415, "UNSUPPORTED_IMAGE", "Use a JPEG, PNG, WebP or HEIC picture.");
      }
      // Named, not spread: the stored record carries its object name and size too.
      return { url: stored.url, width: stored.width, height: stored.height } satisfies ManuscriptImageUploadResponseDto;
    }
  );

  fastify.post(
    "/api/mobile/projects/:id/manuscript/publish",
    // The 422 names the refused chapters; `mobileAuthError` would drop them.
    {
      attachValidation: true,
      schema: {
        tags: ["mobile"],
        body: manuscriptPublishOpenApiBody,
        response: { ...errorResponses, 422: manuscriptContentRestrictedError }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      const { id } = idParamsSchema.parse(request.params);
      const parsed = manuscriptPublishBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send a request id with the publish.");
      }
      const project = await authorProject(reply, auth.user.id, id);
      if (!project) return;
      if (parsed.data.dryRun) {
        return { checklist: await publishChecklist(project) } satisfies ManuscriptPublishDryRunResponseDto;
      }
      try {
        await publishManuscript({ project, requestId: parsed.data.requestId, bookStorageDir: appConfig.BOOK_STORAGE_DIR });
      } catch (error) {
        if (sendRefusal(reply, error)) return;
        throw error;
      }
      const [summary, manuscript] = await Promise.all([
        projectSummary(auth.user.id, id),
        manuscriptResponse(auth.user.id, id)
      ]);
      if (!summary || !manuscript) {
        return sendProjectNotFound(reply);
      }
      return { project: summary, manuscript } satisfies ManuscriptPublishResponseDto;
    }
  );
}
