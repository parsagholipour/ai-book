import { GooglePlayBillingConfigError, GooglePlayVerificationError } from "../../googlePlayBilling.js";
import { type MobileGooglePlayVerificationResponseDto } from "../dto.js";
import { hitAuthenticatedLimit, requireMobileAuth, sendMobileError } from "../httpErrors.js";
import { serializeMobileBilling } from "../billingSerializer.js";
import { mobileAuthError, mobileGooglePlayVerificationBodySchema } from "../schemas.js";
import { prisma } from "@book-maker/db";
import { recordVerifiedGooglePlayPurchase } from "@book-maker/db/billing";
import type { FastifyInstance } from "fastify";
import type { MobileRouteContext } from "../routeContext.js";

/**
 * Session identity and Google Play billing verification.
 */

export async function registerMobileAccountRoutes(fastify: FastifyInstance, context: MobileRouteContext): Promise<void> {
  const { appConfig, googlePlayVerifier, billingVerificationLimiter } = context;

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
      return { billing: await serializeMobileBilling(auth.user.id) };
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
          billing: await serializeMobileBilling(auth.user.id)
        } satisfies MobileGooglePlayVerificationResponseDto;
      } catch (error) {
        if (error instanceof GooglePlayBillingConfigError) {
          return sendMobileError(
            reply,
            503,
            error.code,
            "Google Play Billing is not configured on this backend yet."
          );
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
    }
  );
}
