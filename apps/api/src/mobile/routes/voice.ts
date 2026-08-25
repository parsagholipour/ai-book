import { enqueueOrRequeueGenerationJob } from "../../queue.js";
import {
  type MobileVoiceCallMeterDto,
  type MobileVoiceCallSessionDto,
  type MobileVoiceCastDto
} from "../dto.js";
import {
  hitAuthenticatedLimit,
  requireMobileAuth,
  sendInsufficientCredits,
  sendMobileError,
  sendProjectNotFound
} from "../httpErrors.js";
import {
  idParamsSchema,
  mobileAuthError,
  mobileVoiceCallProgressBodySchema,
  mobileVoiceCallProgressOpenApiBody,
  mobileVoiceCallStartBodySchema,
  mobileVoiceCallStartOpenApiBody,
  voiceCallParamsSchema,
  voiceCharacterParamsSchema
} from "../schemas.js";
import {
  VoiceCallNotFoundError,
  endVoiceCall,
  heartbeatVoiceCall,
  startVoiceCall,
  voiceCallEntryCredits
} from "../voiceCalls.js";
import {
  appendVoiceCallMessages,
  formatVoiceCallHistory,
  loadVoiceCallHistory,
  type VoiceCallMessage
} from "../voiceCallHistory.js";
import { buildVoiceCallInstructions, loadReaderPageContext, loadVoiceCast, voiceCharacterSelect } from "../voiceCast.js";
import { loadVoiceBookCast } from "../../voiceBookContext.js";
import { VOICE_CALL_POLICY, creditPricing, normalizeVoiceProfile } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { InsufficientCreditsError, getCreditBalance } from "@book-maker/db/billing";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { MobileRouteContext } from "../routeContext.js";

/**
 * Live voice calls with the characters of a finished book.
 *
 * The app talks to Gemini directly — this API only mints the short-lived,
 * single-use token that lets it, and meters the credits while the call is up.
 * Audio never passes through the server, which is what keeps a call from
 * costing us a second hop of bandwidth and latency on every syllable.
 */

const GEMINI_INPUT_SAMPLE_RATE = 16000;
const GEMINI_OUTPUT_SAMPLE_RATE = 24000;

