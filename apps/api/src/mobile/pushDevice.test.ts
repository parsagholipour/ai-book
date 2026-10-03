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

/** `PUT` / `DELETE /api/mobile/push-device` (`routes/pushDevice.ts`). */

const AUTH = bearer("token-a");
const TOKEN = "fcm-token:APA91b-example";

describe("mobile push device routes", () => {
  beforeEach(() => {
    resetMobileHarness();
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.pushDevice.upsert.mockResolvedValue({});
    mockPrisma.pushDevice.deleteMany.mockResolvedValue({ count: 1 });
  });
  afterEach(teardownMobileHarness);

  it("files the token under the caller's session, taking it from whoever held it", async () => {
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/mobile/push-device",
      headers: AUTH,
      payload: { token: ` ${TOKEN} `, platform: "android" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(mockPrisma.pushDevice.upsert).toHaveBeenCalledWith({
      where: { token: TOKEN },
      create: { token: TOKEN, platform: "ANDROID", userId: "user-a", sessionId: "session-user-a" },
      update: { platform: "ANDROID", userId: "user-a", sessionId: "session-user-a" }
    });
    await app.close();
  });

  it("refuses a platform it cannot send to and a missing token", async () => {
    const app = await buildMobileApp();
    for (const payload of [{ token: TOKEN, platform: "web" }, { platform: "android" }, { token: "  ", platform: "ios" }]) {
      const response = await app.inject({ method: "PUT", url: "/api/mobile/push-device", headers: AUTH, payload });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_ERROR");
    }
    expect(mockPrisma.pushDevice.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("needs a signed-in caller", async () => {
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/mobile/push-device",
      payload: { token: TOKEN, platform: "android" }
    });
    expect(response.statusCode).toBe(401);
    expect(mockPrisma.pushDevice.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("withdraws only the caller's own copy of a token, and answers the same when there was none", async () => {
    mockPrisma.pushDevice.deleteMany.mockResolvedValue({ count: 0 });
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "DELETE",
      url: "/api/mobile/push-device",
      headers: AUTH,
      payload: { token: TOKEN }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(mockPrisma.pushDevice.deleteMany).toHaveBeenCalledWith({ where: { token: TOKEN, userId: "user-a" } });
    await app.close();
  });
});
