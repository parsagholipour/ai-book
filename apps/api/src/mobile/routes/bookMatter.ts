import type { FastifyInstance } from "fastify";
import {
  authorProfileBodySchema,
  authorProfileOpenApiBody,
  authorProfileResponseSchema,
  readAuthorProfile,
  writeAuthorProfile,
  type AuthorProfileDto
} from "../authorProfile.js";
import {
  applyBookMatterPatch,
  bookMatterOpenApiBody,
  bookMatterPatchResponseSchema,
  bookMatterPatchSchema,
  bookMatterPatchText,
  BookMatterRefusal,
  bookMatterRemoveCreditResponseSchema,
  bookMatterResponseSchema,
  ownedBookMatterProject,
  serializeBookMatter,
  type BookMatterCover,
  type BookMatterDto,
  type BookMatterReprint
} from "../bookMatterEdits.js";
import {
  hitAuthenticatedLimit,
  requireMobileAuth,
  sendMobileError,
  sendProjectNotFound,
  sendSubscriptionRequired,
  sendUnreadableBodyError
} from "../httpErrors.js";
import { manuscriptContentRestrictedError } from "../manuscript/manuscriptContentScreen.js";
import { enforceMatterFieldRestrictions } from "../matterContentScreen.js";
import type { MobileRouteContext } from "../routeContext.js";
import { idParamsSchema, mobileAuthError } from "../schemas.js";
import {
  removeTomezaCredit,
  TOMEZA_CREDIT_BUSY_MESSAGE,
  TOMEZA_CREDIT_NOT_FINISHED_MESSAGE,
  TOMEZA_CREDIT_PLAN_MESSAGE,
  TOMEZA_CREDIT_REFRESHING_MESSAGE
} from "../tomezaCredit.js";

/**
 * The author profile and a book's matter pages (`.scratch/book-matter/spec.md`):
 * who the reader is as an author, and the title page, dedication, publication
 * details and About the Author page each book prints. Free; the text is
 * screened because it is printed and shared.
 */

const INVALID_MESSAGE = "Some of these details could not be saved as sent.";

