import { projectExportAvailability, sendProjectEpubExport, sendProjectPdfExport } from "../../routes/projects.js";
import { ensureExportEntitlementForDownload, requireMobileAuth, sendMobileError } from "../httpErrors.js";
import { idParamsSchema, mobileAuthError } from "../schemas.js";
import { prisma } from "@book-maker/db";
import type { FastifyInstance } from "fastify";
import type { MobileRouteContext } from "../routeContext.js";

/**
 * Entitlement-gated PDF and EPUB downloads.
 */

function exportableStatus(status: string): boolean {
  return status === "COMPLETE" || status === "REVIEW_REQUIRED";
}

export async function registerMobileExportRoutes(fastify: FastifyInstance, context: MobileRouteContext): Promise<void> {
  const { appConfig } = context;

  fastify.get(
    "/api/mobile/projects/:id/export/pdf",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const project = await prisma.project.findFirst({
        where: { id, userId: auth.user.id },
        select: { title: true, language: true, status: true, currentPlanId: true, mediaSettings: true }
      });
      if (!project) {
        return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
      }
      // REVIEW_REQUIRED no longer refuses the download: the compile always
      // produces the best available book, and the flagged issues travel on the
      // serialized quality report for the app to warn with. The reader paid
      // for this book; QA gets to warn, not to withhold.
      const availability = await projectExportAvailability(appConfig, id, "pdf");
      if (!availability.available && !exportableStatus(project.status)) {
        return sendMobileError(reply, 404, "EXPORT_NOT_READY", "This export is not ready yet.");
      }
      const entitlement = await ensureExportEntitlementForDownload(reply, auth.user.id, id);
      if (!entitlement) {
        return;
      }
      return sendProjectPdfExport({ request, reply, appConfig, projectId: id, project });
    }
  );

  fastify.get(
    "/api/mobile/projects/:id/export/epub",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const project = await prisma.project.findFirst({
        where: { id, userId: auth.user.id },
        select: { title: true, authorName: true, language: true, status: true, currentPlanId: true }
      });
      if (!project) {
        return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
      }
      const availability = await projectExportAvailability(appConfig, id, "epub");
      if (!availability.available && !exportableStatus(project.status)) {
        return sendMobileError(reply, 404, "EXPORT_NOT_READY", "This export is not ready yet.");
      }
      const entitlement = await ensureExportEntitlementForDownload(reply, auth.user.id, id);
      if (!entitlement) {
        return;
      }
      return sendProjectEpubExport({ request, reply, appConfig, projectId: id, project });
    }
  );
}
