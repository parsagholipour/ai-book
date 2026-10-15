import { prisma } from "@book-maker/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  hitAuthenticatedLimit,
  requireMobileAuth,
  sendGenerationAttemptError,
  sendMobileError,
  sendProjectNotFound,
  sendUnreadableBodyError
} from "../httpErrors.js";
import {
  generateManuscriptCover,
  ManuscriptCoverRefusal,
  resetManuscriptCover,
  uploadManuscriptCover
} from "../manuscript/manuscriptCover.js";
import { ensureManuscript, loadManuscriptProject } from "../manuscript/manuscriptDerivation.js";
import type { ManuscriptFromPlanResponseDto, ManuscriptResponseDto } from "../manuscript/manuscriptDto.js";
import { convertPlanToManuscript, PlanConversionRefusal } from "../manuscript/manuscriptFromPlan.js";
import { manuscriptImageType } from "../manuscript/manuscriptImages.js";
import {
  MANUSCRIPT_IMAGE_MAX_BYTES,
  manuscriptImageQuerySchema,
  manuscriptRequestBodySchema,
  manuscriptRequestOpenApiBody
} from "../manuscript/manuscriptSchemas.js";
import type { MobileRouteContext } from "../routeContext.js";
import { idParamsSchema, mobileAuthError } from "../schemas.js";
import { authorProjectOrReply, manuscriptDto, projectSummaryDto } from "./manuscriptRouteSupport.js";
import { requireAiCapacity } from "../aiCapacity.js";

/**
 * The publish sheet's cover (spec "Covers") and the plan-review door into the
 * Studio ("I'll write it myself", Phase 3). Every answer here is the
 * manuscript DTO, whose `cover` says what the book now wears.
 */

const errorResponses = { 401: mobileAuthError, 404: mobileAuthError } as const;

function sendCoverRefusal(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof ManuscriptCoverRefusal || error instanceof PlanConversionRefusal) {
    sendMobileError(reply, error.status, error.code, error.message);
    return true;
  }
  return false;
}

export async function registerMobileManuscriptCoverRoutes(fastify: FastifyInstance, context: MobileRouteContext): Promise<void> {
  const { appConfig, draftLimiter, attachmentLimiter } = context;

  /** The working copy's first-publish stamp, which is what "published" means for a Studio book. */
  async function firstPublishedAt(projectId: string): Promise<Date | null> {
    const row = await prisma.manuscript.findUnique({ where: { projectId }, select: { firstPublishedAt: true } });
    return row?.firstPublishedAt ?? null;
  }

  async function manuscriptReply(reply: FastifyReply, userId: string, projectId: string) {
    const dto = await manuscriptDto(userId, projectId);
    return dto ? ({ manuscript: dto } satisfies ManuscriptResponseDto) : sendProjectNotFound(reply);
  }

  fastify.put(
    "/api/mobile/projects/:id/manuscript/cover",
    {
      bodyLimit: MANUSCRIPT_IMAGE_MAX_BYTES + 64 * 1024,
      errorHandler: sendUnreadableBodyError,
      schema: { tags: ["mobile"], response: errorResponses }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      if (!hitAuthenticatedLimit(attachmentLimiter, reply, auth.user.id, "manuscript-cover")) return;
      const { id } = idParamsSchema.parse(request.params);
      const query = manuscriptImageQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send the picture with a filename.");
      }
      const data = request.body;
      if (!Buffer.isBuffer(data) || data.length === 0) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send the picture as the request body.");
      }
      const project = await authorProjectOrReply(reply, auth.user.id, id);
      if (!project) return;
      await ensureManuscript(project);
      const mimeType = manuscriptImageType(query.data.contentType, query.data.filename);
      if (!mimeType) {
        return sendMobileError(reply, 415, "UNSUPPORTED_IMAGE", "Use a JPEG, PNG, WebP or HEIC picture.");
      }
      try {
        const stored = await uploadManuscriptCover({
          project,
          firstPublishedAt: await firstPublishedAt(project.id),
          bytes: data,
          mimeType,
          publicApiUrl: appConfig.PUBLIC_API_URL
        });
        if (stored === "unsupported") {
          return sendMobileError(reply, 415, "UNSUPPORTED_IMAGE", "Use a JPEG, PNG, WebP or HEIC picture.");
        }
      } catch (error) {
        if (sendCoverRefusal(reply, error)) return;
        throw error;
      }
      return manuscriptReply(reply, auth.user.id, project.id);
    }
  );

  fastify.post(
    "/api/mobile/projects/:id/manuscript/cover/generate",
    { attachValidation: true, schema: { tags: ["mobile"], body: manuscriptRequestOpenApiBody, response: errorResponses } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      const { id } = idParamsSchema.parse(request.params);
      const parsed = manuscriptRequestBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send a request id with the cover.");
      }
      // A drawn cover is an image call; ahead of the limiter so a refusal spends no bucket.
      if (!(await requireAiCapacity(request, reply, auth.user.id, "standard"))) return;
      if (!hitAuthenticatedLimit(draftLimiter, reply, auth.user.id, "manuscript-cover-generate")) return;
      const project = await authorProjectOrReply(reply, auth.user.id, id);
      if (!project) return;
      await ensureManuscript(project);
      try {
        await generateManuscriptCover({
          userId: auth.user.id,
          project,
          firstPublishedAt: await firstPublishedAt(project.id),
          requestId: parsed.data.requestId
        });
      } catch (error) {
        if (sendCoverRefusal(reply, error) || sendGenerationAttemptError(reply, error)) return;
        throw error;
      }
      return manuscriptReply(reply, auth.user.id, project.id);
    }
  );

  fastify.delete(
    "/api/mobile/projects/:id/manuscript/cover",
    { schema: { tags: ["mobile"], response: errorResponses } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      const { id } = idParamsSchema.parse(request.params);
      const project = await authorProjectOrReply(reply, auth.user.id, id);
      if (!project) return;
      await ensureManuscript(project);
      try {
        await resetManuscriptCover({ project, firstPublishedAt: await firstPublishedAt(project.id) });
      } catch (error) {
        if (sendCoverRefusal(reply, error)) return;
        throw error;
      }
      return manuscriptReply(reply, auth.user.id, project.id);
    }
  );

  fastify.post(
    "/api/mobile/projects/:id/manuscript/from-plan",
    { attachValidation: true, schema: { tags: ["mobile"], body: manuscriptRequestOpenApiBody, response: errorResponses } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      const { id } = idParamsSchema.parse(request.params);
      const parsed = manuscriptRequestBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send a request id with the request.");
      }
      if (!hitAuthenticatedLimit(draftLimiter, reply, auth.user.id, "studio-from-plan")) return;
      // Not the author gate: the book this starts from is still a generated one.
      const project = await loadManuscriptProject(auth.user.id, id);
      if (!project) {
        return sendProjectNotFound(reply);
      }
      try {
        await convertPlanToManuscript({ project, requestId: parsed.data.requestId });
      } catch (error) {
        if (sendCoverRefusal(reply, error)) return;
        throw error;
      }
      const [summary, manuscript] = await Promise.all([
        projectSummaryDto(appConfig, auth.user.id, id),
        manuscriptDto(auth.user.id, id)
      ]);
      if (!summary || !manuscript) {
        return sendProjectNotFound(reply);
      }
      return { project: summary, manuscript } satisfies ManuscriptFromPlanResponseDto;
    }
  );
}
