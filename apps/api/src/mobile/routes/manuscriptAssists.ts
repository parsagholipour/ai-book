import {
  AuthorAssistInputError,
  modelTierFromMediaSettings,
  validateQuickAuthorAssistRequest,
  type QuickAuthorAssistRequest
} from "@book-maker/core";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { z } from "zod";
import { contentRestrictedError, enforceContentRestrictions } from "../../contentRestrictions.js";
import { withInlineProviderUsage } from "../../inlineProviderUsage.js";
import { hitAuthenticatedLimit, requireMobileAuth, sendGenerationAttemptError, sendMobileError } from "../httpErrors.js";
import {
  createLongAssist,
  dismissAssist,
  findAssist,
  listAssists,
  ManuscriptAssistRefusal,
  markAssistApplied,
  serializeAssist
} from "../manuscript/manuscriptAssists.js";
import { ensureManuscript } from "../manuscript/manuscriptDerivation.js";
import type {
  ManuscriptAssistResponseDto,
  ManuscriptAssistsResponseDto,
  ManuscriptQuickAssistResponseDto
} from "../manuscript/manuscriptDto.js";
import { runStudioQuickAssist, studioAssistBook } from "../manuscript/manuscriptQuickAssist.js";
import {
  manuscriptAssistCreateBodySchema,
  manuscriptAssistCreateOpenApiBody,
  manuscriptAssistListQuerySchema,
  manuscriptAssistParamsSchema,
  manuscriptQuickAssistBodySchema,
  manuscriptQuickAssistOpenApiBody
} from "../manuscript/manuscriptSchemas.js";
import { liveChapters } from "../manuscript/manuscriptStore.js";
import { messageRequestKey, withMessageUsage } from "../messageUsage.js";
import type { MobileRouteContext } from "../routeContext.js";
import { idParamsSchema, mobileAuthError } from "../schemas.js";
import { authorProjectOrReply } from "./manuscriptRouteSupport.js";

/**
 * The Writing Studio's AI (spec "Phase 2 + 3 contract"): the quick assists,
 * which answer inside the request and spend one chat message, and the long
 * ones, which are priced `WRITING_ASSIST` jobs the app polls.
 */

const errorResponses = { 401: mobileAuthError, 404: mobileAuthError } as const;
/** The two routes that take a typed request, which is screened like a chat message. */
const requestResponses = { ...errorResponses, 422: contentRestrictedError } as const;

const ASSIST_UNAVAILABLE_MESSAGE = "The writing assistant couldn’t answer just now. Try again in a moment.";

/** A body zod refused: too long is the runner's own code; anything else is a malformed request. */
function quickAssistValidationCode(error: z.ZodError): string {
  return error.issues.some((issue) => issue.code === "too_big") ? "INPUT_TOO_LONG" : "INVALID_ASSIST";
}

function sendAssistRefusal(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof ManuscriptAssistRefusal) {
    sendMobileError(reply, error.status, error.code, error.message);
    return true;
  }
  return false;
}

