import { projectExportAvailability, sendProjectEpubExport, sendProjectPdfExport } from "../../routes/projects.js";
import { ensureExportEntitlementForDownload, requireMobileAuth, sendMobileError } from "../httpErrors.js";
import { idParamsSchema, mobileAuthError } from "../schemas.js";
import { prisma } from "@book-maker/db";
import type { FastifyInstance } from "fastify";
import type { MobileRouteContext } from "../routeContext.js";

/**
 * Entitlement-gated PDF and EPUB downloads.
 */

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
      if (project.status === "REVIEW_REQUIRED") {
        return sendMobileError(reply, 409, "QUALITY_REVIEW_REQUIRED", "Fix the flagged manuscript issues before exporting.");
      }
      const availability = await projectExportAvailability(appConfig, id, "pdf");
      if (!availability.available && project.status !== "COMPLETE") {
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
        select: { title: true, language: true, status: true, currentPlanId: true }
      });
      if (!project) {
        return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
      }
      if (project.status === "REVIEW_REQUIRED") {
        return sendMobileError(reply, 409, "QUALITY_REVIEW_REQUIRED", "Fix the flagged manuscript issues before exporting.");
      }
      const availability = await projectExportAvailability(appConfig, id, "epub");
      if (!availability.available && project.status !== "COMPLETE") {
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
