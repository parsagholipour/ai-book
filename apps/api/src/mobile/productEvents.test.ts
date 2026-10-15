import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import {
  bearer,
  buildMobileApp,
  mockAccessTokens,
  mockPrisma,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

describe("app-reported product events", () => {
  beforeEach(() => {
    resetMobileHarness();
    mockAccessTokens({ "token-a": "user-a" });
  });

  afterEach(() => {
    teardownMobileHarness();
  });

  it("records a paywall view and what opened it", async () => {
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/events",
      headers: bearer("token-a"),
      payload: { name: "paywall_viewed", trigger: "page_limit" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(mockPrisma.productEvent.create).toHaveBeenCalledWith({
      data: { userId: "user-a", name: "paywall_viewed", properties: { trigger: "page_limit" } }
    });
    await app.close();
  });

  it("refuses a name or trigger outside the closed list", async () => {
    const app = await buildMobileApp();
    for (const payload of [
      { name: "anything", trigger: "page_limit" },
      { name: "paywall_viewed", trigger: "<script>" },
      { name: "paywall_viewed" }
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/mobile/events", headers: bearer("token-a"), payload });
      expect(response.statusCode).toBe(400);
    }
    expect(mockPrisma.productEvent.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("records a checkout started, cancelled and failed with only closed-list fields", async () => {
    const app = await buildMobileApp();
    for (const payload of [
      { name: "purchase_started", sku: "tomeza.creator_monthly", intro: true, surface: "export" },
      { name: "purchase_started", sku: "tomeza.credit_pack_1", intro: false },
      { name: "purchase_cancelled", sku: "tomeza.creator_monthly" },
      { name: "purchase_failed", sku: "tomeza.pro_monthly", reason: "play_error" }
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/mobile/events", headers: bearer("token-a"), payload });
      expect(response.statusCode).toBe(200);
    }
    expect(mockPrisma.productEvent.create.mock.calls.map(([call]) => call.data)).toEqual([
      {
        userId: "user-a",
        name: "purchase_started",
        properties: { sku: "tomeza.creator_monthly", intro: "true", surface: "export" }
      },
      { userId: "user-a", name: "purchase_started", properties: { sku: "tomeza.credit_pack_1", intro: "false", surface: "other" } },
      { userId: "user-a", name: "purchase_cancelled", properties: { sku: "tomeza.creator_monthly" } },
      { userId: "user-a", name: "purchase_failed", properties: { sku: "tomeza.pro_monthly", reason: "play_error" } }
    ]);
    await app.close();
  });

  it("records an install's referrer fields and the share it came from", async () => {
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/events",
      headers: bearer("token-a"),
      payload: { name: "install_attributed", source: "share", shareSlug: "AbC123xyz789" }
    });
    expect(response.statusCode).toBe(200);
    expect(mockPrisma.productEvent.create).toHaveBeenCalledWith({
      data: { userId: "user-a", name: "install_attributed", properties: { source: "share", medium: "none", shareSlug: "AbC123xyz789" } }
    });
    await app.close();
  });

  it("refuses free text, a missing field and a malformed slug", async () => {
    const app = await buildMobileApp();
    for (const payload of [
      { name: "purchase_started", sku: "tomeza.creator_monthly" },
      { name: "purchase_started", sku: "Buy Me Now!", intro: false },
      { name: "purchase_failed", sku: "tomeza.pro_monthly", reason: "card declined by bank" },
      { name: "purchase_cancelled" },
      { name: "install_attributed", source: "Spring Sale <b>" },
      { name: "install_attributed", medium: "organic" },
      { name: "install_attributed", source: "share", shareSlug: "../../etc" }
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/mobile/events", headers: bearer("token-a"), payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(mockPrisma.productEvent.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("never stores a field the event does not name, such as the raw referrer", async () => {
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/events",
      headers: bearer("token-a"),
      payload: { name: "install_attributed", source: "google-play", medium: "organic", referrer: "utm_source=google-play&gclid=abc" }
    });
    expect(response.statusCode).toBe(200);
    expect(mockPrisma.productEvent.create).toHaveBeenCalledWith({
      data: { userId: "user-a", name: "install_attributed", properties: { source: "google-play", medium: "organic" } }
    });
    await app.close();
  });

  it("answers ok even when the row could not be written", async () => {
    mockPrisma.productEvent.create.mockRejectedValueOnce(new Error("db down"));
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/events",
      headers: bearer("token-a"),
      payload: { name: "paywall_viewed", trigger: "credits_needed" }
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("needs a signed-in reader", async () => {
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/events",
      payload: { name: "paywall_viewed", trigger: "credits_needed" }
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
