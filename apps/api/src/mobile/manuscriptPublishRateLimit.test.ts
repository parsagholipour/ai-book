import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());
vi.mock("./manuscript/manuscriptPublish.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./manuscript/manuscriptPublish.js")>()),
  publishManuscript: vi.fn(async () => undefined),
  publishChecklist: vi.fn(async () => [])
}));
vi.mock("./routes/manuscriptRouteSupport.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./routes/manuscriptRouteSupport.js")>()),
  authorProjectOrReply: vi.fn(async () => ({ id: "project-1" })),
  projectSummaryDto: vi.fn(async () => ({ id: "project-1" })),
  manuscriptDto: vi.fn(async () => ({ projectId: "project-1" }))
}));

import { publishManuscript } from "./manuscript/manuscriptPublish.js";
import { STUDIO_PUBLISH_RATE_LIMIT } from "./routes/manuscript.js";
import { bearer, buildMobileApp, mockAccessTokens, resetMobileHarness, teardownMobileHarness } from "./testing/mobileApiHarness.js";

describe("POST /api/mobile/projects/:id/manuscript/publish rate limit", () => {
  beforeEach(() => {
    resetMobileHarness();
    mockAccessTokens({ "token-a": "user-a", "token-b": "user-b" });
  });
  afterEach(teardownMobileHarness);

  it("refuses an account's publishes past the hourly limit with RATE_LIMITED, and counts no dry run", async () => {
    const app = await buildMobileApp();
    const publish = (token: string, index: number, dryRun = false) =>
      app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/manuscript/publish",
        headers: bearer(token),
        payload: { requestId: `publish-request-${index}`, ...(dryRun ? { dryRun: true } : {}) }
      });

    for (let index = 0; index < 5; index += 1) {
      expect((await publish("token-a", 100 + index, true)).statusCode).toBe(200);
    }
    for (let index = 0; index < STUDIO_PUBLISH_RATE_LIMIT.maxAttempts; index += 1) {
      expect((await publish("token-a", index)).statusCode).toBe(200);
    }

    const refused = await publish("token-a", 999);
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe("RATE_LIMITED");
    expect(refused.headers["retry-after"]).toBeDefined();
    expect(vi.mocked(publishManuscript)).toHaveBeenCalledTimes(STUDIO_PUBLISH_RATE_LIMIT.maxAttempts);
    // Another account has its own bucket.
    expect((await publish("token-b", 0)).statusCode).toBe(200);
    await app.close();
  });
});