export async function registerMobileManuscriptAssistRoutes(fastify: FastifyInstance, context: MobileRouteContext): Promise<void> {
  // The draft limiter (120 an hour) for both: the long assists are paid, and a
  // picture book illustrated page by page is a burst of them.
  const { draftLimiter } = context;

  fastify.post(
    "/api/mobile/projects/:id/manuscript/assist",
    { attachValidation: true, schema: { tags: ["mobile"], body: manuscriptQuickAssistOpenApiBody, response: requestResponses } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      const { id } = idParamsSchema.parse(request.params);
      const parsed = manuscriptQuickAssistBodySchema.safeParse(request.body);
      if (!parsed.success) {
        const code = quickAssistValidationCode(parsed.error);
        return sendMobileError(
          reply,
          400,
          code,
          code === "INPUT_TOO_LONG" ? "That selection is too long for the assistant. Select less text." : "That request could not be read."
        );
      }
      if (!hitAuthenticatedLimit(draftLimiter, reply, auth.user.id, "studio-assist")) return;
      // The author's typed request, screened as the book chat screens its
      // message — before a message slot is taken. The selection is the
      // author's own text, screened when it is published.
      if (parsed.data.instruction?.trim() && !(await enforceContentRestrictions(reply, parsed.data.instruction))) return;
      const project = await authorProjectOrReply(reply, auth.user.id, id);
      if (!project) return;
      const manuscript = await ensureManuscript(project);
      const chapter = liveChapters(manuscript.chapters).find((candidate) => candidate.id === parsed.data.chapterId);
      if (!chapter) {
        return sendMobileError(reply, 404, "CHAPTER_NOT_FOUND", "That chapter no longer exists.");
      }
      const body = parsed.data;
      const assistRequest: QuickAuthorAssistRequest = {
        kind: body.kind,
        book: await studioAssistBook(project, manuscript.settings),
        chapter: { title: chapter.title, notes: chapter.notes },
        ...(body.selection !== undefined ? { selection: body.selection } : {}),
        ...(body.before !== undefined ? { before: body.before } : {}),
        ...(body.after !== undefined ? { after: body.after } : {}),
        ...(body.preset !== undefined ? { preset: body.preset } : {}),
        ...(body.instruction !== undefined ? { instruction: body.instruction } : {})
      };
      // The runner's own check, asked before a message slot is taken: a
      // request that cannot be served never touches the allowance.
      try {
        validateQuickAuthorAssistRequest(assistRequest);
      } catch (error) {
        if (error instanceof AuthorAssistInputError) {
          return sendMobileError(reply, 400, error.code, error.message);
        }
        throw error;
      }
      const textModel = context.studioAssistTextModel(modelTierFromMediaSettings(project.mediaSettings));
      if (!textModel) {
        return sendMobileError(reply, 503, "ASSIST_UNAVAILABLE", ASSIST_UNAVAILABLE_MESSAGE);
      }
      return withMessageUsage(
        { userId: auth.user.id, projectId: project.id, requestKey: messageRequestKey(`studio:${project.id}`, body.requestId) },
        reply,
        async () => {
          try {
            const result = await runStudioQuickAssist({
              textModel: withInlineProviderUsage(textModel, { projectId: project.id }),
              request: assistRequest
            });
            return {
              assist: {
                kind: result.kind,
                suggestions: result.suggestions.map((suggestion) => ({ text: suggestion.text })),
                corrections: result.corrections.map((correction) => ({
                  find: correction.find,
                  replace: correction.replace,
                  reason: correction.reason
                })),
                ideas: result.ideas.map((idea) => ({ title: idea.title, text: idea.text })),
                answer: result.answer
              }
            } satisfies ManuscriptQuickAssistResponseDto;
          } catch (error) {
            // A status ≥ 400 is what makes `withMessageUsage` return the slot.
            if (error instanceof AuthorAssistInputError) {
              return sendMobileError(reply, 400, error.code, error.message);
            }
            reply.log.warn({ err: error, projectId: project.id, kind: body.kind }, "Writing Studio quick assist unavailable");
            return sendMobileError(reply, 503, "ASSIST_UNAVAILABLE", ASSIST_UNAVAILABLE_MESSAGE);
          }
        }
      );
    }
  );

  fastify.post(
    "/api/mobile/projects/:id/manuscript/assists",
    { attachValidation: true, schema: { tags: ["mobile"], body: manuscriptAssistCreateOpenApiBody, response: requestResponses } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      const { id } = idParamsSchema.parse(request.params);
      const parsed = manuscriptAssistCreateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "INVALID_ASSIST", "That request could not be read.");
      }
      if (!hitAuthenticatedLimit(draftLimiter, reply, auth.user.id, "studio-long-assist")) return;
      // The picture prompt and the draft or outline notes, before any charge.
      const typedRequest = [parsed.data.prompt, parsed.data.notes].filter((text) => text?.trim()).join("\n");
      if (typedRequest && !(await enforceContentRestrictions(reply, typedRequest))) return;
      const project = await authorProjectOrReply(reply, auth.user.id, id);
      if (!project) return;
      const manuscript = await ensureManuscript(project);
      let assistId: string;
      try {
        ({ assistId } = await createLongAssist({ userId: auth.user.id, project, manuscript, body: parsed.data }));
      } catch (error) {
        if (sendAssistRefusal(reply, error) || sendGenerationAttemptError(reply, error)) return;
        throw error;
      }
      const assist = await findAssist(project.id, assistId);
      if (!assist) {
        return sendMobileError(reply, 404, "ASSIST_NOT_FOUND", "That request no longer exists.");
      }
      return { assist: serializeAssist(assist) } satisfies ManuscriptAssistResponseDto;
    }
  );

  fastify.get(
    "/api/mobile/projects/:id/manuscript/assists",
    { schema: { tags: ["mobile"], response: errorResponses } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      const { id } = idParamsSchema.parse(request.params);
      const query = manuscriptAssistListQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "That list could not be read.");
      }
      const project = await authorProjectOrReply(reply, auth.user.id, id);
      if (!project) return;
      const open = query.data.open === "1" || query.data.open === "true";
      return {
        assists: await listAssists(project.id, { open, chapterId: query.data.chapterId })
      } satisfies ManuscriptAssistsResponseDto;
    }
  );

  fastify.get(
    "/api/mobile/projects/:id/manuscript/assists/:aid",
    { schema: { tags: ["mobile"], response: errorResponses } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      const { id, aid } = manuscriptAssistParamsSchema.parse(request.params);
      const project = await authorProjectOrReply(reply, auth.user.id, id);
      if (!project) return;
      const assist = await findAssist(project.id, aid);
      if (!assist) {
        return sendMobileError(reply, 404, "ASSIST_NOT_FOUND", "That request no longer exists.");
      }
      return { assist: serializeAssist(assist) } satisfies ManuscriptAssistResponseDto;
    }
  );

  for (const action of ["dismiss", "applied"] as const) {
    fastify.post(
      `/api/mobile/projects/:id/manuscript/assists/:aid/${action}`,
      { schema: { tags: ["mobile"], response: errorResponses } },
      async (request, reply) => {
        const auth = await requireMobileAuth(request, reply);
        if (!auth) return;
        const { id, aid } = manuscriptAssistParamsSchema.parse(request.params);
        const project = await authorProjectOrReply(reply, auth.user.id, id);
        if (!project) return;
        let assist;
        try {
          assist = action === "dismiss" ? await dismissAssist(project.id, aid) : await markAssistApplied(project.id, aid);
        } catch (error) {
          if (sendAssistRefusal(reply, error)) return;
          throw error;
        }
        if (!assist) {
          return sendMobileError(reply, 404, "ASSIST_NOT_FOUND", "That request no longer exists.");
        }
        return { assist: serializeAssist(assist) } satisfies ManuscriptAssistResponseDto;
      }
    );
  }
}
