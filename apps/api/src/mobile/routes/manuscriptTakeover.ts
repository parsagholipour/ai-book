import type { FastifyInstance } from "fastify";
import { hitAuthenticatedLimit, requireMobileAuth, sendMobileError, sendProjectNotFound } from "../httpErrors.js";
import { manuscriptWireContext } from "../manuscript/manuscriptCover.js";
import { loadManuscriptProject, manuscriptAccessRefusal, openManuscript } from "../manuscript/manuscriptDerivation.js";
import type { ManuscriptTakeoverResponseDto } from "../manuscript/manuscriptDto.js";
import { manuscriptRequestBodySchema, manuscriptRequestOpenApiBody } from "../manuscript/manuscriptSchemas.js";
import { serializeManuscript } from "../manuscript/manuscriptSerializers.js";
import { ManuscriptTakeoverRefusal, takeOverGeneratedBook } from "../manuscript/manuscriptTakeover.js";
import type { MobileRouteContext } from "../routeContext.js";
import { idParamsSchema, mobileAuthError } from "../schemas.js";
import { projectSummaryDto } from "./manuscriptRouteSupport.js";

/**
 * "Continue in Writing Studio" (`.scratch/writing-studio/takeover.md`): the
 * owner of a finished generated book takes it over as their own manuscript.
 * Free and idempotent by `requestId`; a book that is already the author's
 * answers its current state, so a second device's tap simply opens the Studio.
 */

const errorResponses = { 401: mobileAuthError, 404: mobileAuthError, 409: mobileAuthError } as const;

export async function registerMobileManuscriptTakeoverRoutes(fastify: FastifyInstance, context: MobileRouteContext): Promise<void> {
  const { appConfig, draftLimiter } = context;

  fastify.post(
    "/api/mobile/projects/:id/manuscript/takeover",
    { attachValidation: true, schema: { tags: ["mobile"], body: manuscriptRequestOpenApiBody, response: errorResponses } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      const { id } = idParamsSchema.parse(request.params);
      const parsed = manuscriptRequestBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send a request id with the request.");
      }
      if (!hitAuthenticatedLimit(draftLimiter, reply, auth.user.id, "studio-takeover")) return;
      // Not the author gate: the book this starts from is still a generated one.
      const project = await loadManuscriptProject(auth.user.id, id);
      if (!project) {
        return sendProjectNotFound(reply);
      }
      try {
        await takeOverGeneratedBook({ project, requestId: parsed.data.requestId, bookStorageDir: appConfig.BOOK_STORAGE_DIR });
      } catch (error) {
        if (error instanceof ManuscriptTakeoverRefusal) {
          return sendMobileError(reply, error.status, error.code, error.message);
        }
        throw error;
      }
      const current = await loadManuscriptProject(auth.user.id, id);
      if (!current) {
        return sendProjectNotFound(reply);
      }
      // An import still running is an author's book with nothing to open yet.
      const refusal = manuscriptAccessRefusal(current);
      if (refusal) {
        return sendMobileError(reply, refusal.status, refusal.code, refusal.message);
      }
      const [summary, manuscript] = await Promise.all([projectSummaryDto(appConfig, auth.user.id, id), openManuscript(current)]);
      if (!summary) {
        return sendProjectNotFound(reply);
      }
      return {
        project: summary,
        manuscript: serializeManuscript(current, manuscript, await manuscriptWireContext(current))
      } satisfies ManuscriptTakeoverResponseDto;
    }
  );
}
