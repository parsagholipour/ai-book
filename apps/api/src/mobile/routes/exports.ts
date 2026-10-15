// Straight from the module that owns them rather than through the re-export in
// routes/projects.ts, which is already over its size budget.
import { readProjectExportArtifact, sanitizeDownloadFilename } from "../../routes/projectExports.js";
import { requireMobileAuth, sendMobileError, sendProjectNotFound, sendSubscriptionRequired } from "../httpErrors.js";
import { ensureExportRepairQueued } from "../exportRepair.js";
import { idParamsSchema, mobileAuthError } from "../schemas.js";
import { prisma } from "@book-maker/db";
import { hasActiveSubscriptionEntitlement } from "@book-maker/db/billing";
import {
  EXPORT_FORMATS,
  exportContentType,
  exportRequiresSubscription,
  type ExportArtifact,
  type ExportFormat
} from "@book-maker/core";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { MobileRouteContext } from "../routeContext.js";

/**
 * PDF, EPUB and Word downloads, one route per format in the registry.
 *
 * **A book the caller owns downloads free.** Its one charge was taken when its
 * plan was approved, and the finished file is the reader's with no lock — a
 * generated book, a Studio book, an import, a book made before the change or
 * made while free alike. Until 2026-10-15 a per-book 150-credit export unlock
 * was settled here before the bytes went out; it double-charged subscribers
 * (bundled into their book's price while their plan also "covered" it) and
 * rarely fired for anyone else, so it was removed. Nothing here spends,
 * writes an entitlement or answers 402.
 *
 * These never render. A missing file used to be compiled inside the request —
 * an unbounded Chromium render inside a Fastify handler, with no dedupe, on a
 * route the app can hit from several places at once. It is reachable in the
 * window a user edit opens: `invalidateCompiledProjectExports` deletes the files
 * and `queueUserEditExportRecompile` queues the rebuild a moment later. The
 * route now queues that same compile and answers `EXPORT_NOT_READY`, which the
 * app already knows how to poll through. The repair is keyed on the caller's
 * own format even when another is missing too: this caller asked for this file,
 * and the PDF's own repair stays available to the status hooks, which is where
 * it is actually noticed.
 *
 * The operator console still renders inline (`sendProjectPdfExport`): it
 * downloads through a plain link, where a 404 would just break the download,
 * and it is internal and low-traffic.
 *
 * The queueing is a *repair*, not an edit — see `exportRepairDedupeKey` for why
 * it cannot borrow the edit recompile's key.
 *
 * **The Word file is a plan perk, and the refusal comes before anything else.**
 * A free account is answered 403 `SUBSCRIPTION_REQUIRED` before a byte is read
 * and before any repair is queued — a compile for a file the reader cannot
 * download is spend for nothing. That is a gate on the *format*, never a
 * charge: a subscriber's Word download costs nothing, like every PDF and EPUB.
 * The plan check is a fresh read, never the 60-second cache
 * `isSubscriberForRateLimit` keeps for rate ceilings: that cache reads a lookup
 * failure as "free", which is the right default for a ceiling and the wrong one
 * for a refusal.
 */

/** What a free account is told when it asks for a plan-gated format. */
const SUBSCRIPTION_MESSAGE: Partial<Record<ExportFormat, string>> = {
  docx: "Word export is part of the Creator plan."
};

function sendExportNotReady(reply: FastifyReply) {
  return sendMobileError(reply, 404, "EXPORT_NOT_READY", "This export is not ready yet.");
}

/**
 * The header contract that tells the app which compile it just downloaded.
 *
 * The app caches the file under a `contentRevision`, decides staleness against
 * it and stamps every highlight and bookmark with it, and until this existed it
 * took that number from the availability descriptor it had read moments
 * earlier. Every compile publishes over this same URL, so that number is a
 * claim about the past — and the download most likely to be answered by a
 * *newer* compile is the retry after an `EXPORT_NOT_READY`, which means a
 * compile was landing when the reader tapped. Sizes cannot separate the two:
 * a presentation reprint, a re-applied edit or an undo can produce a book of
 * exactly the same length as the one it replaces.
 *
 * So the revision travels with the bytes, resolved from their own digest
 * (`readProjectExportArtifact`). `state` is reported even when there is no
 * revision to give, because "no record exists" and "a record describes other
 * bytes" are different things to the client: the first is an old file nothing
 * is racing, the second is a file being replaced right now, and only the second
 * has to refuse every guess. An older app ignores all of it and behaves as it
 * did.
 */
