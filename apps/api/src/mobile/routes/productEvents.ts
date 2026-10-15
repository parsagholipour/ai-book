import type { FastifyInstance } from "fastify";
import { recordProductEvent } from "../../productAnalytics.js";
import type { MobileProductEventResponseDto } from "../dto.js";
import { hitAuthenticatedLimit, requireMobileAuth, sendMobileError, sendUnreadableBodyError } from "../httpErrors.js";
import { productEventBodySchema, productEventFromBody, productEventOpenApiBody } from "../productEventBody.js";
import type { MobileRouteContext } from "../routeContext.js";
import { mobileAuthError } from "../schemas.js";

/**
 * What the app saw that the server cannot: a paywall being shown and what
 * showed it, a checkout started, cancelled in Play or failed, and the Play
 * install referrer an install came with. Read back only by the operator's
 * growth funnel. The reply is the same whether or not the row was written —
 * the app sends and forgets.
 */
export async function registerMobileProductEventRoutes(fastify: FastifyInstance, context: MobileRouteContext): Promise<void> {
  const { draftLimiter } = context;

  fastify.post(
    "/api/mobile/events",
    {
      attachValidation: true,
      errorHandler: sendUnreadableBodyError,
      schema: {
        tags: ["mobile"],
        body: productEventOpenApiBody,
        response: { 400: mobileAuthError, 401: mobileAuthError, 429: mobileAuthError }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      if (!hitAuthenticatedLimit(draftLimiter, reply, auth.user.id, "product-event")) return;
      const parsed = productEventBodySchema.safeParse(request.body);
      const event = parsed.success ? productEventFromBody(parsed.data) : null;
      if (!event) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "This event is not one the app reports.");
      }
      await recordProductEvent({ userId: auth.user.id, name: event.name, properties: event.properties }, request.log);
      return { ok: true } satisfies MobileProductEventResponseDto;
    }
  );
}
