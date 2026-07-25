import { type MobileEditableBookDto, type MobileManualBookEditResponseDto } from "../dto.js";
import { hasOpenProjectWork } from "../editOperations.js";
import { hitAuthenticatedLimit, requireMobileAuth, sendMobileError } from "../httpErrors.js";
import { applyManualBookEdit, manualEditInfoFromMessage, replayManualBookEdit } from "../manualEdits.js";
import { loadProjectChatResponse, serializeBookEditOperation, serializeProjectChatMessage } from "../projectChat.js";
import { idParamsSchema, mobileAuthError, mobileManualBookEditBodySchema, mobileManualBookEditOpenApiBody } from "../schemas.js";
import { isPrismaUniqueConflict } from "../support.js";
import { prisma } from "@book-maker/db";
import type { FastifyInstance } from "fastify";
import type { MobileRouteContext } from "../routeContext.js";

/**
 * Readable book payload and direct manual page edits.
 */

export async function registerMobileBookRoutes(fastify: FastifyInstance, context: MobileRouteContext): Promise<void> {
  const { appConfig, draftLimiter } = context;

  fastify.get(
    "/api/mobile/projects/:id/book",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const project = await prisma.project.findFirst({
        where: { id, userId: auth.user.id },
        select: {
          id: true,
          title: true,
          status: true,
          pages: {
            orderBy: { index: "asc" },
            select: { id: true, index: true, title: true, markdown: true, revision: true }
          }
        }
      });
      if (!project) {
        return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
      }
      // EDITING covers the export recompile after a save; the book text
      // itself is still fully readable and editable then.
      if (!["COMPLETE", "EDITING", "REVIEW_REQUIRED"].includes(project.status) || project.pages.length === 0) {
        return sendMobileError(reply, 409, "BOOK_NOT_READY", "This book is not ready to edit yet.");
      }
      return {
        book: {
          projectId: project.id,
          title: project.title,
          pages: project.pages
        } satisfies MobileEditableBookDto
      };
    }
  );

  fastify.post(
    "/api/mobile/projects/:id/manual-edits",
    {
      attachValidation: true,
      schema: {
        tags: ["mobile"],
        body: mobileManualBookEditOpenApiBody,
        response: { 401: mobileAuthError, 404: mobileAuthError }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(draftLimiter, request, reply, auth.user.id, "manual-edit")) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const parsed = mobileManualBookEditBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send the edited pages.");
      }

      const project = await prisma.project.findFirst({
        where: { id, userId: auth.user.id },
        select: { id: true, status: true, currentPlanId: true }
      });
      if (!project) {
        return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
      }
      if (parsed.data.requestId) {
        const replay = await replayManualBookEdit(id, parsed.data.requestId);
        if (replay) {
          return replay;
        }
      }
      if (!["COMPLETE", "EDITING", "REVIEW_REQUIRED"].includes(project.status)) {
        return sendMobileError(reply, 409, "BOOK_NOT_READY", "Manual edits are available after the book is generated.");
      }
      if (await hasOpenProjectWork(id)) {
        return sendMobileError(
          reply,
          409,
          "PROJECT_BUSY",
          "This book is still being worked on. Save your edit once the current job finishes."
        );
      }

      const savedExportMessageId = parsed.data.savedExportMessageId ?? null;
      const savedExportMessage = savedExportMessageId
        ? await prisma.projectChatMessage.findFirst({
            where: { id: savedExportMessageId, projectId: id, role: "ASSISTANT" }
          })
        : null;
      if (savedExportMessageId && (!savedExportMessage || !manualEditInfoFromMessage(savedExportMessage))) {
        return sendMobileError(reply, 404, "MESSAGE_NOT_FOUND", "That saved edit was not found.");
      }

      const pageIds = parsed.data.pages.map((page) => page.id);
      if (new Set(pageIds).size !== pageIds.length) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Each page can only be edited once per save.");
      }
      const pages = await prisma.page.findMany({ where: { projectId: id, id: { in: pageIds } } });
      if (pages.length !== pageIds.length) {
        return sendMobileError(reply, 404, "PAGE_NOT_FOUND", "Some edited pages no longer exist. Reload the book.");
      }
      const pagesById = new Map(pages.map((page) => [page.id, page]));
      const hasConflict = parsed.data.pages.some((edit) => pagesById.get(edit.id)!.revision !== edit.baseRevision);
      if (hasConflict) {
        return sendMobileError(
          reply,
          409,
          "EDIT_CONFLICT",
          "This book changed since you opened Edit Mode. Reload it and try again."
        );
      }
      const changedEdits = parsed.data.pages.filter((edit) => {
        const page = pagesById.get(edit.id)!;
        return page.title !== edit.title || page.markdown !== edit.markdown;
      });
      if (changedEdits.length === 0) {
        return sendMobileError(reply, 400, "NO_CHANGES", "There are no changes to save.");
      }

      let result: Awaited<ReturnType<typeof applyManualBookEdit>>;
      try {
        result = await applyManualBookEdit({
          projectId: id,
          currentPlanId: project.currentPlanId,
          fallbackProjectStatus: project.status === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "COMPLETE",
          edits: changedEdits,
          pagesById,
          savedExportMessage,
          requestId: parsed.data.requestId,
          bookStorageDir: appConfig.BOOK_STORAGE_DIR
        });
      } catch (error) {
        if (parsed.data.requestId && isPrismaUniqueConflict(error)) {
          const replay = await replayManualBookEdit(id, parsed.data.requestId);
          if (replay) return replay;
        }
        throw error;
      }

      return {
        ...(await loadProjectChatResponse(id)),
        savedExportMessage: serializeProjectChatMessage(result.message),
        operation: serializeBookEditOperation(result.operation)
      } satisfies MobileManualBookEditResponseDto;
    }
  );
}