function setExportProvenanceHeaders(reply: FastifyReply, artifact: ExportArtifact) {
  reply.header("X-Export-Provenance", artifact.provenance.state);
  reply.header("X-Export-Content-Digest", artifact.provenance.digest);
  if (artifact.provenance.state === "exact") {
    reply.header("X-Export-Content-Revision", String(artifact.provenance.revision));
  }
}

/**
 * Sends the file as a download. The bytes are read before anything is answered
 * and handed back from memory, so an edit that deletes the compiled exports
 * mid-request cannot turn a found file into a 404 half-way through.
 */
function sendDownload(
  reply: FastifyReply,
  options: { artifact: ExportArtifact; contentType: string; filename: string }
) {
  reply.header("Content-Disposition", `attachment; filename="${options.filename}"`);
  reply.type(options.contentType);
  setExportProvenanceHeaders(reply, options.artifact);
  return options.artifact.bytes;
}

export async function registerMobileExportRoutes(fastify: FastifyInstance, context: MobileRouteContext): Promise<void> {
  const { appConfig } = context;

  // The reader's copy of the PDF, served inline for the in-app reader. The
  // download route below hands out the same bytes as an attachment, and both
  // are free; this one stays because installed apps open the reader with it.
  fastify.get(
    "/api/mobile/projects/:id/read/pdf",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const project = await prisma.project.findFirst({
        where: { id, userId: auth.user.id },
        select: { title: true, status: true, currentPlanId: true, contentRevision: true }
      });
      if (!project) {
        return sendProjectNotFound(reply);
      }
      const artifact = await readProjectExportArtifact(appConfig, id, "pdf", project);
      if (!artifact) {
        await ensureExportRepairQueued({ id, ...project }, "pdf", appConfig);
        return sendExportNotReady(reply);
      }
      reply.header("Content-Disposition", `inline; filename="${sanitizeDownloadFilename(project.title)}.pdf"`);
      reply.type(exportContentType("pdf"));
      setExportProvenanceHeaders(reply, artifact);
      return artifact.bytes;
    }
  );

  for (const format of EXPORT_FORMATS) {
    const gated = exportRequiresSubscription(format);
    fastify.get(
      `/api/mobile/projects/:id/export/${format}`,
      {
        schema: {
          tags: ["mobile"],
          response: { 401: mobileAuthError, ...(gated ? { 403: mobileAuthError } : {}), 404: mobileAuthError }
        }
      },
      async (request, reply) => {
        const auth = await requireMobileAuth(request, reply);
        if (!auth) {
          return;
        }
        const { id } = idParamsSchema.parse(request.params);
        const project = await prisma.project.findFirst({
          where: { id, userId: auth.user.id },
          select: { title: true, status: true, currentPlanId: true, contentRevision: true }
        });
        if (!project) {
          return sendProjectNotFound(reply);
        }
        if (gated && !(await hasActiveSubscriptionEntitlement(auth.user.id))) {
          return sendSubscriptionRequired(reply, SUBSCRIPTION_MESSAGE[format] ?? "This export is part of the Creator plan.");
        }
        // REVIEW_REQUIRED no longer refuses the download: the compile always
        // produces the best available book, and the flagged issues travel on the
        // serialized quality report for the app to warn with. The reader paid
        // for this book; QA gets to warn, not to withhold.
        const artifact = await readProjectExportArtifact(appConfig, id, format, project);
        if (!artifact) {
          await ensureExportRepairQueued({ id, ...project }, format, appConfig);
          return sendExportNotReady(reply);
        }
        return sendDownload(reply, {
          artifact,
          contentType: exportContentType(format),
          filename: `${sanitizeDownloadFilename(project.title)}.${format}`
        });
      }
    );
  }
}
