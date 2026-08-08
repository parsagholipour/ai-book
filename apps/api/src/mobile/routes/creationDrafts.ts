import {
  adviseMobileBook,
  mergeMobileCreationPresets,
  mobileBookAdvisorBodySchema,
  mobileCreationDraftPayloadSchema,
  type MobileCreationPresetsInput
} from "../../mobileCreation.js";
import { serializeCreationDraft } from "../creationSessions.js";
import { type MobileBookAdvisorResponseDto, type MobileCreationDraftResponseDto } from "../dto.js";
import { hitAuthenticatedLimit, hitTieredLimit, requireMobileAuth, sendMobileError } from "../httpErrors.js";
import { idParamsSchema, mobileAuthError } from "../schemas.js";
import { jsonInputValue } from "../support.js";
import { prisma } from "@book-maker/db";
import type { FastifyInstance } from "fastify";
import { createCreationBuildHelpers, sendFinalizeOutcome } from "../creationBuild.js";
import type { MobileRouteContext } from "../routeContext.js";

/**
 * Legacy single-draft creation flow plus the book advisor.
 */

export async function registerMobileCreationDraftRoutes(fastify: FastifyInstance, context: MobileRouteContext): Promise<void> {
  const { generationLimiter, advisorLimiter, draftLimiter, advisorEnrichment, options } = context;
  const { finalizeMobileCreationDraft } = createCreationBuildHelpers(context);

  fastify.get(
    "/api/mobile/creation-drafts/active",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const draft = await prisma.mobileCreationDraft.findFirst({
        where: { userId: auth.user.id, status: "ACTIVE" },
        orderBy: { updatedAt: "desc" }
      });
      return { draft: serializeCreationDraft(draft) } satisfies MobileCreationDraftResponseDto;
    }
  );

  fastify.post(
    "/api/mobile/creation-drafts",
    { attachValidation: true, schema: { tags: ["mobile"] } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(draftLimiter, request, reply, auth.user.id, "creation-draft")) {
        return;
      }
      const parsed = mobileCreationDraftPayloadSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send a valid creation brief.");
      }
      const draft = await prisma.mobileCreationDraft.create({
        data: {
          userId: auth.user.id,
          status: "ACTIVE",
          payload: jsonInputValue(parsed.data)
        }
      });
      return reply.code(201).send({ draft: serializeCreationDraft(draft) } satisfies MobileCreationDraftResponseDto);
    }
  );

  fastify.patch(
    "/api/mobile/creation-drafts/:id",
    { attachValidation: true, schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError, 409: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(draftLimiter, request, reply, auth.user.id, "creation-draft")) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const parsed = mobileCreationDraftPayloadSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send a valid creation brief.");
      }
      const existing = await prisma.mobileCreationDraft.findFirst({
        where: { id, userId: auth.user.id }
      });
      if (!existing) {
        return sendMobileError(reply, 404, "DRAFT_NOT_FOUND", "Creation draft not found.");
      }
      if (existing.status !== "ACTIVE") {
        return sendMobileError(reply, 409, "DRAFT_NOT_ACTIVE", "This creation draft is no longer active.");
      }
      const existingPayload = mobileCreationDraftPayloadSchema.safeParse(existing.payload);
      const rawSelectedPresets = (request.body as { selectedPresets?: unknown } | null)?.selectedPresets;
      const payload =
        existingPayload.success && rawSelectedPresets && typeof rawSelectedPresets === "object" && !Array.isArray(rawSelectedPresets)
          ? mobileCreationDraftPayloadSchema.parse({
              ...parsed.data,
              selectedPresets: mergeMobileCreationPresets(
                existingPayload.data.selectedPresets,
                rawSelectedPresets as MobileCreationPresetsInput
              )
            })
          : parsed.data;
      const draft = await prisma.mobileCreationDraft.update({
        where: { id },
        data: { payload: jsonInputValue(payload) }
      });
      return { draft: serializeCreationDraft(draft) } satisfies MobileCreationDraftResponseDto;
    }
  );

  fastify.post(
    "/api/mobile/book-advisor",
    { attachValidation: true, schema: { tags: ["mobile"] } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!(await hitTieredLimit(advisorLimiter, request, reply, auth.user.id, "book-advisor"))) {
        return;
      }
      const parsed = mobileBookAdvisorBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send a valid creation brief.");
      }
      const advisor = await adviseMobileBook(parsed.data, {
        enrich: advisorEnrichment,
        timeoutMs: options.advisorTimeoutMs
      });
      return { advisor } satisfies MobileBookAdvisorResponseDto;
    }
  );

  fastify.post(
    "/api/mobile/creation-drafts/:id/create-project",
    { attachValidation: true, schema: { tags: ["mobile"], response: { 201: {}, 401: mobileAuthError, 404: mobileAuthError, 409: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!(await hitTieredLimit(generationLimiter, request, reply, auth.user.id, "creation-finalize"))) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      return sendFinalizeOutcome(reply, await finalizeMobileCreationDraft(auth.user.id, id));
    }
  );
}
