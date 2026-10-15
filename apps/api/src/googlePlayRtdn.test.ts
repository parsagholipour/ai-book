import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@book-maker/core";
import type { GooglePlayVerifier } from "./googlePlayBilling.js";

const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(), recordRefund: vi.fn(), recordPurchase: vi.fn(), findPurchase: vi.fn()
}));
vi.mock("google-auth-library", () => ({ OAuth2Client: class { verifyIdToken = mocks.verifyIdToken; } }));
vi.mock("@book-maker/db", () => ({ prisma: { purchaseRecord: { findFirst: mocks.findPurchase } } }));
vi.mock("@book-maker/db/billing", () => ({
  recordGooglePlayRefund: mocks.recordRefund, recordVerifiedGooglePlayPurchase: mocks.recordPurchase,
  hashPurchaseToken: () => "token-hash"
}));

import { registerAuth } from "./auth.js";
import { GOOGLE_PLAY_RTDN_PATH, googlePlayRtdnRoutes } from "./googlePlayRtdn.js";

const config = { ...loadConfig(), WEB_PASSWORD: "operator-test-password", GOOGLE_PLAY_PACKAGE_NAME: "com.tomeza.tomeza",
  GOOGLE_PLAY_RTDN_AUDIENCE: "https://example.com/api/billing/google-play/rtdn",
  GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL: "play-push@example.iam.gserviceaccount.com" };
const voided = { purchaseToken: "purchase-token", orderId: "GPA.123", productType: 2, refundType: 1 };
const headers = { authorization: "Bearer signed-google-token" };
const verifier = {
  verifyPurchase: vi.fn(), acknowledgePurchase: vi.fn(), readRefundableQuantity: vi.fn(), cancelSubscription: vi.fn()
} satisfies GooglePlayVerifier;
const apps: ReturnType<typeof Fastify>[] = [];
function envelope(event: Record<string, unknown>, packageName = config.GOOGLE_PLAY_PACKAGE_NAME) {
  return { message: { messageId: "message-1", data: Buffer.from(JSON.stringify({
    version: "1.0", packageName, eventTimeMillis: "1791000000000", ...event
  })).toString("base64") }, subscription: "projects/example/subscriptions/play-refunds" };
}
async function appWith(options = config) {
  const app = Fastify();
  apps.push(app);
  await registerAuth(app, options);
  await app.register(googlePlayRtdnRoutes, { config: options, verifier });
  return app;
}

