import { type MobileProjectCreateResponseDto, type MobileProjectRecord } from "../dto.js";
import { hitTieredLimit, requireMobileAuth, sendMobileError, sendProjectNotFound } from "../httpErrors.js";
import { buildMobileCreateProjectInput, createMobileProjectRecord, mobileProjectSummaryInclude } from "../projectRecords.js";
import { manuscriptSummarySelect } from "../manuscript/manuscriptSerializers.js";
import { serializeProjectDetail, serializeProjectSummary } from "../projectSummarySerializers.js";
import {
  MOBILE_PRODUCT_PRESETS,
  idParamsSchema,
  mobileAuthError,
  mobileProjectCreateBodySchema,
  mobileProjectCreateOpenApiBody
} from "../schemas.js";
import { sendUltraTierUnavailable, ultraTierRefused } from "../ultraTier.js";
import { prisma } from "@book-maker/db";
import type { FastifyInstance } from "fastify";
import type { MobileRouteContext } from "../routeContext.js";
import { enforceContentRestrictions } from "../../contentRestrictions.js";
import { hydrateSourceAttachments, sourceReadinessError } from "../sourceAttachments.js";

/**
 * Project list, create and detail.
 */

export async function registerMobileProjectRoutes(fastify: FastifyInstance, context: MobileRouteContext): Promise<void> {
  const { appConfig, generationLimiter } = context;

  fastify.get(
    "/api/mobile/projects",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }

      const projects = (await prisma.project.findMany({
        where: { userId: auth.user.id },
        orderBy: { updatedAt: "desc" },
        // Only the cover: the library renders cover art per project, and
        // pulling every page visual here would be a large payload for a list.
        include: mobileProjectSummaryInclude()
      })) as MobileProjectRecord[];

      return {
        projects: await Promise.all(projects.map((project) => serializeProjectSummary(project, appConfig)))
      };
    }
  );

  fastify.post(
    "/api/mobile/projects",
    {
      attachValidation: true,
      schema: {
        tags: ["mobile"],
        body: mobileProjectCreateOpenApiBody
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!(await hitTieredLimit(generationLimiter, reply, auth.user.id, "create-project"))) {
        return;
      }

      const parsed = mobileProjectCreateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Provide a book type, prompt, and supported mobile presets.");
      }
      if (!(await enforceContentRestrictions(reply, parsed.data.prompt))) {
        return;
      }
      // A draft at Ultra could never be planned while the operator has it off
      // (`ultraTier.ts`), so it is not created either.
      if (ultraTierRefused(MOBILE_PRODUCT_PRESETS[parsed.data.qualityPreset].modelTier)) {
        return sendUltraTierUnavailable(reply);
      }

      // Character snapshots are only ever minted by the session build, which
      // re-reads the user's own library rows. A client-supplied snapshot here
      // could name another user's portrait file, so it is discarded, not
      // trusted.
      const createInput = parsed.data.creationPayload?.characters
        ? {
            ...parsed.data,
            creationPayload: (({ characters: _characters, ...rest }) => rest)(parsed.data.creationPayload)
          }
        : parsed.data;
      if (createInput.creationPayload) {
        const payload = createInput.creationPayload;
        payload.attachments = await hydrateSourceAttachments(auth.user.id, payload.attachments ?? []);
        const sourceError = sourceReadinessError(payload.attachments, payload.messages ?? []);
        if (sourceError) return sendMobileError(reply, 409, sourceError.code, sourceError.message);
      }
      const project = await createMobileProjectRecord(auth.user.id, buildMobileCreateProjectInput(createInput));

      return reply.code(201).send({ project: await serializeProjectDetail(project, appConfig) } satisfies MobileProjectCreateResponseDto);
    }
  );

  fastify.get(
    "/api/mobile/projects/:id",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const project = (await prisma.project.findFirst({
        where: { id, userId: auth.user.id },
        include: {
          currentPlan: true,
          pages: {
            orderBy: { index: "asc" },
            select: {
              id: true,
              index: true,
              title: true,
              markdown: true,
              summary: true,
              status: true,
              images: {
                select: { id: true, projectId: true, pageId: true, type: true, path: true, metadata: true },
                orderBy: { createdAt: "asc" }
              }
            }
          },
          images: { select: { id: true, projectId: true, pageId: true, type: true, path: true, metadata: true } },
          _count: { select: { pages: true, images: true, jobs: true } },
          manuscript: manuscriptSummarySelect
        }
      })) as MobileProjectRecord | null;
      if (!project) {
        return sendProjectNotFound(reply);
      }
      return { project: await serializeProjectDetail(project, appConfig) };
    }
  );
}
