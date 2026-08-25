import { estimateAudiobookCreditCost, isAudiobookNarratorVoice } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { GenerationAttemptConflictError, startGenerationAttempt } from "@book-maker/db/billing";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dispatchGenerationJob, enqueueGenerationJob } from "../../queue.js";
import { ensureVoiceSample } from "../audiobookSamples.js";
import { serializeAudiobook, serializeNarratorVoices } from "../audiobookSerializer.js";
import type { MobileAudiobookDto, MobileNarratorVoiceDto } from "../dto.js";
import {
  hitTieredLimit,
  requireMobileAuth,
  sendGenerationAttemptError,
  sendMobileError,
  sendProjectNotFound
} from "../httpErrors.js";
import type { MobileRouteContext } from "../routeContext.js";
import { fingerprintGenerationRequest } from "../support.js";
import {
  idParamsSchema,
  mobileAudiobookChapterParamsSchema,
  mobileAudiobookStartBodySchema,
  mobileAudiobookStartOpenApiBody,
  mobileAuthError,
  mobileVoiceSampleParamsSchema
} from "../schemas.js";

/**
 * Narration: pick a voice, pay for it, then stream the chapters back as they
 * are finished.
 *
 * Chapter audio is downloaded and cached by the app rather than streamed, so
 * these serve whole files. Individual chapters are a few megabytes, which is the
 * same shape as the export downloads next door.
 */

