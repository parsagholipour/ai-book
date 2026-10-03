import type { FastifyInstance } from "fastify";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { loadConfig, type AppConfig } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { hashPurchaseToken, recordGooglePlayRefund, recordVerifiedGooglePlayPurchase } from "@book-maker/db/billing";
import { createGooglePlayVerifierFromConfig, purchaseNeedsAcknowledgement, type GooglePlayVerifier } from "./googlePlayBilling.js";

export const GOOGLE_PLAY_RTDN_PATH = "/api/billing/google-play/rtdn";
const nonempty = z.string().min(1);
const envelopeSchema = z.object({
  message: z.object({ data: nonempty, messageId: nonempty }), subscription: nonempty
});
const notificationSchema = z.object({
  packageName: nonempty,
  eventTimeMillis: z.string().regex(/^\d+$/),
  testNotification: z.object({ version: nonempty }).optional(),
  voidedPurchaseNotification: z.object({
    purchaseToken: nonempty, orderId: nonempty,
    productType: z.union([z.literal(1), z.literal(2)]),
    refundType: z.union([z.literal(1), z.literal(2)])
  }).optional(),
  subscriptionNotification: z.object({ purchaseToken: nonempty, notificationType: z.number().int() }).optional(),
  oneTimeProductNotification: z.object({ purchaseToken: nonempty, notificationType: z.number().int(), sku: nonempty }).optional()
}).refine((value) => [value.testNotification, value.voidedPurchaseNotification,
  value.subscriptionNotification, value.oneTimeProductNotification].filter(Boolean).length <= 1);

/** This endpoint has its own Google OIDC authentication, independent of app sessions.
 * 204 acknowledges only completed work. Provider/database errors remain retryable. */
export async function googlePlayRtdnRoutes(app: FastifyInstance, options: {
  config?: AppConfig;
  verifier?: GooglePlayVerifier;
} = {}): Promise<void> {
  const config = options.config ?? loadConfig();
  const verifier = options.verifier ?? createGooglePlayVerifierFromConfig(config);
  const oidc = new OAuth2Client();
  app.post(GOOGLE_PLAY_RTDN_PATH, { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const audience = config.GOOGLE_PLAY_RTDN_AUDIENCE;
    const email = config.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL;
    if (!audience || !email || !config.GOOGLE_PLAY_PACKAGE_NAME) {
      return reply.code(503).send({ error: "Google Play notifications are not configured." });
    }
    const token = request.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token) return reply.code(401).send({ error: "Google push authentication required." });
    try {
      const ticket = await oidc.verifyIdToken({ idToken: token, audience });
      const payload = ticket.getPayload();
      if (payload?.email !== email || payload.email_verified !== true) {
        return reply.code(403).send({ error: "Unexpected Google push identity." });
      }
    } catch {
      return reply.code(401).send({ error: "Invalid Google push token." });
    }
    const envelope = envelopeSchema.safeParse(request.body);
    if (!envelope.success) return reply.code(400).send({ error: "Invalid Pub/Sub envelope." });
    let decoded: unknown;
    try {
      const encoded = envelope.data.message.data;
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error("base64");
      decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    } catch {
      return reply.code(400).send({ error: "Invalid notification data." });
    }
    const parsed = notificationSchema.safeParse(decoded);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid Google Play notification." });
    const notification = parsed.data;
    if (notification.packageName !== config.GOOGLE_PLAY_PACKAGE_NAME) {
      return reply.code(403).send({ error: "Unexpected Google Play package." });
    }
    const voided = notification.voidedPurchaseNotification;
    if (voided) {
      if (voided.refundType === 2 && (voided.productType !== 2 || !verifier.readRefundableQuantity)) {
        return reply.code(503).send({ error: "Partial refund verification unavailable." });
      }
      const partialRefund = voided.refundType === 2
        ? await verifier.readRefundableQuantity!({ packageName: notification.packageName,
            purchaseToken: voided.purchaseToken, orderId: voided.orderId }) : undefined;
      await recordGooglePlayRefund({ ...voided, partialRefund });
    } else {
      const event = notification.subscriptionNotification ?? notification.oneTimeProductNotification;
      if (event) {
        const purchase = await prisma.purchaseRecord.findFirst({
          where: { provider: "GOOGLE_PLAY", purchaseTokenHash: hashPurchaseToken(event.purchaseToken) },
          select: { userId: true, product: { select: { sku: true, productType: true } } }
        });
        if (purchase?.product) {
          const verificationRequest = { packageName: notification.packageName, purchaseToken: event.purchaseToken,
            productId: purchase.product.sku, productType: purchase.product.productType };
          const verification = await verifier.verifyPurchase(verificationRequest);
          // A revocation differs from turning auto-renew off. Consult Google's
          // current state so an old delivery cannot revoke a recovered renewal.
          if (notification.subscriptionNotification?.notificationType === 12 && !verification.grantable) {
            if (!verification.externalPurchaseId) throw new Error("Revoked subscription has no order ID.");
            await recordGooglePlayRefund({ purchaseToken: event.purchaseToken,
              orderId: verification.externalPurchaseId, productType: 1 });
          } else {
            await recordVerifiedGooglePlayPurchase({ userId: purchase.userId, verification });
          }
          if (purchaseNeedsAcknowledgement(verification)) await verifier.acknowledgePurchase(verificationRequest);
        }
        // Unclaimed purchases belong to no local account. The app will verify
        // them on claim; voided notices above are retained even without an owner.
      }
    }
    request.log.info({ event: "google_play.rtdn_processed", messageId: envelope.data.message.messageId },
      "Google Play notification processed");
    return reply.code(204).send();
  });
}
