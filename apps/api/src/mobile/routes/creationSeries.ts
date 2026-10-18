import type { FastifyInstance } from "fastify";
import { prisma } from "@book-maker/db";

import { mobileCreationDraftPayloadSchema } from "../../mobileCreation.js";
import {
  conversationMessagesFromPayload,
  creationTreeFromPayload,
  creationTurnForStoredDraft,
  mobileCreationDraftOutputsInclude,
  serializeCreationSessionForUser
} from "../creationSessions.js";
import {
  SERIES_BOOK_UNAVAILABLE_MESSAGE,
  SERIES_LOCKED_MESSAGE,
  seriesPresetsFor,
  seriesSourceBook
} from "../creationSeries.js";
import type { MobileCreationConversationResponseDto } from "../dto.js";
import { requireMobileAuth, sendMobileError } from "../httpErrors.js";
import {
  idParamsSchema,
  mobileAuthError,
  mobileCreationSeriesChoiceBodySchema,
  mobileCreationSeriesChoiceOpenApiBody
} from "../schemas.js";
import type { MobileCreationPresetsInput } from "../../mobileCreationSchemas.js";

/** The answer's response: the conversation, plus the linked book's format for the app to apply where the reader has not chosen. */
export type MobileCreationSeriesAnswerDto = MobileCreationConversationResponseDto & {
  seriesPresets?: MobileCreationPresetsInput;
};

/** What "Write the next book" starts a chat from: the book's own format, and its title for the opening line. */
export type MobileNextBookDto = {
  projectId: string;
  title: string;
  presets: MobileCreationPresetsInput;
};

/**
 * The series link of a creation chat (`../creationSeries.ts`): answering the
 * offer, and the format a "Write the next book" chat starts from. Both are
 * free — no model is asked anything — and neither starts any AI work, so
 * neither asks the spend breaker.
 */
export function registerMobileCreationSeriesRoutes(fastify: FastifyInstance): void {
  fastify.put(
    "/api/mobile/creation-sessions/:id/series",
    {
      attachValidation: true,
      schema: {
        tags: ["mobile"],
        body: mobileCreationSeriesChoiceOpenApiBody,
        response: { 400: mobileAuthError, 401: mobileAuthError, 404: mobileAuthError, 409: mobileAuthError }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      const { id } = idParamsSchema.parse(request.params);
      const body = mobileCreationSeriesChoiceBodySchema.safeParse(request.body ?? {});
      if (!body.success || (body.data.mode === "standalone") === Boolean(body.data.projectId)) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Choose a book to link this one to, or a new story.");
      }
      const draft = await prisma.mobileCreationDraft.findFirst({
        where: { id, userId: auth.user.id },
        include: mobileCreationDraftOutputsInclude()
      });
      if (!draft) {
        return sendMobileError(reply, 404, "SESSION_NOT_FOUND", "This book chat was not found.");
      }
      if (draft.createdProjectId) {
        return sendMobileError(reply, 409, "SERIES_LOCKED", SERIES_LOCKED_MESSAGE);
      }
      const payload = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
      if (!payload.success) {
        return sendMobileError(reply, 409, "SESSION_CONFLICT", "This chat changed elsewhere. Reload it and try again.");
      }
      const source = body.data.projectId ? await seriesSourceBook(auth.user.id, body.data.projectId) : null;
      if (body.data.projectId && !source) {
        return sendMobileError(reply, 404, "SERIES_BOOK_NOT_FOUND", SERIES_BOOK_UNAVAILABLE_MESSAGE);
      }

      // The answer moves the revision, so a Build that read the draft before
      // it refuses to build from the old answer rather than silently using it.
      const updated = await prisma.mobileCreationDraft.update({
        where: { id: draft.id },
        data: { seriesMode: body.data.mode, seriesSourceProjectId: source?.id ?? null, revision: { increment: 1 } }
      });
      // The session is read from the row just written, transcript and revision
      // alike: a message landing between the two reads belongs to both.
      const current = mobileCreationDraftPayloadSchema.safeParse(updated.payload);
      const currentPayload = current.success ? current.data : payload.data;
      return {
        session: await serializeCreationSessionForUser(
          auth.user.id,
          { ...updated, outputs: draft.outputs },
          creationTreeFromPayload(currentPayload)
        ),
        turn: creationTurnForStoredDraft(updated, currentPayload, conversationMessagesFromPayload(currentPayload)),
        // The earlier book's format, its own field rather than the turn's
        // presets: the app applies it only to the settings the reader has not
        // chosen, which a turn's presets would overwrite.
        ...(source ? { seriesPresets: seriesPresetsFor(source) } : {})
      } satisfies MobileCreationSeriesAnswerDto;
    }
  );

  fastify.get(
    "/api/mobile/projects/:id/next-book",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      const { id } = idParamsSchema.parse(request.params);
      const source = await seriesSourceBook(auth.user.id, id);
      if (!source) {
        return sendMobileError(reply, 404, "SERIES_BOOK_NOT_FOUND", SERIES_BOOK_UNAVAILABLE_MESSAGE);
      }
      return { projectId: source.id, title: source.title, presets: seriesPresetsFor(source) } satisfies MobileNextBookDto;
    }
  );
}
