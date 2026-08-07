import { type MobileProjectCreateResponseDto, type MobileProjectRecord } from "../dto.js";
import { hitAuthenticatedLimit, requireMobileAuth, sendMobileError } from "../httpErrors.js";
import { buildMobileCreateProjectInput, createMobileProjectRecord } from "../projectRecords.js";
import { serializeProjectDetail, serializeProjectSummary } from "../projectSerializers.js";
import { idParamsSchema, mobileAuthError, mobileProjectCreateBodySchema, mobileProjectCreateOpenApiBody } from "../schemas.js";
import { prisma } from "@book-maker/db";
import type { FastifyInstance } from "fastify";
import type { MobileRouteContext } from "../routeContext.js";
import { enforceContentRestrictions } from "../../contentRestrictions.js";

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
        include: {
          currentPlan: true,
          // Only the cover: the library renders cover art per project, and
          // pulling every page visual here would be a large payload for a list.
          images: { where: { type: "COVER" }, orderBy: { createdAt: "desc" }, take: 1 },
          _count: { select: { pages: true, images: true, jobs: true } }
        }
      })) as MobileProjectRecord[];

      return {
        projects: await Promise.all(projects.map((project) => serializeProjectSummary(project, appConfig, auth.user.id)))
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
      if (!hitAuthenticatedLimit(generationLimiter, request, reply, auth.user.id, "create-project")) {
        return;
      }

      const parsed = mobileProjectCreateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Provide a book type, prompt, and supported mobile presets.");
      }
      if (!(await enforceContentRestrictions(reply, parsed.data.prompt))) {
        return;
      }

      const project = await createMobileProjectRecord(auth.user.id, buildMobileCreateProjectInput(parsed.data));

      return reply.code(201).send({ project: await serializeProjectDetail(project, appConfig, auth.user.id) } satisfies MobileProjectCreateResponseDto);
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
          _count: { select: { pages: true, images: true, jobs: true } }
        }
      })) as MobileProjectRecord | null;
      if (!project) {
        return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
      }
      return { project: await serializeProjectDetail(project, appConfig, auth.user.id) };
    }
  );
}
