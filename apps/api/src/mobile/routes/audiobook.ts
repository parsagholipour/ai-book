import { estimateAudiobookCreditCost, isAudiobookNarratorVoice } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import {
  InsufficientCreditsError,
  commitReservedCredits,
  refundCreditLedgerEntry,
  reserveCredits,
  type CreditLedgerEntryRecord
} from "@book-maker/db/billing";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dispatchGenerationJob, enqueueGenerationJob } from "../../queue.js";
import { ensureVoiceSample } from "../audiobookSamples.js";
import { serializeAudiobook, serializeNarratorVoices, type AudiobookWithChapters } from "../audiobookSerializer.js";
import type { MobileAudiobookDto, MobileNarratorVoiceDto } from "../dto.js";
import { hitAuthenticatedLimit, requireMobileAuth, sendInsufficientCredits, sendMobileError } from "../httpErrors.js";
import type { MobileRouteContext } from "../routeContext.js";
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
        return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
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
      if (!hitAuthenticatedLimit(context.generationLimiter, request, reply, auth.user.id, "narrate this book")) {
        return;
      }

      const project = await prisma.project.findFirst({
        where: { id, userId: auth.user.id },
        select: { id: true, status: true, contentRevision: true }
      });
      if (!project) {
        return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
      }
      if (project.status !== "COMPLETE") {
        return sendMobileError(reply, 409, "BOOK_NOT_READY", "Finish the book before narrating it.");
      }

      const existing = await loadAudiobook(id);
      if (existing?.status === "GENERATING") {
        return reply.code(202).send({ audiobook: serializeAudiobook(existing, project.contentRevision) });
      }
      if (existing?.status === "COMPLETE" && !body.data.replace) {
        return sendMobileError(reply, 409, "AUDIOBOOK_EXISTS", "This book already has an audiobook.");
      }

      const pageCount = await prisma.page.count({ where: { projectId: id, status: "COMPLETED" } });
      if (pageCount === 0) {
        return sendMobileError(reply, 409, "BOOK_NOT_READY", "Finish the book before narrating it.");
      }
      const estimate = estimateAudiobookCreditCost(pageCount);

      let reservation: CreditLedgerEntryRecord | null = null;
      let spend: CreditLedgerEntryRecord | null = null;
      try {
        reservation = await reserveCredits({
          userId: auth.user.id,
          projectId: id,
          operation: "AUDIOBOOK_GENERATION",
          amountCredits: estimate.totalCredits,
          idempotencyKey: body.data.requestId
            ? `mobile:audiobook:${id}:${body.data.requestId}`
            : `mobile:audiobook:${id}:${project.contentRevision}:${body.data.voice}`,
          description: "Mobile audiobook narration",
          // The per-page half of the price is only recoverable from here, which
          // is what the pricing dashboard's drivers report reads back.
          metadata: { pageCount, voice: body.data.voice, creditEstimate: estimate }
        });
        spend = reservation ? await commitReservedCredits(reservation.id) : null;

        const created = await prisma.$transaction(async (tx) => {
          // Replacing drops the old chapters with it; the worker clears the
          // superseded files from disk once the new narration lands.
          await tx.audiobook.deleteMany({ where: { projectId: id } });
          const audiobook = await tx.audiobook.create({
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
            dedupeKey: `generate-audiobook:${id}:${audiobook.id}`,
            transaction: tx,
            dispatch: false,
            payload: {
              audiobookId: audiobook.id,
              ...(spend ? { billingLedgerEntryId: spend.id } : {})
            }
          });
          await tx.audiobook.update({ where: { id: audiobook.id }, data: { generationJobId: job.id } });
          if (spend) {
            await tx.creditLedgerEntry.update({
              where: { id: spend.id },
              data: { projectId: id, generationJobId: job.id }
            });
          }
          return { job, audiobookId: audiobook.id };
        });

        await dispatchGenerationJob(created.job.id);
        const queued = await loadAudiobook(id);
        return reply.code(202).send({
          audiobook: queued ? serializeAudiobook(queued, project.contentRevision) : null
        });
      } catch (error) {
        const entryToRefund = spend ?? reservation;
        if (entryToRefund) {
          await refundCreditLedgerEntry(entryToRefund.id, "Narration could not be queued.");
        }
        if (error instanceof InsufficientCreditsError) {
          return sendInsufficientCredits(reply, error);
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

async function loadAudiobook(projectId: string): Promise<AudiobookWithChapters | null> {
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
    // A chapter's bytes never change: a re-narration writes a new audiobook id
    // and therefore a new URL.
    .header("Cache-Control", "private, max-age=86400, immutable")
    .send(bytes);
}