export async function registerMobileAudiobookRoutes(fastify: FastifyInstance, context: MobileRouteContext): Promise<void> {
  const { appConfig } = context;

  fastify.get(
    "/api/mobile/audiobook/voices",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      return { voices: serializeNarratorVoices() satisfies MobileNarratorVoiceDto[] };
    }
  );

  fastify.get(
    "/api/mobile/audiobook/voices/:voice/sample",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { voice } = mobileVoiceSampleParamsSchema.parse(request.params);
      if (!isAudiobookNarratorVoice(voice)) {
        return sendMobileError(reply, 404, "VOICE_NOT_FOUND", "That narrator is not available.");
      }
      try {
        const sample = await ensureVoiceSample(appConfig, voice);
        return reply
          .type("audio/mpeg")
          // The URL carries a version, so both HTTP clients and the app's local
          // file cache can safely keep these bytes for a year.
          .header("Cache-Control", "private, max-age=31536000, immutable")
          .send(sample);
      } catch {
        return sendMobileError(reply, 503, "VOICE_SAMPLE_UNAVAILABLE", "That preview could not be played right now.");
      }
    }
  );

  fastify.get(
    "/api/mobile/projects/:id/audiobook",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const project = await prisma.project.findFirst({
        where: { id, userId: auth.user.id },
        select: { id: true, contentRevision: true }
      });
      if (!project) {
        return sendProjectNotFound(reply);
      }
      const audiobook = await loadAudiobook(id);
      if (!audiobook) {
        return sendMobileError(reply, 404, "AUDIOBOOK_NOT_FOUND", "This book has not been narrated yet.");
      }
      return { audiobook: serializeAudiobook(audiobook, project.contentRevision) satisfies MobileAudiobookDto };
    }
  );

  fastify.post(
    "/api/mobile/projects/:id/audiobook",
    { schema: { tags: ["mobile"], body: mobileAudiobookStartOpenApiBody } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const body = mobileAudiobookStartBodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "This narration request is invalid.");
      }
      if (!isAudiobookNarratorVoice(body.data.voice)) {
        return sendMobileError(reply, 400, "VOICE_NOT_FOUND", "That narrator is not available.");
      }
      // Returns true when the request is allowed through, false once it has
      // already sent the rate-limit response.
      if (!(await hitTieredLimit(context.generationLimiter, request, reply, auth.user.id, "narrate this book"))) {
        return;
      }

      const project = await prisma.project.findFirst({
        where: { id, userId: auth.user.id },
        select: { id: true, status: true, contentRevision: true }
      });
      if (!project) {
        return sendProjectNotFound(reply);
      }
      if (project.status !== "COMPLETE") {
        return sendMobileError(reply, 409, "BOOK_NOT_READY", "Finish the book before narrating it.");
      }

      const pageCount = await prisma.page.count({ where: { projectId: id, status: "COMPLETED" } });
      if (pageCount === 0) {
        return sendMobileError(reply, 409, "BOOK_NOT_READY", "Finish the book before narrating it.");
      }
      const requestFingerprint = fingerprintGenerationRequest({
        projectId: id,
        contentRevision: project.contentRevision,
        pageCount,
        voice: body.data.voice,
        replace: body.data.replace === true
      });
      const existing = await loadAudiobook(id);
      if (existing?.status === "GENERATING") {
        const existingAttempt = existing.generationJobId
          ? await prisma.generationAttempt.findUnique({
              where: { primaryJobId: existing.generationJobId },
              select: { requestFingerprint: true }
            })
          : null;
        const existingFingerprint = existingAttempt?.requestFingerprint;
        if (
          existing.voice !== body.data.voice ||
          (existingFingerprint !== undefined && existingFingerprint !== requestFingerprint)
        ) {
          return sendMobileError(
            reply,
            409,
            "GENERATION_COMMAND_CONFLICT",
            "This audiobook command is already running with different settings."
          );
        }
        return reply.code(202).send({ audiobook: serializeAudiobook(existing, project.contentRevision) });
      }
      if (existing?.status === "COMPLETE" && !body.data.replace) {
        return sendMobileError(reply, 409, "AUDIOBOOK_EXISTS", "This book already has an audiobook.");
      }

      const estimate = estimateAudiobookCreditCost(pageCount);

      // Restarting a failed narration is a paid retry of the attempt that paid
      // for it: naming the source blocks a fresh charge while the failed run's
      // refund is still pending, and makes a duplicate start — whatever its
      // requestId — replay the one retry instead of charging a second time.
      // Rows narrated before the attempt ledger existed resolve to null and
      // keep starting fresh.
      const resumableSource =
        existing?.status === "FAILED" &&
        existing.voice === body.data.voice &&
        existing.contentRevision === project.contentRevision
          ? existing
          : null;
      const sourceAttempt = resumableSource?.generationJobId
        ? await prisma.generationAttempt.findUnique({
            where: { primaryJobId: resumableSource.generationJobId },
            select: { id: true }
          })
        : null;

      try {
        const sourceRun = existing?.generationJobId ?? existing?.id ?? "new";
        const started = await startGenerationAttempt({
          userId: auth.user.id,
          commandKey: body.data.requestId
            ? `mobile:audiobook-start:${id}:${body.data.requestId}`
            : `mobile:audiobook-start:${id}:${project.contentRevision}:${sourceRun}`,
          requestFingerprint,
          projectId: id,
          operation: "AUDIOBOOK_GENERATION",
          quotedCredits: estimate.totalCredits,
          description: "Mobile audiobook narration",
          ...(sourceAttempt ? { retryOfAttemptId: sourceAttempt.id } : {}),
          // The per-page half of the price is only recoverable from here, which
          // is what the pricing dashboard's drivers report reads back.
          metadata: { pageCount, voice: body.data.voice, creditEstimate: estimate },

          // A narration that died half way through keeps its row, and with it the
          // chapters already on disk: the worker skips every READY chapter, so
          // restarting picks up where it stopped instead of re-reading the first
          // half. Only when it is the same book read by the same narrator — any
          // other change is a different audiobook and starts clean.
          create: async (tx, { attemptId, ledgerEntry }) => {
            // Re-read inside the transaction: the route's snapshot is stale the
            // moment a concurrent start commits, and a serializable retry
            // re-runs this callback against the winner's committed state.
            const current = await tx.audiobook.findUnique({
              where: { projectId: id },
              select: { id: true, status: true, voice: true, contentRevision: true, generationJobId: true }
            });
            if (current?.status === "GENERATING") {
              throw new GenerationAttemptConflictError("This book is already being narrated.");
            }
            const resumable =
              current?.status === "FAILED" &&
              current.voice === body.data.voice &&
              current.contentRevision === project.contentRevision
                ? current
                : null;

            // Replacing drops the old chapters with it; the worker clears the
            // superseded files from disk once the new narration lands.
            if (!resumable) {
              await tx.audiobook.deleteMany({ where: { projectId: id } });
            }
            const audiobook = resumable
              ? await tx.audiobook.update({
                  where: { id: resumable.id },
                  data: { status: "GENERATING", error: null, contentRevision: project.contentRevision }
                })
              : await tx.audiobook.create({
                  data: {
                    projectId: id,
                    voice: body.data.voice,
                    status: "GENERATING",
                    contentRevision: project.contentRevision
                  }
                });
            const job = await enqueueGenerationJob({
              projectId: id,
              type: "GENERATE_AUDIOBOOK",
              // A resume reuses the audiobook id, so that alone would match the
              // failed run's job row and enqueue nothing at all. Naming the run
              // being resumed makes the key new for each attempt; a double-submit
              // is caught earlier, by the GENERATING check.
              dedupeKey: `generate-audiobook:${id}:${audiobook.id}:${resumable?.generationJobId ?? "new"}`,
              transaction: tx,
              dispatch: false,
              attemptId,
              payload: {
                audiobookId: audiobook.id,
                ...(ledgerEntry ? { billingLedgerEntryId: ledgerEntry.id } : {})
              }
            });
            await tx.audiobook.update({ where: { id: audiobook.id }, data: { generationJobId: job.id } });
            return { projectId: id, primaryJobId: job.id };
          }
        });

        if (!started.attempt.primaryJobId) {
          throw new Error("Audiobook attempt has no primary job.");
        }
        await dispatchGenerationJob(started.attempt.primaryJobId);
        const queued = await loadAudiobook(id);
        return reply.code(202).send({
          audiobook: queued ? serializeAudiobook(queued, project.contentRevision) : null
        });
      } catch (error) {
        if (sendGenerationAttemptError(reply, error)) {
          return;
        }
        throw error;
      }
    }
  );

  fastify.get(
    "/api/mobile/projects/:id/audiobook/chapters/:index/audio",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const resolved = await resolveReadyChapter(request, reply, appConfig.AUDIO_STORAGE_DIR);
      if (!resolved) {
        return;
      }
      return sendChapterFile(reply, join(resolved.dir, `chapter-${resolved.index}.mp3`), "audio/mpeg");
    }
  );

  fastify.get(
    "/api/mobile/projects/:id/audiobook/chapters/:index/timeline",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const resolved = await resolveReadyChapter(request, reply, appConfig.AUDIO_STORAGE_DIR);
      if (!resolved) {
        return;
      }
      return sendChapterFile(reply, join(resolved.dir, `chapter-${resolved.index}.timeline.json`), "application/json");
    }
  );
}

