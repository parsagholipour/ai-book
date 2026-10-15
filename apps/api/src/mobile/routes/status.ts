import { ensureExportRepairQueued, ensureExportRepairQueuedFor, missingExportFormat } from "../exportRepair.js";
import { requireMobileAuth, sendMobileError, sendProjectNotFound } from "../httpErrors.js";
import { imageContentType, mobileAssetFilenameFromPath } from "../projectArtifactSerializers.js";
import { isLiveProjectStatus, loadSerializedProjectStatus } from "../projectStatusSerializers.js";
import { admitStatusStream, statusStreamTiming } from "../statusStreams.js";
import { assetParamsSchema, idParamsSchema, mobileAuthError } from "../schemas.js";
import { readBearerToken, verifyMobileAccessToken } from "../../mobileAuth.js";
import { prisma } from "@book-maker/db";
import { objectKey, objectStore } from "@book-maker/storage";
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
        select: { id: true, status: true, currentPlanId: true, contentRevision: true }
      });
      if (!project) {
        return sendProjectNotFound(reply);
      }
      const status = await loadSerializedProjectStatus(id, appConfig);
      if (!status) {
        return sendProjectNotFound(reply);
      }
      // The download routes queue a repair when they find nothing to send, but
      // no surface ever reaches them while the file is missing: the card's
      // button is disabled, the reader returns "still being written", and the
      // actions menu gates the same way. Watching the status is the only signal
      // there is, so that is what has to queue the rebuild — here for the app's
      // fallback poll, and in the stream below for the path it normally takes.
      //
      // Every format, because none has a surface that can ask for itself: an
      // EPUB-only or Word-only outage is just as unreachable as a missing PDF,
      // the download route being gated behind the same disabled button. All use the bounded
      // window in `exportRepairDedupeKey`, so a terminal job can be retried
      // without a four-second status poll becoming a job per poll. Everything
      // else this needs — including the in-flight compile guard — is inside
      // `ensureExportRepairQueued`.
      const missing = missingExportFormat(status.exports);
      if (missing) {
        await ensureExportRepairQueued(project, missing, appConfig);
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
        return sendProjectNotFound(reply);
      }

      reply.hijack();
      // Hijacked, so nothing the reply was given is sent unless it is written
      // here — the CORS headers `@fastify/cors` set on request among them, and
      // a browser refused every event stream for want of them.
      const inherited = Object.fromEntries(
        Object.entries(reply.getHeaders()).filter(
          (entry): entry is [string, string | number | string[]] => entry[1] !== undefined
        )
      );
      reply.raw.writeHead(200, {
        ...inherited,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });

      // Read once, at connect: the stream answers to the token it was opened
      // with, so a refresh (which revokes that session row) ends it too.
      const accessToken = readBearerToken(request);
      let closed = false;
      let sending = false;
      let lastSent: string | null = null;
      const timers: Array<ReturnType<typeof setInterval>> = [];
      const write = (chunk: string) => {
        if (!closed) reply.raw.write(chunk);
      };
      let release: () => void = () => undefined;
      const close = (code?: string) => {
        if (closed) return;
        if (code) write(`event: error\ndata: ${JSON.stringify({ code })}\n\n`);
        closed = true;
        for (const timer of timers) clearInterval(timer);
        timers.length = 0;
        release();
        reply.raw.end();
      };
      release = admitStatusStream(auth.user.id, { end: (code) => close(code) });

      const sendStatus = async () => {
        if (closed || sending) {
          return;
        }
        sending = true;
        try {
          const status = await loadSerializedProjectStatus(id, appConfig);
          if (closed) return;
          if (!status) {
            close("PROJECT_NOT_FOUND");
            return;
          }
          if (!isLiveProjectStatus(status.status)) {
            // The same repair the poll route queues, on the surface the app
            // actually uses. `projectStatusProvider` subscribes *here* and falls
            // back to `GET …/status` while a settled book is still missing its
            // PDF. Queue before publishing that missing-export snapshot so the
            // client never observes "repair needed" before the repair decision
            // has been made. Every later re-check (the saved-export card's
            // bounded refresh, the reader, the book screen) can then observe the
            // compile this read initiated.
            const missing = missingExportFormat(status.exports);
            if (missing) {
              await ensureExportRepairQueuedFor(id, auth.user.id, missing, appConfig);
            }
          }
          // Only a status that changed is sent: an unchanged one used to go out
          // every second, and each one rebuilt the app's whole chat screen.
          const serialized = JSON.stringify({ status });
          if (serialized !== lastSent) {
            lastSent = serialized;
            write(`event: status\ndata: ${serialized}\n\n`);
          }
          if (!isLiveProjectStatus(status.status)) {
            close();
          }
        } catch (error) {
          request.log.warn({ err: error, projectId: id }, "Could not stream mobile project status");
          write(`event: error\ndata: ${JSON.stringify({ code: "STATUS_STREAM_ERROR" })}\n\n`);
        } finally {
          sending = false;
        }
      };

      // Auth was checked once, at connect. A stream outliving a revoked
      // session, a disabled account or its own access token kept serving the
      // book to whoever held the socket, so it re-asks on a timer. It ends with
      // a code of its own, never `SESSION_REVOKED`: an ordinary token refresh
      // revokes the session row this token belongs to, so a reader whose app
      // treated that as a dead session would be signed out every 15 minutes.
      // Whether the session is really over is the next HTTP request's answer.
      const checkSession = async () => {
        if (closed) return;
        try {
          const verified = accessToken ? await verifyMobileAccessToken(accessToken) : null;
          if (!verified?.ok) {
            close("STATUS_STREAM_SESSION_ENDED");
          }
        } catch (error) {
          // A failed read is not a revoked session; the next check asks again.
          request.log.warn({ err: error, projectId: id }, "Could not re-check a status stream's session");
        }
      };

      request.raw.on("close", () => close());
      await sendStatus();
      if (!closed) {
        timers.push(
          setInterval(() => void sendStatus(), statusStreamTiming.pollMs),
          // A comment line, which every SSE parser — the app's included —
          // skips: it proves the socket is alive without rebuilding a screen.
          setInterval(() => write(": ping\n\n"), statusStreamTiming.heartbeatMs),
          setInterval(() => void checkSession(), statusStreamTiming.sessionCheckMs)
        );
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

      const file = await objectStore().get(objectKey("images", id, filename));
      if (!file) return sendMobileError(reply, 404, "ASSET_NOT_FOUND", "Visual not found.");
      reply.header("Cache-Control", "private, max-age=300");
      reply.type(imageContentType(image));
      return file;
    }
  );
}
