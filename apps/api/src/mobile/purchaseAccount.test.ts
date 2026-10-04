import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { recordVerifiedGooglePlayPurchase } from "@book-maker/db/billing";
import { createGooglePlayVerifier } from "../googlePlayBilling.js";
import { googlePlayAccountId } from "../googlePlayAccount.js";
import {
  bearer, buildMobileApp, mockAccessTokens, mockPrisma, resetMobileHarness, teardownMobileHarness
} from "./testing/mobileApiHarness.js";

describe("Play purchase account binding", () => {
  beforeEach(() => {
    resetMobileHarness();
    process.env.MOCK_GOOGLE_PLAY_BILLING = "false";
    mockAccessTokens({ "token-a": "user-a", "token-b": "user-b" });
  });
  afterEach(teardownMobileHarness);

  async function fixture(kind: "CREDIT_PACK" | "SUBSCRIPTION", accountId: string | null) {
    const productId = kind === "CREDIT_PACK" ? "tomeza.credit_pack_1" : "tomeza.creator_monthly";
    mockPrisma.productCatalog.findUnique.mockResolvedValue({ sku: productId, productType: kind, active: true });
    const receipt = kind === "CREDIT_PACK"
      ? { purchaseState: 0, acknowledgementState: 0, obfuscatedExternalAccountId: accountId }
      : {
          subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
          externalAccountIdentifiers: { obfuscatedExternalAccountId: accountId },
          lineItems: [{ productId, expiryTime: "2099-01-01T00:00:00Z" }]
        };
    const verifier = createGooglePlayVerifier({
      accessToken: "test-access-token", packageName: "com.tomeza.tomeza",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(receipt), {
        status: 200, headers: { "Content-Type": "application/json" }
      }))
    });
    const acknowledge = vi.spyOn(verifier, "acknowledgePurchase").mockResolvedValue();
    const app = await buildMobileApp({ googlePlayVerifier: verifier });
    return {
      app, acknowledge,
      verify: (token: string) => app.inject({
        method: "POST", url: "/api/mobile/billing/google-play/verify", headers: bearer(token),
        payload: { productId, purchaseToken: "pending-for-account-a", purchaseStatus: "restored" }
      })
    };
  }

  it("issues a stable opaque checkout identity for each account", async () => {
    const app = await buildMobileApp();
    try {
      const read = (token: string) => app.inject({ method: "GET", url: "/api/mobile/billing", headers: bearer(token) });
      const first = (await read("token-a")).json().billing.purchaseAccountId;
      expect(first).toBe(createHash("sha256").update("tomeza:google-play:user-a").digest("hex"));
      expect((await read("token-a")).json().billing.purchaseAccountId).toBe(first);
      expect((await read("token-b")).json().billing.purchaseAccountId).not.toBe(first);
    } finally { await app.close(); }
  });

  it.each(["CREDIT_PACK", "SUBSCRIPTION"] as const)(
    "rejects another account's %s before granting or acknowledging; the owner can restore",
    async (kind) => {
      const { app, verify, acknowledge } = await fixture(kind, googlePlayAccountId("user-a"));
      try {
        const wrongAccount = await verify("token-b");
        expect(wrongAccount.statusCode).toBe(409);
        expect(wrongAccount.json().error.code).toBe("GOOGLE_PLAY_ACCOUNT_MISMATCH");
        expect(recordVerifiedGooglePlayPurchase).not.toHaveBeenCalled();
        expect(acknowledge).not.toHaveBeenCalled();
        expect((await verify("token-a")).statusCode).toBe(200);
        expect(recordVerifiedGooglePlayPurchase).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-a" }));
        expect(acknowledge).toHaveBeenCalledTimes(1);
      } finally { await app.close(); }
    }
  );

  it.each(["CREDIT_PACK", "SUBSCRIPTION"] as const)("does not assign an unbound, unclaimed %s to the current account", async (kind) => {
    const { app, verify, acknowledge } = await fixture(kind, null);
    try {
      expect((await verify("token-b")).statusCode).toBe(409);
      expect(recordVerifiedGooglePlayPurchase).not.toHaveBeenCalled();
      expect(acknowledge).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("restores an older unbound receipt only for its already recorded owner", async () => {
    mockPrisma.purchaseRecord.findFirst.mockResolvedValue({ userId: "user-a" });
    const { app, verify, acknowledge } = await fixture("CREDIT_PACK", null);
    try {
      expect((await verify("token-b")).statusCode).toBe(409);
      expect(recordVerifiedGooglePlayPurchase).not.toHaveBeenCalled();
      expect(acknowledge).not.toHaveBeenCalled();
      expect((await verify("token-a")).statusCode).toBe(200);
      expect(mockPrisma.purchaseRecord.findFirst).toHaveBeenCalledWith({
        where: { provider: "GOOGLE_PLAY", purchaseTokenHash: createHash("sha256").update("pending-for-account-a").digest("hex") },
        select: { userId: true }
      });
    } finally { await app.close(); }
  });
});
