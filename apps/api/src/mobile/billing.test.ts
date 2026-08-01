import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import {
  getCreditBalance,
  getImageQuota,
  getPlanSummary,
  listActiveUserEntitlements,
  recordVerifiedGooglePlayPurchase
} from "@book-maker/db/billing";

import {
  bearer,
  buildMobileApp,
  creditBalance,
  mockAccessTokens,
  mockPrisma,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

describe("mobile billing and Google Play", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("exposes mobile credit balance and active entitlements without provider internals", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    vi.mocked(getCreditBalance).mockResolvedValue(
      creditBalance({ availableCredits: 850, reservedCredits: 150, lifetimeCreditsGranted: 1000, lifetimeCreditsSpent: 150 })
    );
    vi.mocked(listActiveUserEntitlements).mockResolvedValue([
      {
        id: "entitlement-export",
        userId: "user-a",
        projectId: "project-1",
        type: "EXPORT_UNLOCK",
        status: "ACTIVE",
        source: "credits",
        creditsCost: 150,
        startsAt: new Date("2026-06-15T12:00:00.000Z"),
        expiresAt: null
      }
    ]);
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/billing",
      headers: bearer("token-a")
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.billing.credits).toEqual({
      available: 850,
      purchased: 850,
      reserved: 150,
      lifetimeGranted: 1000,
      lifetimeSpent: 150
    });
    expect(body.billing.entitlements).toEqual([
      expect.objectContaining({
        type: "EXPORT_UNLOCK",
        projectId: "project-1",
        creditsCost: 150
      })
    ]);
    expect(body.billing.products.map((product: { sku: string }) => product.sku)).toContain("tomeza.one_book_export");
    expect(JSON.stringify(body.billing)).not.toMatch(/provider|model|temperature|generationStrategy/);
    await app.close();
  });

  it("reports the plan, its allowance, and the free tier's image budget", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    vi.mocked(getCreditBalance).mockResolvedValue(
      creditBalance({
        availableCredits: 1400,
        purchasedCredits: 500,
        planCredits: 900,
        planCreditsPerPeriod: 1000,
        planPeriodEnd: new Date("2026-07-01T00:00:00.000Z"),
        planPeriodKey: "free:2026-06"
      })
    );
    vi.mocked(listActiveUserEntitlements).mockResolvedValue([]);
    vi.mocked(getImageQuota).mockResolvedValue({
      used: 2,
      limit: 3,
      periodKey: "2026-06",
      resetsAt: new Date("2026-07-01T00:00:00.000Z")
    });
    const app = await buildMobileApp();

    const body = (
      await app.inject({ method: "GET", url: "/api/mobile/billing", headers: bearer("token-a") })
    ).json();

    expect(body.billing.plan).toEqual({
      tier: "free",
      source: "free",
      status: null,
      renewsAt: null,
      productSku: null
    });
    expect(body.billing.allowance).toEqual({
      monthlyCredits: 1000,
      planCredits: 900,
      resetsAt: "2026-07-01T00:00:00.000Z"
    });
    expect(body.billing.imageQuota).toEqual({ used: 2, limit: 3, resetsAt: "2026-07-01T00:00:00.000Z" });
    // The app reads `available` as everything spendable, allowance included.
    expect(body.billing.credits).toMatchObject({ available: 1400, purchased: 500 });

    const subscriptions = body.billing.products.filter(
      (product: { productType: string }) => product.productType === "SUBSCRIPTION"
    );
    expect(subscriptions.map((product: { sku: string }) => product.sku)).toEqual([
      "tomeza.creator_monthly",
      "tomeza.pro_monthly",
      "tomeza.max_monthly"
    ]);
    // Credits per dollar has to climb with the tier or the ladder makes no sense.
    const perDollar = subscriptions.map(
      (product: { creditAmount: number; priceMicros: number }) => product.creditAmount / (product.priceMicros / 1_000_000)
    );
    expect(perDollar[1]).toBeGreaterThan(perDollar[0]);
    expect(perDollar[2]).toBeGreaterThan(perDollar[1]);

    // Same app, same route: on a paid plan the image limit goes away entirely.
    vi.mocked(getCreditBalance).mockResolvedValue(creditBalance({ availableCredits: 15_000 }));
    vi.mocked(getImageQuota).mockResolvedValue(null);
    vi.mocked(getPlanSummary).mockResolvedValue({
      tier: "pro",
      source: "google_play",
      status: "ACTIVE",
      renewsAt: new Date("2026-07-15T00:00:00.000Z"),
      productSku: "tomeza.pro_monthly"
    });
    const paid = (
      await app.inject({ method: "GET", url: "/api/mobile/billing", headers: bearer("token-a") })
    ).json();

    expect(paid.billing.imageQuota).toBeNull();
    expect(paid.billing.plan).toMatchObject({ tier: "pro", renewsAt: "2026-07-15T00:00:00.000Z" });
    await app.close();
  });

  it("verifies Google Play purchase tokens before granting mobile credits", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.productCatalog.findUnique.mockResolvedValueOnce({
      sku: "tomeza.credit_pack_1",
      productType: "CREDIT_PACK",
      active: true
    });
    vi.mocked(recordVerifiedGooglePlayPurchase).mockResolvedValueOnce({
      purchaseRecordId: "purchase-credit-pack",
      status: "GRANTED",
      creditsGranted: 1000,
      ledgerEntryId: "ledger-credit-pack",
      subscriptionStatus: null,
      entitlementType: null
    });
    vi.mocked(getCreditBalance).mockResolvedValueOnce(creditBalance({ availableCredits: 1100 }));
    const verifier = {
      verifyPurchase: vi.fn(async () => ({
        productSku: "tomeza.credit_pack_1",
        purchaseToken: "google-token-1",
        kind: "one_time" as const,
        grantable: true,
        providerStatus: "PURCHASED",
        externalPurchaseId: "GPA.1111-2222-3333-44444",
        purchasedAt: new Date("2026-06-15T12:00:00.000Z"),
        quantity: 1,
        metadata: { mockedGoogle: true }
      }))
    };
    const app = await buildMobileApp({ googlePlayVerifier: verifier });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/billing/google-play/verify",
      headers: bearer("token-a"),
      payload: {
        productId: "tomeza.credit_pack_1",
        purchaseToken: "google-token-1",
        transactionId: "GPA.1111-2222-3333-44444",
        purchaseStatus: "purchased",
        projectId: "project-1"
      }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(verifier.verifyPurchase).toHaveBeenCalledWith({
      packageName: "",
      productId: "tomeza.credit_pack_1",
      productType: "CREDIT_PACK",
      purchaseToken: "google-token-1"
    });
    expect(vi.mocked(recordVerifiedGooglePlayPurchase)).toHaveBeenCalledWith({
      userId: "user-a",
      verification: expect.objectContaining({
        productSku: "tomeza.credit_pack_1",
        purchaseToken: "google-token-1",
        grantable: true,
        metadata: expect.objectContaining({
          clientTransactionId: "GPA.1111-2222-3333-44444",
          clientPurchaseStatus: "purchased",
          projectId: "project-1"
        })
      })
    });
    expect(body.purchase).toEqual({
      id: "purchase-credit-pack",
      status: "granted",
      creditsGranted: 1000,
      subscriptionStatus: null,
      entitlementType: null
    });
    expect(body.billing.credits.available).toBe(1100);
    expect(JSON.stringify(body)).not.toMatch(/provider|model|temperature|generationStrategy|purchaseToken/);
    await app.close();
  });

  it("uses debug Google Play verification for local credit purchases", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.MOCK_GOOGLE_PLAY_BILLING;
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.productCatalog.findUnique.mockResolvedValueOnce({
      sku: "tomeza.credit_pack_2",
      productType: "CREDIT_PACK",
      active: true
    });
    vi.mocked(recordVerifiedGooglePlayPurchase).mockResolvedValueOnce({
      purchaseRecordId: "purchase-debug-credit-pack",
      status: "GRANTED",
      creditsGranted: 2000,
      ledgerEntryId: "ledger-debug-credit-pack",
      subscriptionStatus: null,
      entitlementType: null
    });
    vi.mocked(getCreditBalance).mockResolvedValueOnce(creditBalance({ availableCredits: 2100 }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/billing/google-play/verify",
      headers: bearer("token-a"),
      payload: {
        productId: "tomeza.credit_pack_2",
        purchaseToken: "debug-token-1",
        transactionId: "debug-order-1",
        purchaseStatus: "purchased"
      }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(vi.mocked(recordVerifiedGooglePlayPurchase)).toHaveBeenCalledWith({
      userId: "user-a",
      verification: expect.objectContaining({
        productSku: "tomeza.credit_pack_2",
        purchaseToken: "debug-token-1",
        kind: "one_time",
        grantable: true,
        providerStatus: "MOCK_PURCHASED",
        metadata: expect.objectContaining({
          mockGooglePlayBilling: true,
          clientTransactionId: "debug-order-1",
          clientPurchaseStatus: "purchased"
        })
      })
    });
    expect(body.purchase).toEqual({
      id: "purchase-debug-credit-pack",
      status: "granted",
      creditsGranted: 2000,
      subscriptionStatus: null,
      entitlementType: null
    });
    expect(body.billing.credits.available).toBe(2100);
    await app.close();
  });

  it("does not grant pending Google Play purchases", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.productCatalog.findUnique.mockResolvedValueOnce({
      sku: "tomeza.one_book_export",
      productType: "ONE_TIME_UNLOCK",
      active: true
    });
    vi.mocked(recordVerifiedGooglePlayPurchase).mockResolvedValueOnce({
      purchaseRecordId: "purchase-pending",
      status: "PENDING",
      creditsGranted: 0,
      ledgerEntryId: null,
      subscriptionStatus: null,
      entitlementType: null
    });
    const verifier = {
      verifyPurchase: vi.fn(async () => ({
        productSku: "tomeza.one_book_export",
        purchaseToken: "pending-token",
        kind: "one_time" as const,
        grantable: false,
        providerStatus: "PENDING",
        quantity: 1
      }))
    };
    const app = await buildMobileApp({ googlePlayVerifier: verifier });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/billing/google-play/verify",
      headers: bearer("token-a"),
      payload: {
        productId: "tomeza.one_book_export",
        purchaseToken: "pending-token",
        purchaseStatus: "purchased"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().purchase).toMatchObject({
      status: "pending",
      creditsGranted: 0
    });
    expect(vi.mocked(recordVerifiedGooglePlayPurchase)).toHaveBeenCalledWith({
      userId: "user-a",
      verification: expect.objectContaining({ grantable: false, providerStatus: "PENDING" })
    });
    await app.close();
  });

});
