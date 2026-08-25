import {
  deleteCreationAttachmentFile,
  readCreationAttachmentFile,
  saveCreationAttachmentFile
} from "../../attachmentStorage.js";
import { mobileCreationDraftPayloadSchema } from "../../mobileCreation.js";
import {
  sendCreationSessionConflict,
  serializeCreationAttachment,
  updateCreationDraftCas
} from "../creationSessions.js";
import { hitAuthenticatedLimit, requireMobileAuth, sendMobileError } from "../httpErrors.js";
import {
  attachmentParamsSchema,
  attachmentUploadQuerySchema,
  creationMutationQuerySchema,
  idParamsSchema,
  mobileAuthError
} from "../schemas.js";
import { jsonInputValue } from "../support.js";
import {
  CREATION_ATTACHMENT_MAX_BYTES,
  CREATION_ATTACHMENT_MAX_COUNT,
  CreationAttachmentError,
  type CreationAttachment
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import type { FastifyInstance } from "fastify";
import type { MobileRouteContext } from "../routeContext.js";

/**
 * Creation-chat attachment routes: upload, remove and read back the files a
 * reader attaches to a book chat. Split from creationSessions.ts along the
 * route-group seam; registered from there on the same Fastify instance so the
 * shared `application/octet-stream` parser still covers the upload route.
 */

export async function registerMobileCreationAttachmentRoutes(
  fastify: FastifyInstance,
  context: MobileRouteContext
): Promise<void> {
  const { appConfig, attachmentLimiter, attachmentIngestion } = context;

  fastify.post(
    "/api/mobile/creation-sessions/:id/attachments",
    {
      bodyLimit: CREATION_ATTACHMENT_MAX_BYTES + 64 * 1024,
      schema: { tags: ["mobile"], response: { 201: {}, 401: mobileAuthError, 404: mobileAuthError, 409: mobileAuthError, 422: mobileAuthError } }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(attachmentLimiter, reply, auth.user.id, "creation-attachment-upload")) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const query = attachmentUploadQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send the file with a filename.");
      }
      const data = request.body;
      if (!Buffer.isBuffer(data) || data.length === 0) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send the file as the request body.");
      }
      const draft = await prisma.mobileCreationDraft.findFirst({
        where: { id, userId: auth.user.id }
      });
      if (!draft) {
        return sendMobileError(reply, 404, "SESSION_NOT_FOUND", "This book chat was not found.");
      }
      const parsedPayload = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
      if (!parsedPayload.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "This book chat needs to be restarted.");
      }
      const existing = parsedPayload.data.attachments ?? [];
      if (existing.length >= CREATION_ATTACHMENT_MAX_COUNT) {
        return sendMobileError(
          reply,
          409,
          "ATTACHMENT_LIMIT",
          `This chat already has ${CREATION_ATTACHMENT_MAX_COUNT} files. Remove one before adding another.`
        );
      }

      let attachment: CreationAttachment;
      try {
        attachment = await attachmentIngestion({
          data,
          name: query.data.filename,
          mimeType: query.data.mimeType,
          language: parsedPayload.data.language
        });
      } catch (error) {
        if (error instanceof CreationAttachmentError) {
          return sendMobileError(reply, 422, error.code, error.message);
        }
        request.log.warn({ err: error, draftId: id }, "Creation attachment ingestion failed");
        return sendMobileError(
          reply,
          422,
          "ATTACHMENT_FAILED",
          "That file could not be read. Try a different file or paste the text instead."
        );
      }

      // Keep the original bytes server-side so the file follows the account
      // across devices; the retention sweep removes them after 6 months.
      try {
        await saveCreationAttachmentFile(appConfig.ATTACHMENT_STORAGE_DIR, id, attachment.id, data);
      } catch (error) {
        request.log.error({ err: error, draftId: id }, "Creation attachment file store failed");
        return sendMobileError(reply, 422, "ATTACHMENT_FAILED", "That file could not be saved. Try again.");
      }

      const updatedPayload = mobileCreationDraftPayloadSchema.parse({
        ...parsedPayload.data,
        attachments: [...existing, attachment]
      });
      let updatedRevision = (draft.revision ?? 1) + 1;
      try {
        const updated = await updateCreationDraftCas({
          draft,
          expectedRevision: query.data.expectedRevision,
          data: { payload: jsonInputValue(updatedPayload) }
        });
        if (!updated) {
          await deleteCreationAttachmentFile(appConfig.ATTACHMENT_STORAGE_DIR, id, attachment.id);
          return sendCreationSessionConflict(reply, auth.user.id, id);
        }
        updatedRevision = updated.revision;
      } catch (error) {
        await deleteCreationAttachmentFile(appConfig.ATTACHMENT_STORAGE_DIR, id, attachment.id);
        throw error;
      }
      return reply
        .code(201)
        .send({
          attachment: serializeCreationAttachment(attachment, id),
          revision: updatedRevision
        });
    }
  );

  fastify.delete(
    "/api/mobile/creation-sessions/:id/attachments/:attachmentId",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError, 409: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id, attachmentId } = attachmentParamsSchema.parse(request.params);
      const mutationQuery = creationMutationQuerySchema.safeParse(request.query ?? {});
      if (!mutationQuery.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "The chat revision is invalid.");
      }
      const draft = await prisma.mobileCreationDraft.findFirst({
        where: { id, userId: auth.user.id }
      });
      if (!draft) {
        return sendMobileError(reply, 404, "SESSION_NOT_FOUND", "This book chat was not found.");
      }
      const parsedPayload = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
      if (!parsedPayload.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "This book chat needs to be restarted.");
      }
      const attachments = parsedPayload.data.attachments ?? [];
      if (!attachments.some((attachment) => attachment.id === attachmentId)) {
        return sendMobileError(reply, 404, "ATTACHMENT_NOT_FOUND", "That attachment was not found.");
      }
      const referenced = (parsedPayload.data.messages ?? []).some((message) =>
        (message.attachments ?? []).some((ref) => ref.id === attachmentId)
      );
      if (referenced) {
        return sendMobileError(
          reply,
          409,
          "ATTACHMENT_IN_USE",
          "That file is already part of the conversation and can't be removed."
        );
      }
      const updatedPayload = mobileCreationDraftPayloadSchema.parse({
        ...parsedPayload.data,
        attachments: attachments.filter((attachment) => attachment.id !== attachmentId)
      });
      const updated = await updateCreationDraftCas({
        draft,
        expectedRevision: mutationQuery.data.expectedRevision,
        data: { payload: jsonInputValue(updatedPayload) }
      });
      if (!updated) {
        return sendCreationSessionConflict(reply, auth.user.id, id);
      }
      await deleteCreationAttachmentFile(appConfig.ATTACHMENT_STORAGE_DIR, id, attachmentId);
      return { ok: true, revision: updated.revision };
    }
  );

  fastify.get(
    "/api/mobile/creation-sessions/:id/attachments/:attachmentId/file",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id, attachmentId } = attachmentParamsSchema.parse(request.params);
      const draft = await prisma.mobileCreationDraft.findFirst({
        where: { id, userId: auth.user.id },
        select: { payload: true }
      });
      if (!draft) {
        return sendMobileError(reply, 404, "SESSION_NOT_FOUND", "This book chat was not found.");
      }
      const parsedPayload = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
      const attachment = parsedPayload.success
        ? (parsedPayload.data.attachments ?? []).find((entry) => entry.id === attachmentId)
        : undefined;
      if (!attachment) {
        return sendMobileError(reply, 404, "ATTACHMENT_NOT_FOUND", "That attachment was not found.");
      }
      const file = await readCreationAttachmentFile(appConfig.ATTACHMENT_STORAGE_DIR, id, attachmentId);
      if (!file) {
        // Uploaded before server-side storage existed, or past the 6-month retention window.
        return sendMobileError(reply, 404, "ATTACHMENT_FILE_EXPIRED", "This file is no longer stored.");
      }
      reply.header("Cache-Control", "private, max-age=300");
      reply.type(attachment.mimeType);
      return file;
    }
  );
}
