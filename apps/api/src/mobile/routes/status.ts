import { requireMobileAuth, sendMobileError } from "../httpErrors.js";
import { imageContentType, isLiveProjectStatus, loadSerializedProjectStatus, mobileAssetFilenameFromPath } from "../projectSerializers.js";
import { assetParamsSchema, idParamsSchema, mobileAuthError } from "../schemas.js";
import { prisma } from "@book-maker/db";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { MobileRouteContext } from "../routeContext.js";

/**
 * Generation status, the SSE event stream, and generated asset downloads.
 */

export async function registerMobileStatusRoutes(fastify: FastifyInstance, context: MobileRouteContext): Promise<void> {
  const { appConfig } = context;

  fastify.get(
    "/api/mobile/projects/:id/status",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const project = await prisma.project.findFirst({
        where: { id, userId: auth.user.id },
        select: { id: true }
      });
      if (!project) {
        return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
      }
      const status = await loadSerializedProjectStatus(id, appConfig, auth.user.id);
      if (!status) {
        return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
      }
      return { status };
    }
  );

  fastify.get(
    "/api/mobile/projects/:id/status/events",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const project = await prisma.project.findFirst({
        where: { id, userId: auth.user.id },
        select: { id: true }
      });
      if (!project) {
        return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });

      let closed = false;
      let sending = false;
      let timer: ReturnType<typeof setInterval> | null = null;
      const close = () => {
        if (closed) return;
        closed = true;
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        reply.raw.end();
      };

      const sendStatus = async () => {
        if (closed || sending) {
          return;
        }
        sending = true;
        try {
          const status = await loadSerializedProjectStatus(id, appConfig, auth.user.id);
          if (!status) {
            reply.raw.write(`event: error\ndata: ${JSON.stringify({ code: "PROJECT_NOT_FOUND" })}\n\n`);
            close();
            return;
          }
          reply.raw.write(`event: status\ndata: ${JSON.stringify({ status })}\n\n`);
          if (!isLiveProjectStatus(status.status)) {
            close();
          }
        } catch (error) {
          request.log.warn({ err: error, projectId: id }, "Could not stream mobile project status");
          reply.raw.write(`event: error\ndata: ${JSON.stringify({ code: "STATUS_STREAM_ERROR" })}\n\n`);
        } finally {
          sending = false;
        }
      };

      request.raw.on("close", close);
      await sendStatus();
      if (!closed) {
        timer = setInterval(sendStatus, 1000);
      }
    }
  );

  fastify.get(
    "/api/mobile/projects/:id/assets/:assetId",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id, assetId } = assetParamsSchema.parse(request.params);
      const image = await prisma.imageAsset.findFirst({
        where: { id: assetId, projectId: id, project: { userId: auth.user.id } },
        select: { id: true, projectId: true, pageId: true, type: true, path: true, metadata: true }
      });
      if (!image) {
        return sendMobileError(reply, 404, "ASSET_NOT_FOUND", "Visual not found.");
      }
      const filename = mobileAssetFilenameFromPath(image.path, id);
      if (!filename) {
        return sendMobileError(reply, 404, "ASSET_NOT_FOUND", "Visual not found.");
      }

      try {
        const file = await readFile(join(appConfig.IMAGE_STORAGE_DIR, id, filename));
        reply.header("Cache-Control", "private, max-age=300");
        reply.type(imageContentType(image));
        return file;
      } catch {
        return sendMobileError(reply, 404, "ASSET_NOT_FOUND", "Visual not found.");
      }
    }
  );
}