/**
 * Ownership, readiness and the on-disk location for one chapter — the three
 * checks both file routes need before they touch the filesystem.
 */
async function resolveReadyChapter(
  request: FastifyRequest,
  reply: FastifyReply,
  audioStorageDir: string
): Promise<{ dir: string; index: number } | null> {
  const auth = await requireMobileAuth(request, reply);
  if (!auth) {
    return null;
  }
  const params = mobileAudiobookChapterParamsSchema.safeParse(request.params);
  if (!params.success) {
    sendMobileError(reply, 404, "AUDIOBOOK_CHAPTER_NOT_FOUND", "That chapter is not ready yet.");
    return null;
  }

  const audiobook = await prisma.audiobook.findFirst({
    where: { projectId: params.data.id, project: { userId: auth.user.id } },
    select: { id: true, projectId: true, chapters: { where: { index: params.data.index }, select: { status: true } } }
  });
  if (!audiobook || audiobook.chapters[0]?.status !== "READY") {
    sendMobileError(reply, 404, "AUDIOBOOK_CHAPTER_NOT_FOUND", "That chapter is not ready yet.");
    return null;
  }

  return { dir: join(audioStorageDir, audiobook.projectId, audiobook.id), index: params.data.index };
}

/**
 * The whole row, not just what the serializer needs: the start route also reads
 * the failed run's id to decide whether narration can resume. It stays
 * assignable to `AudiobookWithChapters`, which is what keeps the mobile response
 * narrow.
 */
async function loadAudiobook(projectId: string) {
  return prisma.audiobook.findUnique({
    where: { projectId },
    include: { chapters: { orderBy: { index: "asc" } } }
  });
}

async function sendChapterFile(reply: FastifyReply, path: string, contentType: string) {
  const bytes = await readFile(path).catch(() => null);
  if (!bytes) {
    return sendMobileError(reply, 404, "AUDIOBOOK_CHAPTER_NOT_FOUND", "That chapter is not ready yet.");
  }
  return reply
    .type(contentType)
    // Runtime fallback rewrites the bytes under a new render-version query key.
    .header("Cache-Control", "private, max-age=86400, immutable")
    .send(bytes);
}
