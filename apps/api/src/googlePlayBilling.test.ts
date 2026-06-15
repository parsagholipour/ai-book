import { describe, expect, it, vi } from "vitest";
import {
  GooglePlayBillingConfigError,
  createGooglePlayVerifier
} from "./googlePlayBilling.js";

describe("Google Play billing verifier", () => {
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
        startTime: "2026-06-15T00:00:00Z",
        subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
        acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
        lineItems: [
          {
            productId: "tomeza.creator_monthly",
            expiryTime: "2026-07-15T00:00:00Z",
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
      subscription: {
        status: "ACTIVE",
        currentPeriodStart: new Date("2026-06-15T00:00:00Z"),
        currentPeriodEnd: new Date("2026-07-15T00:00:00Z")
      }
    });
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
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
