import type { FastifyInstance } from "fastify";
import { hitAuthenticatedLimit, requireMobileAuth, sendMobileError, sendUnreadableBodyError } from "../httpErrors.js";
import type { MobilePushDeviceResponseDto } from "../dto.js";
import {
  mobileAuthError,
  pushDeviceRegisterBodySchema,
  pushDeviceRegisterOpenApiBody,
  pushDeviceUnregisterBodySchema,
  pushDeviceUnregisterOpenApiBody
} from "../schemas.js";
import type { MobileRouteContext } from "../routeContext.js";
import { registerPushDevice, unregisterPushDevice } from "../../push/pushDevices.js";

/**
 * Where this install's book notifications go (`src/push/`). The app files its
 * FCM token after sign-in and whenever Firebase rotates it, and withdraws it
 * when the reader turns notifications off. Signing out needs no call here: the
 * device is bound to the session, and the logout that revokes the session is
 * what stops its pushes.
 */
export async function registerMobilePushDeviceRoutes(fastify: FastifyInstance, context: MobileRouteContext): Promise<void> {
  const { draftLimiter } = context;

  fastify.put(
    "/api/mobile/push-device",
    {
      attachValidation: true,
      errorHandler: sendUnreadableBodyError,
      schema: {
        tags: ["mobile"],
        body: pushDeviceRegisterOpenApiBody,
        response: { 400: mobileAuthError, 401: mobileAuthError, 429: mobileAuthError }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      if (!hitAuthenticatedLimit(draftLimiter, reply, auth.user.id, "push-device")) return;
      const parsed = pushDeviceRegisterBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "This device could not be registered for notifications.");
      }
      await registerPushDevice({
        token: parsed.data.token,
        platform: parsed.data.platform === "ios" ? "IOS" : "ANDROID",
        userId: auth.user.id,
        sessionId: auth.sessionId
      });
      return { ok: true } satisfies MobilePushDeviceResponseDto;
    }
  );

  fastify.delete(
    "/api/mobile/push-device",
    {
      attachValidation: true,
      errorHandler: sendUnreadableBodyError,
      schema: {
        tags: ["mobile"],
        body: pushDeviceUnregisterOpenApiBody,
        response: { 400: mobileAuthError, 401: mobileAuthError, 429: mobileAuthError }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      if (!hitAuthenticatedLimit(draftLimiter, reply, auth.user.id, "push-device")) return;
      const parsed = pushDeviceUnregisterBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "This device could not be unregistered.");
      }
      // Idempotent: a token that was never filed, or already withdrawn, is gone either way.
      await unregisterPushDevice({ token: parsed.data.token, userId: auth.user.id });
      return { ok: true } satisfies MobilePushDeviceResponseDto;
    }
  );
}