export async function registerMobileVoiceRoutes(fastify: FastifyInstance, context: MobileRouteContext): Promise<void> {
  const { appConfig, voiceCallLimiter, draftLimiter, voiceSession } = context;

  fastify.get(
    "/api/mobile/projects/:id/voice/cast",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const project = await prisma.project.findFirst({
        where: { id, userId: auth.user.id },
        select: { id: true, status: true }
      });
      if (!project) {
        return sendProjectNotFound(reply);
      }

      const [characters, balance] = await Promise.all([
        project.status === "COMPLETE" ? loadVoiceCast(id) : Promise.resolve([]),
        getCreditBalance(auth.user.id)
      ]);
      return {
        cast: {
          characters,
          creditsPerMinute: creditPricing().voiceCallPerMinute,
          creditsToStart: voiceCallEntryCredits(),
          availableCredits: balance.availableCredits,
          maxCallSeconds: VOICE_CALL_POLICY.maxCallMinutes * 60
        } satisfies MobileVoiceCastDto
      };
    }
  );

  fastify.post(
    "/api/mobile/projects/:id/voice/characters/:characterId/calls",
    {
      attachValidation: true,
      schema: {
        tags: ["mobile"],
        body: mobileVoiceCallStartOpenApiBody,
        response: { 401: mobileAuthError, 404: mobileAuthError }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id, characterId } = voiceCharacterParamsSchema.parse(request.params);
      const parsed = mobileVoiceCallStartBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "That call request was not understood.");
      }

      const character = await prisma.voiceCharacter.findFirst({
        where: { id: characterId, projectId: id, project: { userId: auth.user.id } },
        select: { ...voiceCharacterSelect, voiceProfile: true, project: { select: { title: true, status: true } } }
      });
      if (!character) {
        return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "That character is not in this book.");
      }
      if (character.project.status !== "COMPLETE") {
        return sendMobileError(reply, 409, "BOOK_NOT_READY", "You can call characters once the book is finished.");
      }
      if (character.status === "REJECTED") {
        return sendMobileError(reply, 409, "CHARACTER_UNAVAILABLE", "That character cannot take calls.");
      }
      if (!appConfig.GEMINI_API_KEY?.trim()) {
        return sendMobileError(reply, 503, "VOICE_UNAVAILABLE", "Voice calls are unavailable right now.");
      }

      // A character nobody has called yet has no persona. Building one takes a
      // few seconds, so the call is refused with a "getting ready" answer the
      // app shows as a ringing state rather than as an error.
      if (character.status !== "READY") {
        await ensureCharacterPersonaBuild(id, character.id, character.status);
        return sendMobileError(
          reply,
          409,
          "CHARACTER_PREPARING",
          `${character.name} is getting ready to talk. This takes a moment the first time.`
        );
      }

      // Counted here rather than at the top of the handler: everything above
      // either failed validation or answered "not yet", and charging a budget
      // for an answer that did no work is what let one first-time call burn a
      // whole hour of attempts.
      if (!hitAuthenticatedLimit(voiceCallLimiter, reply, auth.user.id, "voice-call")) {
        return;
      }

      // Read before the call row is created, so this call cannot remember
      // itself. A history read that fails is not worth losing a call over —
      // the character just meets them fresh.
      const [readerPage, history, bookCast] = await Promise.all([
        loadReaderPageContext(id, parsed.data.pageIndex),
        loadVoiceCallHistory({ userId: auth.user.id, characterId: character.id }).catch((error: unknown) => {
          request.log.warn({ err: error, projectId: id }, "Voice call history could not be read");
          return [];
        }),
        loadVoiceBookCast(id)
      ]);
      const instructions = buildVoiceCallInstructions({
        character,
        bookTitle: character.project.title,
        bookCast,
        readerPage,
        history: formatVoiceCallHistory(history)
      });

      let call;
      try {
        call = await startVoiceCall({ userId: auth.user.id, projectId: id, characterId: character.id });
      } catch (error) {
        if (error instanceof InsufficientCreditsError) {
          return sendInsufficientCredits(reply, error);
        }
        throw error;
      }

      try {
        const session = await voiceSession({
          characterName: character.name,
          instructions,
          voiceProfile: normalizeVoiceProfile(character.voiceProfile)
        });
        return {
          session: {
            callId: call.callId,
            characterId: character.id,
            characterName: character.name,
            token: session.token,
            model: session.model,
            expiresAt: session.expiresAt,
            inputSampleRate: GEMINI_INPUT_SAMPLE_RATE,
            outputSampleRate: GEMINI_OUTPUT_SAMPLE_RATE,
            secondsRemaining: call.secondsRemaining,
            creditsPerMinute: call.creditsPerMinute,
            heartbeatSeconds: call.heartbeatSeconds,
            maxCallSeconds: call.maxCallSeconds
          } satisfies MobileVoiceCallSessionDto
        };
      } catch (error) {
        // The hold was taken a moment ago for a call that never connected.
        // Releasing it here rather than leaving it to the sweep keeps a failed
        // provider call from looking like a charge.
        await endVoiceCall({ callId: call.callId, userId: auth.user.id, elapsedSeconds: 0, reason: "connect_failed" }).catch(
          () => undefined
        );
        request.log.warn({ err: error, projectId: id }, "Mobile voice call could not be started");
        return sendMobileError(reply, 503, "VOICE_UNAVAILABLE", "That call could not be connected. Try again in a moment.");
      }
    }
  );

  fastify.post(
    "/api/mobile/voice/calls/:callId/heartbeat",
    {
      attachValidation: true,
      schema: {
        tags: ["mobile"],
        body: mobileVoiceCallProgressOpenApiBody,
        response: { 401: mobileAuthError, 404: mobileAuthError }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      // The one mutating voice route that had no limiter: each hit costs a few
      // DB round-trips and possibly a billing call, and a real call heartbeats
      // only every few seconds. The draft budget is far above that.
      if (!hitAuthenticatedLimit(draftLimiter, reply, auth.user.id, "voice-call-heartbeat")) {
        return;
      }
      const { callId } = voiceCallParamsSchema.parse(request.params);
      const parsed = mobileVoiceCallProgressBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send the elapsed call time.");
      }

      try {
        const meter = await heartbeatVoiceCall({
          callId,
          userId: auth.user.id,
          elapsedSeconds: parsed.data.elapsedSeconds
        });
        await recordCallMessages(request, callId, auth.user.id, parsed.data.messages);
        return { meter: meter satisfies MobileVoiceCallMeterDto };
      } catch (error) {
        if (error instanceof VoiceCallNotFoundError) {
          return sendMobileError(reply, 404, "VOICE_CALL_NOT_FOUND", "That call has already ended.");
        }
        throw error;
      }
    }
  );

  fastify.post(
    "/api/mobile/voice/calls/:callId/end",
    {
      attachValidation: true,
      schema: {
        tags: ["mobile"],
        body: mobileVoiceCallProgressOpenApiBody,
        response: { 401: mobileAuthError, 404: mobileAuthError }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(draftLimiter, reply, auth.user.id, "voice-call-end")) {
        return;
      }
      const { callId } = voiceCallParamsSchema.parse(request.params);
      const parsed = mobileVoiceCallProgressBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send the elapsed call time.");
      }

      try {
        const meter = await endVoiceCall({
          callId,
          userId: auth.user.id,
          elapsedSeconds: parsed.data.elapsedSeconds,
          reason: parsed.data.reason ?? "ended"
        });
        await recordCallMessages(request, callId, auth.user.id, parsed.data.messages);
        return { meter: meter satisfies MobileVoiceCallMeterDto };
      } catch (error) {
        if (error instanceof VoiceCallNotFoundError) {
          return sendMobileError(reply, 404, "VOICE_CALL_NOT_FOUND", "That call has already ended.");
        }
        throw error;
      }
    }
  );
}

