import type { FastifyInstance } from "fastify";
import { resetMessageAllowance } from "@book-maker/db/billing";
import type { MobileRouteContext } from "../routeContext.js";
import { hitAuthenticatedLimit, requireMobileAuth, sendMobileError } from "../httpErrors.js";
import { sendMessageUsageError } from "../messageUsage.js";
import { serializeMobileBilling } from "../billingSerializer.js";
import { resetMessageAllowanceSchema, resetMessageAllowanceOpenApiBody } from "../messageAllowanceSchemas.js";

export async function registerMobileMessageAllowanceRoutes(fastify: FastifyInstance, context: MobileRouteContext) {
  fastify.post("/api/mobile/billing/messages/reset", {
    attachValidation: true,
    schema: { tags: ["mobile"], body: resetMessageAllowanceOpenApiBody }
  }, async (request, reply) => {
    const auth = await requireMobileAuth(request, reply);
    if (!auth) return;
    if (!hitAuthenticatedLimit(context.draftLimiter, reply, auth.user.id, "message-reset")) return;
    const parsed = resetMessageAllowanceSchema.safeParse(request.body);
    if (!parsed.success) return sendMobileError(reply, 400, "VALIDATION_ERROR", "Review the message reset price and try again.");
    try {
      await resetMessageAllowance({ userId: auth.user.id, ...parsed.data });
    } catch (error) {
      return sendMessageUsageError(reply, error);
    }
    return { billing: await serializeMobileBilling(auth.user.id, { canCancelInApp: context.appConfig.MOCK_GOOGLE_PLAY_BILLING }) };
  });
}