export async function registerMobileBookMatterRoutes(fastify: FastifyInstance, context: MobileRouteContext): Promise<void> {
  const { draftLimiter } = context;

  fastify.get(
    "/api/mobile/author-profile",
    { schema: { tags: ["mobile"], response: { 200: authorProfileResponseSchema, 401: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      reply.header("Cache-Control", "no-store");
      return { profile: await readAuthorProfile(auth.user.id, auth.user.displayName) } satisfies {
        profile: AuthorProfileDto;
      };
    }
  );

  fastify.put(
    "/api/mobile/author-profile",
    {
      attachValidation: true,
      errorHandler: sendUnreadableBodyError,
      schema: {
        tags: ["mobile"],
        body: authorProfileOpenApiBody,
        response: {
          200: authorProfileResponseSchema,
          400: mobileAuthError,
          401: mobileAuthError,
          422: manuscriptContentRestrictedError,
          429: mobileAuthError
        }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      if (!hitAuthenticatedLimit(draftLimiter, reply, auth.user.id, "author-profile")) return;
      const parsed = authorProfileBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", INVALID_MESSAGE);
      }
      const body = parsed.data;
      const screened = await enforceMatterFieldRestrictions(reply, {
        penName: body.penName,
        bio: body.bio,
        website: body.website,
        copyrightHolder: body.copyrightHolder,
        imprint: body.imprint
      });
      if (!screened) return;
      return { profile: await writeAuthorProfile(auth.user.id, auth.user.displayName, body) } satisfies {
        profile: AuthorProfileDto;
      };
    }
  );

  fastify.get(
    "/api/mobile/projects/:id/book-matter",
    {
      schema: { tags: ["mobile"], response: { 200: bookMatterResponseSchema, 401: mobileAuthError, 404: mobileAuthError } }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      const { id } = idParamsSchema.parse(request.params);
      const project = await ownedBookMatterProject(auth.user.id, id);
      if (!project) return sendProjectNotFound(reply);
      reply.header("Cache-Control", "no-store");
      return { bookMatter: await serializeBookMatter(project) } satisfies { bookMatter: BookMatterDto };
    }
  );

  fastify.patch(
    "/api/mobile/projects/:id/book-matter",
    {
      attachValidation: true,
      errorHandler: sendUnreadableBodyError,
      schema: {
        tags: ["mobile"],
        body: bookMatterOpenApiBody,
        response: {
          200: bookMatterPatchResponseSchema,
          400: mobileAuthError,
          401: mobileAuthError,
          404: mobileAuthError,
          409: mobileAuthError,
          422: manuscriptContentRestrictedError,
          429: mobileAuthError
        }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      if (!hitAuthenticatedLimit(draftLimiter, reply, auth.user.id, "book-matter")) return;
      const { id } = idParamsSchema.parse(request.params);
      const parsed = bookMatterPatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", INVALID_MESSAGE);
      }
      const project = await ownedBookMatterProject(auth.user.id, id);
      if (!project) return sendProjectNotFound(reply);
      if (!(await enforceMatterFieldRestrictions(reply, bookMatterPatchText(parsed.data)))) return;
      let outcome: { reprint: BookMatterReprint; cover: BookMatterCover };
      try {
        outcome = await applyBookMatterPatch(project, parsed.data);
      } catch (error) {
        if (error instanceof BookMatterRefusal) {
          return sendMobileError(reply, 409, error.code, error.message);
        }
        throw error;
      }
      const saved = (await ownedBookMatterProject(auth.user.id, id)) ?? project;
      return { bookMatter: await serializeBookMatter(saved), ...outcome } satisfies {
        bookMatter: BookMatterDto;
        reprint: BookMatterReprint;
        cover: BookMatterCover;
      };
    }
  );

  // A subscriber takes the free tier's "Made with Tomeza" line off one finished
  // book (`tomezaCredit.ts`): a free reprint, or nothing when the published
  // book does not print it. No body; one sent is ignored.
  fastify.post(
    "/api/mobile/projects/:id/book-matter/remove-credit",
    {
      errorHandler: sendUnreadableBodyError,
      schema: {
        tags: ["mobile"],
        response: {
          200: bookMatterRemoveCreditResponseSchema,
          400: mobileAuthError,
          401: mobileAuthError,
          403: mobileAuthError,
          404: mobileAuthError,
          409: mobileAuthError,
          429: mobileAuthError
        }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      if (!hitAuthenticatedLimit(draftLimiter, reply, auth.user.id, "book-matter-credit")) return;
      const { id } = idParamsSchema.parse(request.params);
      const project = await ownedBookMatterProject(auth.user.id, id);
      if (!project) return sendProjectNotFound(reply);
      const outcome = await removeTomezaCredit(project);
      switch (outcome.kind) {
        case "subscription_required":
          return sendSubscriptionRequired(reply, TOMEZA_CREDIT_PLAN_MESSAGE);
        case "refreshing":
          return sendMobileError(reply, 409, "PROJECT_BUSY", TOMEZA_CREDIT_REFRESHING_MESSAGE);
        case "busy":
          return sendMobileError(reply, 409, "PROJECT_BUSY", TOMEZA_CREDIT_BUSY_MESSAGE);
        case "not_finished":
          return sendMobileError(reply, 409, "PROJECT_BUSY", TOMEZA_CREDIT_NOT_FINISHED_MESSAGE);
        case "reprinted":
        case "not_printed": {
          const saved = (await ownedBookMatterProject(auth.user.id, id)) ?? project;
          return {
            bookMatter: await serializeBookMatter(saved),
            reprint: outcome.kind === "reprinted" ? "queued" : "none"
          } satisfies { bookMatter: BookMatterDto; reprint: "queued" | "none" };
        }
      }
    }
  );
}
