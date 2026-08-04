import { GooglePlayBillingConfigError, GooglePlayVerificationError } from "../../googlePlayBilling.js";
import {
  type MobileBillingDto,
  type MobileBillingResponseDto,
  type MobileCreditLogDto,
  type MobileGooglePlayVerificationResponseDto
} from "../dto.js";
import { hitAuthenticatedLimit, requireMobileAuth, sendMobileError } from "../httpErrors.js";
import { serializeMobileBilling } from "../billingSerializer.js";
import { serializeMobileCreditLog } from "../creditLog.js";
import { creditLogQuerySchema, mobileAuthError, mobileGooglePlayVerificationBodySchema } from "../schemas.js";
import { prisma } from "@book-maker/db";
import { endSubscriptionNow, recordVerifiedGooglePlayPurchase } from "@book-maker/db/billing";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { MobileRouteContext } from "../routeContext.js";

/**
 * Session identity and Google Play billing verification.
 */

export async function registerMobileAccountRoutes(fastify: FastifyInstance, context: MobileRouteContext): Promise<void> {
  const { appConfig, googlePlayVerifier, billingVerificationLimiter } = context;

  // Only the mock verifier can end a subscription on this side; against real
  // Play the app deep-links to the Play subscription centre instead.
  const canCancelInApp = appConfig.MOCK_GOOGLE_PLAY_BILLING;
  const billingFor = (userId: string): Promise<MobileBillingDto> => serializeMobileBilling(userId, { canCancelInApp });

  function sendPlayError(reply: FastifyReply, error: unknown): FastifyReply {
    if (error instanceof GooglePlayBillingConfigError) {
      return sendMobileError(reply, 503, error.code, "Google Play Billing is not configured on this backend yet.");
    }
    if (error instanceof GooglePlayVerificationError) {
      return sendMobileError(
        reply,
        502,
        error.code,
        "Google Play could not verify this purchase. Try restoring purchases in a moment."
      );
    }
    throw error;
  }

  fastify.get(
    "/api/mobile/me",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      return { user: auth.user };
    }
  );

  fastify.get(
    "/api/mobile/billing",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      return { billing: await billingFor(auth.user.id) } satisfies MobileBillingResponseDto;
    }
  );

  // Every credit that arrived or left, newest first. Paged by entry id so a
  // grant landing mid-scroll cannot shift the page under the reader.
  fastify.get(
    "/api/mobile/billing/credit-log",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const query = creditLogQuerySchema.safeParse(request.query ?? {});
      if (!query.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Ask for a valid page of credit history.");
      }
      return {
        log: await serializeMobileCreditLog(auth.user.id, query.data)
      } satisfies { log: MobileCreditLogDto };
    }
  );

  fastify.post(
    "/api/mobile/billing/google-play/verify",
    {
      attachValidation: true,
      schema: {
        tags: ["mobile"],
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            productId: { type: "string", minLength: 3, maxLength: 160 },
            purchaseToken: { type: "string", minLength: 8, maxLength: 8000 },
            transactionId: { type: "string", minLength: 1, maxLength: 240 },
            purchaseStatus: { type: "string", enum: ["purchased", "restored"] },
            projectId: { type: "string", minLength: 1, maxLength: 160 }
          },
          required: ["productId", "purchaseToken"]
        },
        response: { 401: mobileAuthError }
      }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(billingVerificationLimiter, request, reply, auth.user.id, "billing-verify")) {
        return;
      }
      const parsed = mobileGooglePlayVerificationBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send the Google Play product and purchase token.");
      }
      const product = await prisma.productCatalog.findUnique({
        where: { sku: parsed.data.productId },
        select: { sku: true, productType: true, active: true }
      });
      if (!product || !product.active) {
        return sendMobileError(reply, 400, "UNKNOWN_BILLING_PRODUCT", "This purchase is not available.");
      }

      try {
        const verification = await googlePlayVerifier.verifyPurchase({
          packageName: appConfig.GOOGLE_PLAY_PACKAGE_NAME ?? "",
          productId: product.sku,
          productType: product.productType,
          purchaseToken: parsed.data.purchaseToken
        });
        const purchase = await recordVerifiedGooglePlayPurchase({
          userId: auth.user.id,
          verification: {
            ...verification,
            metadata: {
              ...verification.metadata,
              clientTransactionId: parsed.data.transactionId ?? null,
              clientPurchaseStatus: parsed.data.purchaseStatus ?? null,
              projectId: parsed.data.projectId ?? null
            }
          }
        });
        return {
          purchase: {
            id: purchase.purchaseRecordId,
            status: purchase.status.toLowerCase(),
            creditsGranted: purchase.creditsGranted,
            subscriptionStatus: purchase.subscriptionStatus?.toLowerCase() ?? null,
            entitlementType: purchase.entitlementType
          },
          billing: await billingFor(auth.user.id)
        } satisfies MobileGooglePlayVerificationResponseDto;
      } catch (error) {
        return sendPlayError(reply, error);
      }
    }
  );

  /**
   * Ask Google what the subscription looks like now.
   *
   * Cancelling happens in the Play subscription centre, outside the app, and the
   * renewal sweep only re-verifies a token at its period end — so without this
   * the plan would keep saying "renews" for the rest of the month. Re-recording
   * a mid-period verification grants nothing: the credit grant is idempotent on
   * the order id Google already reported.
   */
  fastify.post(
    "/api/mobile/billing/subscription/refresh",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(billingVerificationLimiter, request, reply, auth.user.id, "billing-refresh")) {
        return;
      }
      const subscription = await prisma.subscriptionState.findFirst({
        where: { userId: auth.user.id, provider: "GOOGLE_PLAY", purchaseToken: { not: null } },
        orderBy: { currentPeriodEnd: "desc" },
        select: { purchaseToken: true, product: { select: { sku: true, productType: true } } }
      });
      if (!subscription?.purchaseToken || !subscription.product) {
        return sendMobileError(reply, 400, "NO_ACTIVE_SUBSCRIPTION", "There is no subscription to check.");
      }

      try {
        const verification = await googlePlayVerifier.verifyPurchase({
          packageName: appConfig.GOOGLE_PLAY_PACKAGE_NAME ?? "",
          productId: subscription.product.sku,
          productType: subscription.product.productType,
          purchaseToken: subscription.purchaseToken
        });
        await recordVerifiedGooglePlayPurchase({ userId: auth.user.id, verification });
      } catch (error) {
        return sendPlayError(reply, error);
      }
      return { billing: await billingFor(auth.user.id) } satisfies MobileBillingResponseDto;
    }
  );

  /**
   * End the subscription now and drop back to free.
   *
   * Only reachable against the mock Play verifier, which always answers ACTIVE —
   * a dev account that ever bought a plan could otherwise never see the free
   * tier again. Real purchases are cancelled in Play, because Google requires
   * it and because that is where the payment method lives.
   */
  fastify.post(
    "/api/mobile/billing/subscription/cancel",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(billingVerificationLimiter, request, reply, auth.user.id, "billing-cancel")) {
        return;
      }
      if (!canCancelInApp) {
        return sendMobileError(
          reply,
          400,
          "CANCEL_IN_PLAY",
          "Cancel this subscription from your Google Play account."
        );
      }
      const result = await endSubscriptionNow(auth.user.id);
      if (!result.ended) {
        return sendMobileError(reply, 400, "NO_ACTIVE_SUBSCRIPTION", "There is no subscription to cancel.");
      }
      return { billing: await billingFor(auth.user.id) } satisfies MobileBillingResponseDto;
    }
  );
}