/**
 * Stores the transcript batch riding along with a heartbeat or a hang-up.
 *
 * Deliberately swallowed on failure: the meter has already answered, and a call
 * that drops mid-sentence because the character's memory could not be written
 * is a far worse trade than a call that forgets a line.
 */
async function recordCallMessages(
  request: FastifyRequest,
  callId: string,
  userId: string,
  messages: VoiceCallMessage[] | undefined
): Promise<void> {
  if (!messages?.length) {
    return;
  }
  try {
    await appendVoiceCallMessages({ callId, userId, messages });
  } catch (error) {
    request.log.warn({ err: error, callId }, "Voice call transcript could not be stored");
  }
}

async function ensureCharacterPersonaBuild(projectId: string, characterId: string, status: string): Promise<void> {
  if (status !== "CANDIDATE" && status !== "FAILED") {
    return;
  }
  await prisma.voiceCharacter.update({
    where: { id: characterId },
    data: { status: "APPROVED", approvedAt: new Date(), error: null }
  });
  // Or-requeue, because this path is reachable again after a FAILED build:
  // the plain enqueue answered a spent dedupe key with the failed row and
  // dispatched nothing, and since the character was just flipped APPROVED the
  // retry guard above never fired again — "getting ready" forever, with no
  // way out of it in the app.
  await enqueueOrRequeueGenerationJob({
    projectId,
    type: "BUILD_CHARACTER_PERSONA",
    dedupeKey: `build-character:${projectId}:${characterId}`,
    payload: { voiceCharacterId: characterId }
  });
}
