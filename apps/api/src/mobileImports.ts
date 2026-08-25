import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import {
  MANUSCRIPT_MAX_BYTES,
  ManuscriptImportError,
  deriveManuscriptTitle,
  detectCreationAttachmentType,
  loadConfig,
  mediaSettingsSchema,
  parseManuscript,
  type ManuscriptImportFormat,
  type ParsedManuscript
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import {
  consumeManuscriptImportUseTx,
  getImportQuota,
  hasActiveSubscriptionEntitlement
} from "@book-maker/db/billing";
import { z } from "zod";
import { saveCreationAttachmentFile } from "./attachmentStorage.js";
import {
  hitAuthenticatedLimit,
  loadMobileProjectDetail,
  mobileAuthError,
  requireMobileAuth,
  sendMobileError,
  serializeProjectDetail,
  type MobileProjectDetailDto
} from "./mobileProjects.js";
import { dispatchGenerationJob, enqueueGenerationJob } from "./queue.js";
import { InMemoryRateLimiter, type RateLimitConfig } from "./rateLimit.js";

/** Aborts the import transaction when the month's slot is already used. */
class ImportQuotaExhaustedError extends Error {
  constructor(readonly limit: number) {
    super("Manuscript import quota exhausted");
  }
}

/**
 * "Bring your own book": authors upload a finished manuscript and it becomes
 * a first-class project — real Chapter/Page rows behind the existing chat,
 * edit, and export stack. Subscribers import without limits; the free tier
 * gets a monthly allowance (`freeManuscriptImportsPerMonth`), claimed only
 * after the upload has validated so a rejected file never burns the month's
 * import. The heavy parsing/segmentation runs in the worker's IMPORT_BOOK job.
 */

/** Rough chars-per-page used only for the provisional targetPages estimate. */
const IMPORT_PAGE_CHARS_ESTIMATE = 1900;
const IMPORT_MAX_PAGES = 600;

const DEFAULT_IMPORT_RATE_LIMIT = { maxAttempts: 12, windowMs: 60 * 60 * 1000 };

/** Formats importable without a vision model; PDF is deliberately deferred. */
const IMPORTABLE_FORMATS: ReadonlySet<string> = new Set(["docx", "epub", "html", "rtf", "text"]);

const importQuerySchema = z.object({
  filename: z.string().trim().min(1).max(200),
  requestId: z.string().trim().min(8).max(64),
  mimeType: z.string().trim().min(3).max(160).optional(),
  title: z.string().trim().min(1).max(160).optional(),
  language: z.string().trim().min(2).max(40).optional()
});

export type MobileImportResponseDto = {
  project: MobileProjectDetailDto;
  import: {
    id: string;
    status: string;
    fileName: string;
    format: string;
    stats: Record<string, unknown> | null;
  };
  operation: {
    kind: "import_queued";
    jobId: string;
    message: string;
  } | null;
};

export type MobileImportRoutesOptions = {
  importRateLimit?: Partial<RateLimitConfig>;
  /** Test seam for subscription checks; defaults to the billing lookup. */
  subscriptionCheck?: (userId: string) => Promise<boolean>;
};

export const mobileImportRoutes: FastifyPluginAsync<MobileImportRoutesOptions> = async (fastify, options) => {
  const appConfig = loadConfig();
  const importLimiter = new InMemoryRateLimiter({
    ...DEFAULT_IMPORT_RATE_LIMIT,
    ...options.importRateLimit
  });
  const subscriptionCheck = options.subscriptionCheck ?? ((userId: string) => hasActiveSubscriptionEntitlement(userId));

  // Raw binary upload; metadata travels in the query string. Registered here
  // because content-type parsers are scoped to the plugin that adds them.
  fastify.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body)
  );

  fastify.post(
    "/api/mobile/projects/import",
    {
      bodyLimit: MANUSCRIPT_MAX_BYTES + 64 * 1024,
      schema: {
        tags: ["mobile"],
        response: { 200: {}, 201: {}, 401: mobileAuthError, 403: mobileAuthError, 422: mobileAuthError }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(importLimiter, reply, auth.user.id, "book-import")) {
        return;
      }
      const query = importQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send the file with a filename and requestId.");
      }

      // Subscribers skip the quota entirely; everyone else is checked against
      // the free monthly allowance *after* the upload validates, further down.
      const subscribed = await subscriptionCheck(auth.user.id);

      // Idempotent replay: the same requestId always answers with the project
      // the first attempt created, never a duplicate.
      const replayed = await prisma.bookImport.findUnique({
        where: { userId_requestId: { userId: auth.user.id, requestId: query.data.requestId } }
      });
      if (replayed) {
        if (replayed.projectId) {
          const project = await loadMobileProjectDetail(auth.user.id, replayed.projectId);
          if (project) {
            const job = await prisma.generationJob.findUnique({
              where: { dedupeKey: `import-book:${replayed.projectId}` }
            });
            return reply.code(200).send({
              project: await serializeProjectDetail(project, appConfig, auth.user.id),
              import: serializeBookImport(replayed),
              operation: job
                ? { kind: "import_queued" as const, jobId: job.id, message: "Importing your book." }
                : null
            } satisfies MobileImportResponseDto);
          }
        }
        // The requestId was spent by an import whose book no longer exists
        // (deleted after importing). Falling through used to hit the
        // (userId, requestId) unique index and answer 500 on every retry,
        // forever; a fresh import needs a fresh requestId, so say that.
        return sendMobileError(
          reply,
          409,
          "IMPORT_REQUEST_ALREADY_USED",
          "That upload already finished and its book was since deleted. Import the file again to make a new book."
        );
      }

      const data = request.body;
      if (!Buffer.isBuffer(data) || data.length === 0) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send the manuscript file as the request body.");
      }

      const detected = detectCreationAttachmentType(query.data.filename, query.data.mimeType);
      if (!detected || detected.kind === "photo" || !IMPORTABLE_FORMATS.has(detected.format)) {
        return sendMobileError(
          reply,
          422,
          "UNSUPPORTED_TYPE",
          detected?.format === "pdf"
            ? "PDF import isn't available yet. Export your manuscript as Word (.docx), EPUB, or plain text and upload that instead."
            : "That file type can't be imported. Word (.docx), EPUB, HTML, RTF, plain text, and Markdown files work."
        );
      }

      // Cheap local parse for instant feedback; the worker re-parses when the
      // import job runs (local extraction is fast even at the 20 MB cap).
      let parsed: ParsedManuscript;
      try {
        parsed = await parseManuscript({ data, format: detected.format as ManuscriptImportFormat });
      } catch (error) {
        if (error instanceof ManuscriptImportError) {
          return sendMobileError(reply, 422, error.code, error.message);
        }
        request.log.warn({ err: error }, "Manuscript import parse failed");
        return sendMobileError(reply, 422, "UNREADABLE_FILE", "That file could not be read. Try a different file.");
      }

      const importId = `imp_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      const title = deriveManuscriptTitle({
        override: query.data.title,
        sections: parsed.sections,
        fileName: query.data.filename
      });
      const targetPages = Math.min(
        IMPORT_MAX_PAGES,
        Math.max(1, Math.round(parsed.charCount / IMPORT_PAGE_CHARS_ESTIMATE))
      );
      const mediaSettings = mediaSettingsSchema.parse({
        fullIllustrations: false,
        illustrationCadence: "manual",
        includeCover: false,
        // An imported manuscript brings no artwork, so it gets a designed one.
        coverArtSource: "design",
        coverTemplate: "auto",
        finalReview: false,
        toneProfile: "neutral",
        mobile: {
          bookType: "custom",
          lengthPreset: "custom",
          qualityPreset: "balanced",
          imagesEnabled: false,
          pageCountMode: "custom",
          targetPages,
          pageCountSource: "settings",
          import: {
            importId,
            fileName: query.data.filename,
            format: detected.format,
            sizeBytes: data.length,
            importedAt: new Date().toISOString()
          }
        }
      });

      // Store the original bytes first: the worker reads them from the shared
      // attachment volume, and a failed write must not leave DB rows behind.
      try {
        await saveCreationAttachmentFile(appConfig.ATTACHMENT_STORAGE_DIR, importId, "source", data);
      } catch (error) {
        request.log.error({ err: error, importId }, "Manuscript import file store failed");
        return sendMobileError(reply, 422, "IMPORT_FAILED", "That file could not be saved. Try again.");
      }

      // The free tier's monthly import is claimed last, so every 4xx above
      // cost nothing — and *inside* the transaction that creates the project
      // and queues the job, so a crash or failure anywhere in between rolls
      // the claim back with everything else instead of burning the month's
      // slot on an import that never existed. The claim still rides the job
      // payload as `importQuota`, which is what lets a failed worker import
      // hand the slot back (markFailed).
      const quota = subscribed ? null : await getImportQuota(auth.user.id);
      let importQuotaPeriodKey: string | null = null;

      const created = await prisma.$transaction(async (tx) => {
        if (quota) {
          const claim = await consumeManuscriptImportUseTx(tx, { userId: auth.user.id, limit: quota.limit });
          if (!claim.allowed) {
            throw new ImportQuotaExhaustedError(claim.limit);
          }
          importQuotaPeriodKey = claim.periodKey;
        }
        const project = await tx.project.create({
          data: {
            userId: auth.user.id,
            title,
            prompt: `Imported manuscript: ${title}. The author's uploaded text is the canonical book content.`,
            category: "CUSTOM",
            targetPages,
            complexity: 5,
            temperature: 0.8,
            language: query.data.language ?? "en",
            mediaSettings: mediaSettings as Prisma.InputJsonValue,
            status: "GENERATING"
          }
        });
        const bookImport = await tx.bookImport.create({
          data: {
            id: importId,
            userId: auth.user.id,
            requestId: query.data.requestId,
            projectId: project.id,
            fileName: query.data.filename,
            mimeType: detected.mimeType,
            format: detected.format,
            sizeBytes: data.length,
            status: "UPLOADED",
            stats: {
              charCount: parsed.charCount,
              wordCount: parsed.wordCount,
              sectionCount: parsed.sections.length
            }
          }
        });
        const durableJob = await enqueueGenerationJob({
          projectId: project.id,
          type: "IMPORT_BOOK",
          dedupeKey: `import-book:${project.id}`,
          transaction: tx,
          dispatch: false,
          payload: {
            importId,
            language: query.data.language ?? null,
            ...(importQuotaPeriodKey ? { importQuota: { userId: auth.user.id, periodKey: importQuotaPeriodKey } } : {})
          }
        });
        return { project, bookImport, durableJob };
      }).catch((error: unknown) => {
        // The rollback already handed the quota slot back — the claim lives in
        // this transaction. Only the "slot exhausted" refusal needs a reply of
        // its own; anything else is a real failure for the outer handler. The
        // same SUBSCRIPTION_REQUIRED code as before the allowance existed,
        // because shipped clients answer it with the upgrade sheet — which is
        // also the right answer to "this month's import is used".
        if (error instanceof ImportQuotaExhaustedError) {
          return null;
        }
        throw error;
      });
      if (!created) {
        const limit = quota?.limit ?? 1;
        return sendMobileError(
          reply,
          403,
          "SUBSCRIPTION_REQUIRED",
          limit === 1
            ? "You've used this month's free import. Importing more is part of the Creator plan."
            : `Free plans include ${limit} manuscript imports a month and you have used all of them. Importing more is part of the Creator plan.`
        );
      }

      await dispatchGenerationJob(created.durableJob.id);

      const detail = (await loadMobileProjectDetail(auth.user.id, created.project.id)) ?? null;
      if (!detail) {
        return sendMobileError(reply, 422, "IMPORT_FAILED", "The imported book could not be loaded. Try again.");
      }
      return reply.code(201).send({
        project: await serializeProjectDetail(detail, appConfig, auth.user.id),
        import: serializeBookImport(created.bookImport),
        operation: {
          kind: "import_queued" as const,
          jobId: created.durableJob.id,
          message: "Importing your book."
        }
      } satisfies MobileImportResponseDto);
    }
  );

  fastify.get(
    "/api/mobile/projects/:id/import",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const bookImport = await prisma.bookImport.findFirst({
        where: { projectId: id, userId: auth.user.id }
      });
      if (!bookImport) {
        return sendMobileError(reply, 404, "IMPORT_NOT_FOUND", "This book was not imported.");
      }
      return { import: serializeBookImport(bookImport) };
    }
  );
};

function serializeBookImport(bookImport: {
  id: string;
  status: string;
  fileName: string;
  format: string;
  stats: unknown;
}): MobileImportResponseDto["import"] {
  return {
    id: bookImport.id,
    status: bookImport.status,
    fileName: bookImport.fileName,
    format: bookImport.format,
    stats:
      bookImport.stats && typeof bookImport.stats === "object" && !Array.isArray(bookImport.stats)
        ? (bookImport.stats as Record<string, unknown>)
        : null
  };
}
