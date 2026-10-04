import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "@book-maker/core";
import {
  GooglePlayBillingConfigError,
  GooglePlayProductMismatchError,
  createGooglePlayVerifier,
  purchaseNeedsAcknowledgement,
  createGooglePlayVerifierFromConfig
} from "./googlePlayBilling.js";

describe("Google Play billing verifier", () => {
  it("records the successful subscription order that refund notices identify", async () => {
    const verifier = createGooglePlayVerifier({ accessToken: "test-token", fetchImpl: vi.fn(async () => jsonResponse({
      latestOrderId: "GPA.pending-renewal", subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      lineItems: [{ productId: "creator", expiryTime: "2030-01-01T00:00:00Z", latestSuccessfulOrderId: "GPA.paid" }]
    })) });
    expect(await verifier.verifyPurchase({ packageName: "com.tomeza.tomeza", purchaseToken: "token",
      productType: "SUBSCRIPTION", productId: "creator" })).toMatchObject({ externalPurchaseId: "GPA.paid", grantable: true });
  });

  it("fetches authoritative remaining quantities for a partially refunded order", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ orderId: "GPA.partial",
      productLineItem: [{ productOfferDetails: { quantity: 5, refundableQuantity: 3 } }] }));
    const verifier = createGooglePlayVerifier({ accessToken: "test-token", fetchImpl: fetchMock });
    expect(await verifier.readRefundableQuantity!({ packageName: "com.tomeza.tomeza", purchaseToken: "token/with slash", orderId: "GPA.partial" }))
      .toEqual({ quantity: 5, refundableQuantity: 3 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.tomeza.tomeza/purchases/productsv2/tokens/token%2Fwith%20slash",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer test-token" }) })
    );
  });

  it.each([
    { orderId: "another-order", quantity: 5, refundableQuantity: 3 },
    { orderId: "GPA.partial", quantity: 5 },
    { orderId: "GPA.partial", quantity: 5, refundableQuantity: 5 },
    { orderId: "GPA.partial", quantity: 5, refundableQuantity: -1 }
  ])("refuses missing or inconsistent refund quantities", async ({ orderId, ...details }) => {
    const verifier = createGooglePlayVerifier({ accessToken: "test-token", fetchImpl: vi.fn(async () => jsonResponse({
      orderId, productLineItem: [{ productOfferDetails: details }]
    })) });
    await expect(verifier.readRefundableQuantity!({ packageName: "com.tomeza.tomeza", purchaseToken: "token", orderId: "GPA.partial" }))
      .rejects.toThrow("refund quantity is unavailable or inconsistent");
  });

  it("does not turn an unspecified purchase state into a cancellation", async () => {
    const verifier = createGooglePlayVerifier({ accessToken: "test-token", fetchImpl: vi.fn(async () => jsonResponse({})) });
    expect(await verifier.verifyPurchase({ packageName: "com.tomeza.tomeza", purchaseToken: "token",
      productType: "CREDIT_PACK", productId: "pack" })).toMatchObject({ grantable: false, providerStatus: "UNKNOWN" });
  });

  it("verifies one-time purchases with mocked Google responses", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        orderId: "GPA.1111-2222-3333-44444",
        purchaseTimeMillis: "1781524800000",
        purchaseState: 0,
        acknowledgementState: 0,
        consumptionState: 0,
        quantity: 2,
        regionCode: "US"
      })
    );
    const verifier = createGooglePlayVerifier({
      packageName: "com.tomeza.tomeza",
      accessToken: "test-access-token",
      fetchImpl: fetchMock as typeof fetch
    });

    const result = await verifier.verifyPurchase({
      packageName: "com.tomeza.tomeza",
      productId: "tomeza.credit_pack_1",
      productType: "CREDIT_PACK",
      purchaseToken: "purchase-token"
    });

    expect(result).toMatchObject({
      productSku: "tomeza.credit_pack_1",
      kind: "one_time",
      grantable: true,
      providerStatus: "PURCHASED",
      externalPurchaseId: "GPA.1111-2222-3333-44444",
      quantity: 2
    });
    expect(result.purchasedAt?.toISOString()).toBe("2026-06-15T12:00:00.000Z");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.tomeza.tomeza/purchases/products/tomeza.credit_pack_1/tokens/purchase-token",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-access-token" })
      })
    );
  });

  it("keeps pending one-time purchases non-grantable", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ purchaseState: 2 }));
    const verifier = createGooglePlayVerifier({
      packageName: "com.tomeza.tomeza",
      accessToken: "test-access-token",
      fetchImpl: fetchMock as typeof fetch
    });

    const result = await verifier.verifyPurchase({
      packageName: "com.tomeza.tomeza",
      productId: "tomeza.one_book_export",
      productType: "ONE_TIME_UNLOCK",
      purchaseToken: "pending-token"
    });

    expect(result.grantable).toBe(false);
    expect(result.providerStatus).toBe("PENDING");
  });

  it("verifies subscription purchases with mocked Google responses", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        latestOrderId: "GPA.5555-6666-7777-88888",
        linkedPurchaseToken: "replaced-subscription-token",
        startTime: "2026-06-15T00:00:00Z",
        subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
        acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
        lineItems: [
          {
            productId: "tomeza.creator_monthly",
            expiryTime: "2099-07-15T00:00:00Z",
            autoRenewingPlan: { autoRenewEnabled: true }
          }
        ]
      })
    );
    const verifier = createGooglePlayVerifier({
      packageName: "com.tomeza.tomeza",
      accessToken: "test-access-token",
      fetchImpl: fetchMock as typeof fetch
    });

    const result = await verifier.verifyPurchase({
      packageName: "com.tomeza.tomeza",
      productId: "tomeza.creator_monthly",
      productType: "SUBSCRIPTION",
      purchaseToken: "subscription-token"
    });

    expect(result).toMatchObject({
      productSku: "tomeza.creator_monthly",
      kind: "subscription",
      grantable: true,
      providerStatus: "SUBSCRIPTION_STATE_ACTIVE",
      externalPurchaseId: "GPA.5555-6666-7777-88888",
      metadata: { linkedPurchaseToken: "replaced-subscription-token" },
      subscription: {
        status: "ACTIVE",
        currentPeriodStart: new Date("2026-06-15T00:00:00Z"),
        currentPeriodEnd: new Date("2099-07-15T00:00:00Z"),
        autoRenewing: true
      }
    });
  });

  it("refuses a subscription token posted as a plan it does not cover", async () => {
    // A Creator token claimed as Max used to be granted Max: the endpoint is
    // keyed by token alone, and the first line item stood in for a match.
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        latestOrderId: "GPA.1111-2222-3333-44444",
        startTime: "2026-06-15T00:00:00Z",
        subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
        lineItems: [{ productId: "tomeza.creator_monthly", expiryTime: "2099-07-15T00:00:00Z" }]
      })
    );
    const verifier = createGooglePlayVerifier({
      packageName: "com.tomeza.tomeza",
      accessToken: "test-access-token",
      fetchImpl: fetchMock as typeof fetch
    });

    await expect(
      verifier.verifyPurchase({
        packageName: "com.tomeza.tomeza",
        productId: "tomeza.max_monthly",
        productType: "SUBSCRIPTION",
        purchaseToken: "creator-token"
      })
    ).rejects.toBeInstanceOf(GooglePlayProductMismatchError);
  });

  it("acknowledges a purchase with Google on the endpoint for its kind", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    const verifier = createGooglePlayVerifier({
      packageName: "com.tomeza.tomeza",
      accessToken: "test-access-token",
      fetchImpl: fetchMock as unknown as typeof fetch
    });
    await verifier.acknowledgePurchase({
      packageName: "com.tomeza.tomeza",
      productId: "tomeza.creator_monthly",
      productType: "SUBSCRIPTION",
      purchaseToken: "sub/token"
    });
    await verifier.acknowledgePurchase({
      packageName: "com.tomeza.tomeza",
      productId: "tomeza.credits_small",
      productType: "CREDIT_PACK",
      purchaseToken: "pack-token"
    });
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [
        "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.tomeza.tomeza/purchases/subscriptions/tomeza.creator_monthly/tokens/sub%2Ftoken:acknowledge",
        "POST"
      ],
      [
        "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.tomeza.tomeza/purchases/products/tomeza.credits_small/tokens/pack-token:acknowledge",
        "POST"
      ]
    ]);
  });

  it("acknowledges only a grantable purchase Google still reports pending", () => {
    const base = { productSku: "x", purchaseToken: "t", kind: "one_time" as const, providerStatus: "PURCHASED", externalPurchaseId: null, purchasedAt: null };
    expect(purchaseNeedsAcknowledgement({ ...base, grantable: true, metadata: { acknowledgementState: 0 } })).toBe(true);
    expect(purchaseNeedsAcknowledgement({ ...base, grantable: true, metadata: { acknowledgementState: 1 } })).toBe(false);
    expect(
      purchaseNeedsAcknowledgement({ ...base, grantable: true, metadata: { acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING" } })
    ).toBe(true);
    expect(purchaseNeedsAcknowledgement({ ...base, grantable: false, metadata: { acknowledgementState: 0 } })).toBe(false);
  });

  it("reads auto-renew off as a plan that ends rather than one that renews", async () => {
    // Play reports this well before it moves the subscription to CANCELED, and
    // the benefits run to the expiry either way — so it still grants.
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        latestOrderId: "GPA.5555-6666-7777-88888",
        startTime: "2026-06-15T00:00:00Z",
        subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
        lineItems: [
          {
            productId: "tomeza.creator_monthly",
            expiryTime: "2099-07-15T00:00:00Z",
            autoRenewingPlan: { autoRenewEnabled: false }
          }
        ]
      })
    );
    const verifier = createGooglePlayVerifier({
      packageName: "com.tomeza.tomeza",
      accessToken: "test-access-token",
      fetchImpl: fetchMock as typeof fetch
    });

    const result = await verifier.verifyPurchase({
      packageName: "com.tomeza.tomeza",
      productId: "tomeza.creator_monthly",
      productType: "SUBSCRIPTION",
      purchaseToken: "subscription-token"
    });

    expect(result.grantable).toBe(true);
    expect(result.subscription).toMatchObject({ status: "ACTIVE", autoRenewing: false });
  });

  it("requires Google Play configuration before verification", async () => {
    const verifier = createGooglePlayVerifier({});

    await expect(
      verifier.verifyPurchase({
        packageName: "",
        productId: "tomeza.one_book_export",
        productType: "ONE_TIME_UNLOCK",
        purchaseToken: "purchase-token"
      })
    ).rejects.toBeInstanceOf(GooglePlayBillingConfigError);
  });

  it("uses grantable mock purchases when backend dev billing is enabled", async () => {
    const verifier = createGooglePlayVerifierFromConfig(
      loadConfig({
        NODE_ENV: "development",
        MOCK_GOOGLE_PLAY_BILLING: "true"
      })
    );

    const oneTime = await verifier.verifyPurchase({
      packageName: "",
      productId: "tomeza.credit_pack_1",
      productType: "CREDIT_PACK",
      purchaseToken: "debug-purchase-token-1"
    });
    const subscription = await verifier.verifyPurchase({
      packageName: "",
      productId: "tomeza.creator_monthly",
      productType: "SUBSCRIPTION",
      purchaseToken: "debug-subscription-token-1"
    });

    expect(oneTime).toMatchObject({
      productSku: "tomeza.credit_pack_1",
      purchaseToken: "debug-purchase-token-1",
      kind: "one_time",
      grantable: true,
      providerStatus: "MOCK_PURCHASED",
      quantity: 1,
      metadata: { mockGooglePlayBilling: true }
    });
    expect(subscription).toMatchObject({
      productSku: "tomeza.creator_monthly",
      kind: "subscription",
      grantable: true,
      providerStatus: "MOCK_SUBSCRIPTION_ACTIVE",
      subscription: { status: "ACTIVE" },
      metadata: { mockGooglePlayBilling: true }
    });
    expect(subscription.subscription?.currentPeriodEnd?.getTime()).toBeGreaterThan(
      subscription.subscription?.currentPeriodStart?.getTime() ?? 0
    );
  });

  it("accepts mock billing by default in backend dev mode", () => {
    const config = loadConfig({ NODE_ENV: "development" });

    expect(config.NODE_ENV).toBe("development");
    expect(config.MOCK_GOOGLE_PLAY_BILLING).toBe(true);
  });

  it("does not accept mock billing in production", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      S3_BUCKET: "test-private-bucket",
      MOCK_AI: "true",
      ALLOW_MOCK_AI_IN_PRODUCTION: "true",
      MOCK_GOOGLE_PLAY_BILLING: "true"
    });

    expect(config.NODE_ENV).toBe("production");
    expect(config.MOCK_AI).toBe(true);
    expect(config.MOCK_GOOGLE_PLAY_BILLING).toBe(false);
  });

  it("refuses to start production on mock AI unless the smoke test asked for it", () => {
    expect(() => loadConfig({ NODE_ENV: "production", S3_BUCKET: "test-private-bucket", MOCK_AI: "true" })).toThrow(
      /MOCK_AI must be off in production/
    );
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