describe("Google Play Pub/Sub RTDN", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.verifyIdToken.mockResolvedValue({ getPayload: () => ({ email: config.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL, email_verified: true }) });
  });
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

  it("accepts an authenticated void notice without operator cookies and waits for its durable write", async () => {
    const app = await appWith();
    const response = await app.inject({ method: "POST", url: GOOGLE_PLAY_RTDN_PATH, headers,
      payload: envelope({ voidedPurchaseNotification: voided }) });
    expect(response.statusCode).toBe(204);
    expect(mocks.verifyIdToken).toHaveBeenCalledWith({ idToken: "signed-google-token", audience: config.GOOGLE_PLAY_RTDN_AUDIENCE });
    expect(mocks.recordRefund).toHaveBeenCalledWith(expect.objectContaining({ purchaseToken: "purchase-token", orderId: "GPA.123", productType: 2 }));
    expect(verifier.verifyPurchase).not.toHaveBeenCalled();
  });

  it.each(["missing", "invalid", "wrong-email", "unverified-email"])("refuses %s authentication before billing reads or writes", async (reason) => {
    if (reason === "invalid") mocks.verifyIdToken.mockRejectedValue(new Error("signature, audience or expiry rejected"));
    if (reason === "wrong-email") mocks.verifyIdToken.mockResolvedValue({ getPayload: () => ({ email: "other@example.com", email_verified: true }) });
    if (reason === "unverified-email") mocks.verifyIdToken.mockResolvedValue({ getPayload: () => ({ email: config.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL, email_verified: false }) });
    const app = await appWith();
    const response = await app.inject({ method: "POST", url: GOOGLE_PLAY_RTDN_PATH,
      headers: reason === "missing" ? {} : headers, payload: envelope({ voidedPurchaseNotification: voided }) });
    expect([401, 403]).toContain(response.statusCode);
    expect(mocks.recordRefund).not.toHaveBeenCalled();
    expect(mocks.findPurchase).not.toHaveBeenCalled();
  });

  it("fails closed when push authentication is unconfigured", async () => {
    const app = await appWith({ ...config, GOOGLE_PLAY_RTDN_AUDIENCE: "" });
    const response = await app.inject({ method: "POST", url: GOOGLE_PLAY_RTDN_PATH, headers,
      payload: envelope({ voidedPurchaseNotification: voided }) });
    expect(response.statusCode).toBe(503);
    expect(mocks.recordRefund).not.toHaveBeenCalled();
  });

  it("rejects another app's package", async () => {
    const app = await appWith();
    const response = await app.inject({ method: "POST", url: GOOGLE_PLAY_RTDN_PATH, headers,
      payload: envelope({ voidedPurchaseNotification: voided }, "another.app") });
    expect(response.statusCode).toBe(403);
    expect(mocks.recordRefund).not.toHaveBeenCalled();
  });

  it.each([
    {}, { message: { messageId: "m", data: "%%%" }, subscription: "s" },
    { message: { messageId: "m", data: Buffer.from("not-json").toString("base64") }, subscription: "s" },
    envelope({ voidedPurchaseNotification: { ...voided, purchaseToken: "" } }),
    envelope({ voidedPurchaseNotification: voided, testNotification: { version: "1.0" } })
  ])("rejects a malformed message", async (payload) => {
    const app = await appWith();
    const response = await app.inject({ method: "POST", url: GOOGLE_PLAY_RTDN_PATH, headers, payload });
    expect(response.statusCode).toBe(400);
    expect(mocks.recordRefund).not.toHaveBeenCalled();
  });

  it("acknowledges console test messages without touching billing", async () => {
    const app = await appWith();
    const response = await app.inject({ method: "POST", url: GOOGLE_PLAY_RTDN_PATH, headers,
      payload: envelope({ testNotification: { version: "1.0" } }) });
    expect(response.statusCode).toBe(204);
    expect(mocks.recordRefund).not.toHaveBeenCalled();
    expect(mocks.recordPurchase).not.toHaveBeenCalled();
  });

  it("returns a retryable failure if persisting the reversal fails", async () => {
    mocks.recordRefund.mockRejectedValueOnce(new Error("database unavailable"));
    const app = await appWith();
    const response = await app.inject({ method: "POST", url: GOOGLE_PLAY_RTDN_PATH, headers,
      payload: envelope({ voidedPurchaseNotification: voided }) });
    expect(response.statusCode).toBe(500);
  });

  it("verifies partial refund quantities before writing, and retries provider errors", async () => {
    verifier.readRefundableQuantity.mockResolvedValueOnce({ quantity: 5, refundableQuantity: 3 })
      .mockRejectedValueOnce(new Error("Google unavailable"));
    const app = await appWith();
    const request = { method: "POST" as const, url: GOOGLE_PLAY_RTDN_PATH, headers,
      payload: envelope({ voidedPurchaseNotification: { ...voided, refundType: 2 } }) };
    expect((await app.inject(request)).statusCode).toBe(204);
    expect(mocks.recordRefund).toHaveBeenCalledWith(expect.objectContaining({ partialRefund: { quantity: 5, refundableQuantity: 3 } }));
    expect((await app.inject(request)).statusCode).toBe(500);
    expect(mocks.recordRefund).toHaveBeenCalledTimes(1);
  });

  it("refreshes an ordinary subscription cancellation without treating it as a refund", async () => {
    mocks.findPurchase.mockResolvedValue({ userId: "user-a", product: { sku: "creator", productType: "SUBSCRIPTION" } });
    const verification = { productSku: "creator", purchaseToken: "purchase-token", grantable: true,
      providerStatus: "SUBSCRIPTION_STATE_CANCELED", kind: "subscription", subscription: { status: "CANCELED" } };
    verifier.verifyPurchase.mockResolvedValue(verification);
    const app = await appWith();
    const response = await app.inject({ method: "POST", url: GOOGLE_PLAY_RTDN_PATH, headers,
      payload: envelope({ subscriptionNotification: { purchaseToken: "purchase-token", notificationType: 3 } }) });
    expect(response.statusCode).toBe(204);
    expect(mocks.recordPurchase).toHaveBeenCalledWith({ userId: "user-a", verification });
    expect(mocks.recordRefund).not.toHaveBeenCalled();
  });

  it("reverses a revoked subscription using its verified order", async () => {
    mocks.findPurchase.mockResolvedValue({ userId: "user-a", product: { sku: "creator", productType: "SUBSCRIPTION" } });
    verifier.verifyPurchase.mockResolvedValue({ grantable: false, externalPurchaseId: "GPA.revoked" });
    const app = await appWith();
    const response = await app.inject({ method: "POST", url: GOOGLE_PLAY_RTDN_PATH, headers,
      payload: envelope({ subscriptionNotification: { purchaseToken: "purchase-token", notificationType: 12 } }) });
    expect(response.statusCode).toBe(204);
    expect(mocks.recordRefund).toHaveBeenCalledWith({ purchaseToken: "purchase-token", orderId: "GPA.revoked", productType: 1 });
  });
});
