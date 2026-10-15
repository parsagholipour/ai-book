import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import {
  describePendingWelcomeGrant,
  endSubscriptionNow,
  getCreditBalance,
  getWelcomeCreditsGranted,
  isWelcomeCreditGrantPending,
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

  it.each([0, 500, 2000])("reports the actual welcome grant of %s credits", async (amount) => {
    mockAccessTokens({ "token-a": "user-a" });
    vi.mocked(getWelcomeCreditsGranted).mockResolvedValue(amount);
    const app = await buildMobileApp();
    const response = await app.inject({ method: "GET", url: "/api/mobile/billing", headers: bearer("token-a") });
    expect(response.statusCode).toBe(200);
    expect(response.json().billing.freeTier.welcomeCredits).toBe(amount);
    expect(getWelcomeCreditsGranted).toHaveBeenCalledWith("user-a");
    await app.close();
  });

  it("says why a pending welcome grant waits and what it would pay, and nothing when none is pending", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    vi.mocked(isWelcomeCreditGrantPending).mockResolvedValue(true);
    vi.mocked(describePendingWelcomeGrant).mockResolvedValue({ reason: "email_unverified", credits: 1150 });
    const app = await buildMobileApp();
    const pending = (await app.inject({ method: "GET", url: "/api/mobile/billing", headers: bearer("token-a") })).json();
    expect(pending.billing).toMatchObject({
      welcomeCreditsPending: true,
      welcomeCreditsPendingReason: "email_unverified",
      welcomeCreditsPendingCredits: 1150
    });

    vi.mocked(isWelcomeCreditGrantPending).mockResolvedValue(false);
    vi.mocked(describePendingWelcomeGrant).mockClear();
    const settled = (await app.inject({ method: "GET", url: "/api/mobile/billing", headers: bearer("token-a") })).json();
    expect(settled.billing).toMatchObject({
      welcomeCreditsPending: false,
      welcomeCreditsPendingReason: null,
      welcomeCreditsPendingCredits: null
    });
    expect(describePendingWelcomeGrant).not.toHaveBeenCalled();
    await app.close();
  });

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
    // An unlock bought before 2026-10-15 is still listed; nothing writes a new one.
    expect(body.billing.entitlements).toEqual([
      expect.objectContaining({
        type: "EXPORT_UNLOCK",
        projectId: "project-1",
        creditsCost: 150
      })
    ]);
    // Installed apps add this key to every book quote and fall back to 150
    // when it is missing, so it ships, at 0, now that downloads are free.
    expect(body.billing.creditCosts.exportUnlock).toBe(0);
    const skus = body.billing.products.map((product: { sku: string }) => product.sku);
    expect(skus).toContain("tomeza.credit_pack_1");
    // Retired: the same 1,000 credits as credit_pack_1, at a higher price.
    expect(skus).not.toContain("tomeza.one_book_export");
    expect(JSON.stringify(body.billing)).not.toMatch(/provider|model|temperature|generationStrategy/);
    await app.close();
  });

  it("reports zero free monthly credits and the free tier's image cap", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    vi.mocked(getCreditBalance).mockResolvedValue(
      creditBalance({
        availableCredits: 500,
        purchasedCredits: 500,
        planCredits: 0,
        planCreditsPerPeriod: 0,
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
      cancelAtPeriodEnd: false,
      endsAt: null,
      // Nothing to cancel on free, even though this backend runs the mock verifier.
      canCancelInApp: false,
      productSku: null,
      purchaseTokenHash: null
    });
    expect(body.billing.allowance).toEqual({
      monthlyCredits: 0,
      planCredits: 0,
      resetsAt: "2026-07-01T00:00:00.000Z"
    });
    // Only the one-time welcome gift; the image cap does not fund generation.
    expect(body.billing.freeTier).toEqual({
      monthlyCredits: 0,
      welcomeCredits: 1000,
      illustratedBooksPerMonth: 3,
      maxBookPages: 30
    });
    // The reader's own cap: a free reader is held to the free tier's length.
    expect(body.billing.maxBookPages).toBe(30);
    // The two operator switches the app draws its pickers from: no book past
    // 200 pages for anyone yet, and Ultra off at launch.
    expect(body.billing.paidMaxBookPages).toBe(200);
    expect(body.billing.ultraTierEnabled).toBe(false);
    expect(body.billing.imageQuota).toEqual({ used: 2, limit: 3, resetsAt: "2026-07-01T00:00:00.000Z" });
    expect(body.billing.credits).toMatchObject({ available: 500, purchased: 500 });

    const subscriptions = body.billing.products.filter(
      (product: { productType: string }) => product.productType === "SUBSCRIPTION"
    );
    expect(subscriptions.map((product: { sku: string }) => product.sku)).toEqual([
      "tomeza.creator_monthly",
      "tomeza.creator_yearly",
      "tomeza.pro_monthly",
      "tomeza.max_monthly"
    ]);
    const monthly = subscriptions.filter((product: { billingPeriod: string }) => product.billingPeriod === "P1M");
    expect(monthly).toHaveLength(3);
    // Credits per dollar has to climb with the tier or the ladder makes no sense.
    const perDollar = monthly.map(
      (product: { creditAmount: number; priceMicros: number }) => product.creditAmount / (product.priceMicros / 1_000_000)
    );
    expect(perDollar[1]).toBeGreaterThan(perDollar[0]);
    expect(perDollar[2]).toBeGreaterThan(perDollar[1]);
    // The yearly plan saves on Creator but never prices a credit under the Max
    // plan's net rate, which every per-page price is floored at.
    const yearly = subscriptions.find((product: { sku: string }) => product.sku === "tomeza.creator_yearly");
    // Granted a month at a time: 6,000 every month, billed yearly (launch review 2026-10-15).
    expect(yearly).toMatchObject({ billingPeriod: "P1Y", creditAmount: 72_000, monthlyCreditAmount: 6_000 });
    expect(yearly.description).toMatch(/^6,000 credits every month, billed yearly/);
    expect(monthly.map((product: { monthlyCreditAmount: number }) => product.monthlyCreditAmount)).toEqual([6_000, 15_000, 80_000]);
    expect(body.billing.products.find((product: { sku: string }) => product.sku === "tomeza.credit_pack_1"))
      .toMatchObject({ monthlyCreditAmount: null });
    const netPerCredit = (product: { priceMicros: number; creditAmount: number }) =>
      (product.priceMicros / 1_000_000) * 0.85 / product.creditAmount;
    const max = subscriptions.find((product: { sku: string }) => product.sku === "tomeza.max_monthly");
    expect(netPerCredit(yearly)).toBeGreaterThanOrEqual(netPerCredit(max) - 1e-6);
    expect(netPerCredit(yearly)).toBeLessThan(netPerCredit(monthly[0]));
    // Max stays in the catalog, so a restore still finds it, but a free reader
    // is not shown a $199.99 plan beside a $19.99 one.
    const offered = (billing: { products: Array<{ sku: string; offered: boolean }> }) =>
      Object.fromEntries(billing.products.map((product) => [product.sku, product.offered]));
    expect(offered(body.billing)).toMatchObject({
      "tomeza.creator_monthly": true,
      "tomeza.creator_yearly": true,
      "tomeza.pro_monthly": true,
      "tomeza.max_monthly": false,
      "tomeza.credit_pack_1": true
    });
    // The app buys Creator monthly through its intro offer whenever Play lists
    // it for the account; nothing else names one.
    const introOffers = Object.fromEntries(
      body.billing.products.map((product: { sku: string; introOfferId: string | null }) => [product.sku, product.introOfferId])
    );
    expect(introOffers).toMatchObject({
      "tomeza.creator_monthly": "creator-intro-first-month",
      "tomeza.creator_yearly": null,
      "tomeza.pro_monthly": null,
      "tomeza.credit_pack_1": null
    });

    // Same app, same route: on a paid plan the image limit goes away entirely.
    vi.mocked(getCreditBalance).mockResolvedValue(creditBalance({ availableCredits: 15_000 }));
    vi.mocked(getImageQuota).mockResolvedValue(null);
    vi.mocked(getPlanSummary).mockResolvedValue({
      tier: "pro",
      source: "google_play",
      status: "ACTIVE",
      renewsAt: new Date("2026-07-15T00:00:00.000Z"),
      cancelAtPeriodEnd: false,
      endsAt: null,
      productSku: "tomeza.pro_monthly",
      purchaseTokenHash: "test-plan-token-hash"
    });
    const paid = (
      await app.inject({ method: "GET", url: "/api/mobile/billing", headers: bearer("token-a") })
    ).json();

    expect(paid.billing.imageQuota).toBeNull();
    expect(paid.billing.plan.purchaseTokenHash).toBe("test-plan-token-hash");
    expect(paid.billing.plan).toMatchObject({ tier: "pro", renewsAt: "2026-07-15T00:00:00.000Z", endsAt: null });
    // The limit still ships on a paid plan — the paywall's free rung describes
    // what cancelling would drop you to.
    expect(paid.billing.freeTier).toEqual({
      monthlyCredits: 0,
      welcomeCredits: 1000,
      illustratedBooksPerMonth: 3,
      maxBookPages: 30
    });
    // …while the reader's own length cap is lifted, to the ceiling every plan shares.
    expect(paid.billing.maxBookPages).toBeNull();
    expect(paid.billing.paidMaxBookPages).toBe(200);
    // A Pro reader can outgrow 15,000 credits, so Max is offered as the step up.
    expect(offered(paid.billing)["tomeza.max_monthly"]).toBe(true);
    await app.close();
  });

  it("says when a cancelled plan ends instead of when it renews", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    vi.mocked(getCreditBalance).mockResolvedValue(creditBalance({ availableCredits: 6000 }));
    vi.mocked(listActiveUserEntitlements).mockResolvedValue([]);
    vi.mocked(getPlanSummary).mockResolvedValue({
      tier: "creator",
      source: "google_play",
      status: "CANCELED",
      renewsAt: null,
      cancelAtPeriodEnd: true,
      endsAt: new Date("2026-09-12T00:00:00.000Z"),
      productSku: "tomeza.creator_monthly",
      purchaseTokenHash: "test-plan-token-hash"
    });
    const app = await buildMobileApp();

    const body = (
      await app.inject({ method: "GET", url: "/api/mobile/billing", headers: bearer("token-a") })
    ).json();

    expect(body.billing.plan).toMatchObject({
      tier: "creator",
      renewsAt: null,
      cancelAtPeriodEnd: true,
      endsAt: "2026-09-12T00:00:00.000Z"
    });
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
    // Checkout may compare the token's hash; raw Play credentials never ship.
    expect(JSON.stringify(body)).not.toMatch(/provider|model|temperature|generationStrategy|"purchaseToken"/);
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

  it("records a pending purchase whose order id Play sent blank, instead of refusing it", async () => {
    // in_app_purchase_android maps a missing orderId to "": a slow card still
    // pending, a promo code. A 400 here left the payment unacknowledged and
    // Play refunded it three days later.
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.productCatalog.findUnique.mockResolvedValue({ sku: "tomeza.credit_pack_1", productType: "CREDIT_PACK", active: true });
    vi.mocked(recordVerifiedGooglePlayPurchase).mockResolvedValue({
      purchaseRecordId: "purchase-pending", status: "PENDING", creditsGranted: 0, ledgerEntryId: null,
      subscriptionStatus: null, entitlementType: null
    });
    const verifier = {
      verifyPurchase: vi.fn(async () => ({
        productSku: "tomeza.credit_pack_1", purchaseToken: "pending-token", kind: "one_time" as const,
        grantable: false, providerStatus: "PENDING", quantity: 1
      }))
    };
    const app = await buildMobileApp({ googlePlayVerifier: verifier });

    for (const transactionId of ["", "   "]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/billing/google-play/verify",
        headers: bearer("token-a"),
        payload: { productId: "tomeza.credit_pack_1", purchaseToken: "pending-token", transactionId }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().purchase).toMatchObject({ status: "pending" });
    }
    expect(vi.mocked(recordVerifiedGooglePlayPurchase)).toHaveBeenLastCalledWith({
      userId: "user-a",
      verification: expect.objectContaining({ metadata: expect.objectContaining({ clientTransactionId: null }) })
    });
    await app.close();
  });

  it("passes the buyer's own price to the record for analytics, and refuses half of one", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.productCatalog.findUnique.mockResolvedValue({ sku: "tomeza.credit_pack_1", productType: "CREDIT_PACK", active: true });
    vi.mocked(recordVerifiedGooglePlayPurchase).mockResolvedValue({
      purchaseRecordId: "purchase-pack", status: "GRANTED", creditsGranted: 1000, ledgerEntryId: "ledger-pack",
      subscriptionStatus: null, entitlementType: null
    });
    const verifier = {
      verifyPurchase: vi.fn(async () => ({
        productSku: "tomeza.credit_pack_1", purchaseToken: "google-token-1", kind: "one_time" as const,
        grantable: true, providerStatus: "PURCHASED", externalPurchaseId: "GPA.1", quantity: 1
      }))
    };
    const app = await buildMobileApp({ googlePlayVerifier: verifier });
    const send = (extra: Record<string, unknown>) => app.inject({
      method: "POST",
      url: "/api/mobile/billing/google-play/verify",
      headers: bearer("token-a"),
      payload: { productId: "tomeza.credit_pack_1", purchaseToken: "google-token-1", ...extra }
    });

    expect((await send({ localPriceMicros: 749_000_000, localCurrency: "INR" })).statusCode).toBe(200);
    expect(vi.mocked(recordVerifiedGooglePlayPurchase)).toHaveBeenLastCalledWith(expect.objectContaining({
      clientPrice: { micros: 749_000_000, currency: "INR" }
    }));
    // An old build sends neither, and is recorded exactly as before.
    expect((await send({})).statusCode).toBe(200);
    expect(vi.mocked(recordVerifiedGooglePlayPurchase).mock.lastCall?.[0]).not.toHaveProperty("clientPrice");

    for (const invalid of [
      { localPriceMicros: 749_000_000 },
      { localCurrency: "INR" },
      { localPriceMicros: 749_000_000, localCurrency: "inr" },
      { localPriceMicros: -1, localCurrency: "INR" },
      { localPriceMicros: 1.5, localCurrency: "INR" }
    ]) {
      const response = await send(invalid);
      expect(response.statusCode, JSON.stringify(invalid)).toBe(400);
    }
    await app.close();
  });

  it("tells the app a downgrade starts at renewal, and acknowledges it under the plan it replaces", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.productCatalog.findUnique.mockResolvedValueOnce({ sku: "tomeza.creator_monthly", productType: "SUBSCRIPTION", active: true });
    vi.mocked(recordVerifiedGooglePlayPurchase).mockResolvedValueOnce({
      purchaseRecordId: "purchase-switch", status: "VERIFIED", creditsGranted: 0, ledgerEntryId: null,
      subscriptionStatus: "ACTIVE", entitlementType: null,
      scheduledChange: { productSku: "tomeza.creator_monthly", startsAt: new Date("2026-11-04T00:00:00Z") }
    });
    const verifier = {
      verifyPurchase: vi.fn(async () => ({
        productSku: "tomeza.creator_monthly", purchaseToken: "creator-token", kind: "subscription" as const,
        grantable: true, providerStatus: "SUBSCRIPTION_STATE_ACTIVE", externalPurchaseId: null,
        subscription: { status: "ACTIVE" as const, deferredReplacement: {
          fromProductSku: "tomeza.max_monthly", takesEffectAt: new Date("2026-11-04T00:00:00Z") } },
        metadata: { acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING" }
      })),
      acknowledgePurchase: vi.fn(async () => {})
    };
    const app = await buildMobileApp({ googlePlayVerifier: verifier });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/billing/google-play/verify",
      headers: bearer("token-a"),
      payload: { productId: "tomeza.creator_monthly", purchaseToken: "creator-token", purchaseStatus: "purchased" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().purchase).toMatchObject({
      status: "verified", creditsGranted: 0,
      scheduledChange: { productSku: "tomeza.creator_monthly", startsAt: "2026-11-04T00:00:00.000Z" }
    });
    expect(verifier.acknowledgePurchase).toHaveBeenCalledWith(expect.objectContaining({ productId: "tomeza.max_monthly" }));
    await app.close();
  });

  it("re-verifies the stored subscription token so a cancellation shows up at once", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.subscriptionState.findFirst.mockResolvedValueOnce({
      purchaseToken: "google-sub-token",
      product: { sku: "tomeza.creator_monthly", productType: "SUBSCRIPTION" }
    });
    vi.mocked(getCreditBalance).mockResolvedValue(creditBalance({ availableCredits: 6000 }));
    vi.mocked(listActiveUserEntitlements).mockResolvedValue([]);
    vi.mocked(getPlanSummary).mockResolvedValue({
      tier: "creator",
      source: "google_play",
      status: "CANCELED",
      renewsAt: null,
      cancelAtPeriodEnd: true,
      endsAt: new Date("2026-09-12T00:00:00.000Z"),
      productSku: "tomeza.creator_monthly",
      purchaseTokenHash: "test-plan-token-hash"
    });
    const verifier = {
      verifyPurchase: vi.fn(async () => ({
        productSku: "tomeza.creator_monthly",
        purchaseToken: "google-sub-token",
        kind: "subscription" as const,
        grantable: true,
        providerStatus: "SUBSCRIPTION_STATE_CANCELED",
        subscription: {
          status: "CANCELED" as const,
          currentPeriodEnd: new Date("2026-09-12T00:00:00.000Z"),
          autoRenewing: false
        }
      }))
    };
    const app = await buildMobileApp({ googlePlayVerifier: verifier });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/billing/subscription/refresh",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    expect(verifier.verifyPurchase).toHaveBeenCalledWith({
      packageName: "",
      productId: "tomeza.creator_monthly",
      productType: "SUBSCRIPTION",
      purchaseToken: "google-sub-token"
    });
    expect(response.json().billing.plan).toMatchObject({ cancelAtPeriodEnd: true, endsAt: "2026-09-12T00:00:00.000Z" });
    expect(JSON.stringify(response.json())).not.toMatch(/google-sub-token/);
    // The held plan is looked for first, so a pending checkout recorded with no
    // period end (sorted first by Postgres in a descending order) is not refreshed instead.
    expect(mockPrisma.subscriptionState.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ["ACTIVE", "GRACE_PERIOD", "CANCELED", "PAUSED"] } }),
        orderBy: { currentPeriodEnd: { sort: "desc", nulls: "last" } }
      })
    );
    await app.close();
  });

  it("refuses to refresh when no subscription token is stored", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.subscriptionState.findFirst.mockResolvedValueOnce(null);
    const verifier = { verifyPurchase: vi.fn() };
    const app = await buildMobileApp({ googlePlayVerifier: verifier });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/billing/subscription/refresh",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("NO_ACTIVE_SUBSCRIPTION");
    expect(verifier.verifyPurchase).not.toHaveBeenCalled();
    await app.close();
  });

  it("ends the subscription in place when the backend runs the mock Play verifier", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    vi.mocked(getCreditBalance).mockResolvedValue(creditBalance({ availableCredits: 1000, planCredits: 1000 }));
    vi.mocked(listActiveUserEntitlements).mockResolvedValue([]);
    vi.mocked(getImageQuota).mockResolvedValue({
      used: 0,
      limit: 3,
      periodKey: "2026-06",
      resetsAt: new Date("2026-07-01T00:00:00.000Z")
    });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/billing/subscription/cancel",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    expect(vi.mocked(endSubscriptionNow)).toHaveBeenCalledWith("user-a");
    // Back on free: the plan says so and the illustrated-book budget is back.
    expect(response.json().billing.plan).toMatchObject({ tier: "free", canCancelInApp: false });
    expect(response.json().billing.imageQuota).toMatchObject({ limit: 3 });
    await app.close();
  });

  it("sends real Google Play subscribers to Play to cancel", async () => {
    process.env.MOCK_GOOGLE_PLAY_BILLING = "false";
    mockAccessTokens({ "token-a": "user-a" });
    const app = await buildMobileApp({ googlePlayVerifier: { verifyPurchase: vi.fn() } });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/billing/subscription/cancel",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("CANCEL_IN_PLAY");
    expect(vi.mocked(endSubscriptionNow)).not.toHaveBeenCalled();
    delete process.env.MOCK_GOOGLE_PLAY_BILLING;
    await app.close();
  });

  it("reports nothing to cancel rather than pretending it worked", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    vi.mocked(endSubscriptionNow).mockResolvedValueOnce({ ended: false, endedSubscriptionIds: [] });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/billing/subscription/cancel",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("NO_ACTIVE_SUBSCRIPTION");
    await app.close();
  });
});
