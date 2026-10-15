import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import {
  consumeAiProcessingUsageTx,
  getImageQuota,
  hasActiveSubscriptionEntitlement,
  isWelcomeCreditGrantPending,
  reserveCredits,
  reserveMessageUsage,
  startVoiceRelayCall
} from "@book-maker/db/billing";
import { DEFAULT_CREDIT_COSTS, resetCreditPricing, setCreditPricing } from "@book-maker/core";
import { enqueueGenerationJob } from "../queue.js";
import { spendBreaker } from "../spendBreaker.js";
import {
  AI_BUSY_MESSAGE,
  AI_DAILY_LIMIT_MESSAGE,
  AI_PAUSED_FREE_MONTH_MESSAGE,
  AI_PAUSED_FREE_TODAY_MESSAGE,
  AI_PAUSED_MESSAGE
} from "./aiCapacity.js";
import { bearer, buildMobileApp, jobRecord, mockAccessTokens, mockPrisma, projectRecord, teardownMobileHarness } from "./testing/mobileApiHarness.js";
import { buildVoiceApp, resetVoiceCallTestState } from "./testing/voiceCallTestUtils.js";

/**
 * Every door that starts AI work asks the spend breaker before it reserves,
 * charges or claims anything (`aiCapacity.ts`, `../spendBreaker.ts`). These
 * drive the real routes against the shared mobile mocks and assert, for each
 * door that refuses, that nothing was spent on the way to the refusal.
 */

const TODAY_RESET = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
};

const NEXT_MONTH_RESET = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
};

/** A subscriber whose books are today's paid spend (`spendBreakdown.ts` reads their plan). */
const SUBSCRIBER = "subscriber-elsewhere";

/**
 * The spend the breaker reads: `freeUsd` today from calls that name no reader
 * (they count as free), `paidUsd` today from a subscriber's books,
 * `monthFreeUsd` from this month's earlier days, and each reader's own.
 */
function spend(options: {
  paused?: boolean;
  freeUsd?: number;
  paidUsd?: number;
  monthFreeUsd?: number;
  userUsd?: Record<string, number>;
}) {
  mockPrisma.aiSpendControlRevision.findFirst.mockResolvedValue(
    options.paused === undefined
      ? null
      : {
          version: 1,
          paused: options.paused,
          softDailyCapUsd: 5,
          hardDailyCapUsd: 12,
          freeMonthlyCapUsd: 150,
          paidHardDailyCapUsd: 60,
          freeUserDailyCapUsd: 1.5,
          paidUserDailyCapUsd: 30,
          note: null,
          updatedBy: "operator-console",
          createdAt: new Date()
        }
  );
  mockPrisma.providerCallLog.aggregate.mockImplementation(async ({ where }: { where: { userId?: string } }) => ({
    _sum: { costHint: where.userId !== undefined ? (options.userUsd?.[where.userId] ?? 0) : 0 }
  }));
  mockPrisma.providerCallLog.groupBy.mockImplementation(async ({ where }: { where: { createdAt: { gte: Date } } }) => {
    const now = new Date();
    const today = where.createdAt.gte.getTime() === Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return today
      ? [
          { userId: null, _sum: { costHint: options.freeUsd ?? 0 } },
          { userId: SUBSCRIBER, _sum: { costHint: options.paidUsd ?? 0 } }
        ]
      : [{ userId: null, _sum: { costHint: options.monthFreeUsd ?? 0 } }];
  });
  mockPrisma.userEntitlement.findMany.mockImplementation(async ({ where }: { where: { userId: { in: string[] } } }) =>
    where.userId.in.filter((userId) => userId === SUBSCRIBER).map((userId) => ({ userId }))
  );
}

function expectNothingSpent() {
  expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
  expect(vi.mocked(reserveMessageUsage)).not.toHaveBeenCalled();
  expect(vi.mocked(consumeAiProcessingUsageTx)).not.toHaveBeenCalled();
  expect(vi.mocked(startVoiceRelayCall)).not.toHaveBeenCalled();
  expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
}

function finishedBookForNarration() {
  mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", status: "COMPLETE", contentRevision: 3 });
  mockPrisma.audiobook.findUnique.mockResolvedValue(null);
  mockPrisma.page.findMany.mockResolvedValue(Array.from({ length: 4 }, () => ({ markdown: "word ".repeat(200) })));
  mockPrisma.audiobook.create.mockResolvedValue({ id: "audiobook-new" });
  vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-audiobook" }));
}

function draftPlan(mediaSettings: Record<string, unknown> = {}) {
  const project = projectRecord({ id: "project-1", status: "PLAN_READY", currentPlanId: "plan-1" });
  mockPrisma.planVersion.findFirst.mockResolvedValue({
    id: "plan-1",
    projectId: "project-1",
    status: "DRAFT",
    inputSnapshot: null,
    project: { ...project, mediaSettings: { ...(project.mediaSettings as Record<string, unknown>), ...mediaSettings } }
  });
}

async function startNarration(app: Awaited<ReturnType<typeof buildMobileApp>>) {
  return app.inject({
    method: "POST",
    url: "/api/mobile/projects/project-1/audiobook",
    headers: bearer("token-a"),
    payload: { voice: "Zephyr" }
  });
}

describe("the AI spend breaker at the doors", () => {
  beforeEach(() => {
    resetVoiceCallTestState();
    mockAccessTokens({ "token-a": "user-a" });
    spendBreaker.reset();
  });
  afterEach(() => {
    resetCreditPricing();
    spendBreaker.reset();
    teardownMobileHarness();
  });

  describe("while AI work is paused", () => {
    beforeEach(() => spend({ paused: true }));

    it("refuses a book start before the slot, the charge or the job", async () => {
      draftPlan();
      const app = await buildMobileApp();

      const response = await app.inject({ method: "POST", url: "/api/mobile/plans/plan-1/approve", headers: bearer("token-a") });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: { code: "AI_PAUSED", message: AI_PAUSED_MESSAGE } });
      expect(vi.mocked(getImageQuota)).not.toHaveBeenCalled();
      expectNothingSpent();
      await app.close();
    });

    it("still answers the replay of a book that was already approved and paid for", async () => {
      draftPlan();
      const approved = await mockPrisma.planVersion.findFirst();
      mockPrisma.planVersion.findFirst.mockResolvedValue({ ...approved, status: "APPROVED" });
      const app = await buildMobileApp();

      const response = await app.inject({ method: "POST", url: "/api/mobile/plans/plan-1/approve", headers: bearer("token-a") });

      expect(response.json().error?.code).not.toBe("AI_PAUSED");
      await app.close();
    });

    it("refuses a book-chat turn before the message is charged, rate limited or written, streaming or not", async () => {
      mockPrisma.project.findFirst.mockResolvedValue(projectRecord({ id: "project-1", status: "COMPLETE" }));
      const app = await buildMobileApp();

      for (const accept of ["application/json", "text/event-stream"]) {
        const response = await app.inject({
          method: "POST",
          url: "/api/mobile/projects/project-1/chat/messages",
          headers: { ...bearer("token-a"), accept },
          payload: { message: "Make the second chapter funnier.", requestId: `turn-${accept}` }
        });
        expect(response.statusCode).toBe(503);
        expect(response.json().error.code).toBe("AI_PAUSED");
      }
      expect(mockPrisma.projectChatMessage.create).not.toHaveBeenCalled();
      expectNothingSpent();
      await app.close();
    });

    it("refuses a library voice call before the minute hold", async () => {
      // A plan perk, so only a subscriber reaches the breaker here.
      vi.mocked(hasActiveSubscriptionEntitlement).mockResolvedValue(true);
      mockPrisma.libraryCharacter.findFirst.mockResolvedValue({
        id: "lib-1",
        userId: "user-a",
        name: "Mina",
        description: "Brave.",
        fields: [],
        appearance: null,
        outgoingMentions: []
      });
      const app = await buildVoiceApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/voice/characters/lib-1/calls",
        headers: bearer("token-a"),
        payload: { transport: "relay-v1" }
      });

      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("AI_PAUSED");
      expectNothingSpent();
      await app.close();
    });

    it("refuses a narration before the charge", async () => {
      vi.mocked(hasActiveSubscriptionEntitlement).mockResolvedValue(true);
      finishedBookForNarration();
      const app = await buildMobileApp();

      const response = await startNarration(app);

      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("AI_PAUSED");
      expectNothingSpent();
      await app.close();
    });

    it("refuses a creation-chat message before the message is charged", async () => {
      const app = await buildMobileApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/creation-sessions",
        headers: bearer("token-a"),
        payload: { message: "A picture book about a fox who is afraid of the dark", requestId: "creation-start-request-0001" }
      });

      expect(response.statusCode).toBe(503);
      expect(mockPrisma.mobileCreationDraft.create).not.toHaveBeenCalled();
      expectNothingSpent();
      await app.close();
    });
  });

  describe("past the soft cap", () => {
    beforeEach(() => spend({ freeUsd: 6 }));

    it("holds a free account's ultra book, and lets a balanced book through", async () => {
      // Ultra is off by default at launch; the breaker's rule is about an
      // operator who has switched it on.
      setCreditPricing({ ...DEFAULT_CREDIT_COSTS, ultraTierEnabled: 1 });
      const app = await buildMobileApp();

      draftPlan({ modelTier: "ultra" });
      const ultra = await app.inject({ method: "POST", url: "/api/mobile/plans/plan-1/approve", headers: bearer("token-a") });
      expect(ultra.statusCode).toBe(503);
      expect(ultra.json()).toEqual({ error: { code: "AI_BUSY", message: AI_BUSY_MESSAGE, resetsAt: TODAY_RESET() } });
      expectNothingSpent();

      draftPlan({ modelTier: "balanced" });
      const balanced = await app.inject({ method: "POST", url: "/api/mobile/plans/plan-1/approve", headers: bearer("token-a") });
      expect(balanced.json().error?.code).not.toBe("AI_BUSY");
      await app.close();
    });

    it("leaves a paying account's narration alone", async () => {
      vi.mocked(hasActiveSubscriptionEntitlement).mockResolvedValue(true);
      finishedBookForNarration();
      const app = await buildMobileApp();

      const response = await startNarration(app);

      expect(response.statusCode).toBe(202);
      expect(vi.mocked(reserveCredits)).toHaveBeenCalled();
      await app.close();
    });

    it("tells a free account narration is a plan perk, never that Tomeza is busy, and names only Ultra as busy", async () => {
      vi.mocked(hasActiveSubscriptionEntitlement).mockResolvedValue(false);
      finishedBookForNarration();
      const app = await buildMobileApp();

      const response = await startNarration(app);

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("SUBSCRIPTION_REQUIRED");
      expectNothingSpent();
      // The busy sentence speaks only of what a free account can still meet it on.
      expect(AI_BUSY_MESSAGE).toContain("Ultra");
      expect(AI_BUSY_MESSAGE).not.toMatch(/voice|audiobook/i);
      await app.close();
    });

    it("tells the app a free account's welcome credits are on their way, and holds the grant", async () => {
      vi.mocked(isWelcomeCreditGrantPending).mockResolvedValue(true);
      const app = await buildMobileApp();

      const response = await app.inject({ method: "GET", url: "/api/mobile/billing", headers: bearer("token-a") });

      expect(response.statusCode).toBe(200);
      expect(response.json().billing.welcomeCreditsPending).toBe(true);
      // The payload brought the breaker's view of today up to date before it
      // read the balance, so the hold the server installs is in force.
      expect(spendBreaker.holdsWelcomeGrants()).toBe(true);
      await app.close();
    });
  });

  describe("past the free hard cap", () => {
    beforeEach(() => spend({ freeUsd: 13 }));

    it("refuses a free account's book start until 00:00 UTC, saying paid plans are not affected", async () => {
      draftPlan();
      const app = await buildMobileApp();

      const response = await app.inject({ method: "POST", url: "/api/mobile/plans/plan-1/approve", headers: bearer("token-a") });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: { code: "AI_PAUSED", message: AI_PAUSED_FREE_TODAY_MESSAGE, resetsAt: TODAY_RESET() }
      });
      expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
      expect(vi.mocked(getImageQuota)).not.toHaveBeenCalled();
      expectNothingSpent();
      await app.close();
    });

    it("leaves a paying account's narration alone", async () => {
      vi.mocked(hasActiveSubscriptionEntitlement).mockResolvedValue(true);
      finishedBookForNarration();
      const app = await buildMobileApp();

      const response = await startNarration(app);

      expect(response.statusCode).toBe(202);
      expect(vi.mocked(reserveCredits)).toHaveBeenCalled();
      await app.close();
    });
  });

  it("past the monthly ceiling refuses a free account until the month turns, on a quiet day", async () => {
    spend({ freeUsd: 1, monthFreeUsd: 149 });
    draftPlan();
    const app = await buildMobileApp();

    const response = await app.inject({ method: "POST", url: "/api/mobile/plans/plan-1/approve", headers: bearer("token-a") });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: { code: "AI_PAUSED", message: AI_PAUSED_FREE_MONTH_MESSAGE, resetsAt: NEXT_MONTH_RESET() }
    });
    expect(spendBreaker.holdsWelcomeGrants()).toBe(true);
    expectNothingSpent();
    await app.close();
  });

  describe("past the paid cap", () => {
    beforeEach(() => spend({ paidUsd: 60 }));

    it("refuses a paying account's narration with the pause sentence", async () => {
      vi.mocked(hasActiveSubscriptionEntitlement).mockResolvedValue(true);
      finishedBookForNarration();
      const app = await buildMobileApp();

      const response = await startNarration(app);

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: { code: "AI_PAUSED", message: AI_PAUSED_MESSAGE } });
      expectNothingSpent();
      await app.close();
    });

    it("lets a free account's book through and holds no welcome grant", async () => {
      draftPlan();
      const app = await buildMobileApp();

      const response = await app.inject({ method: "POST", url: "/api/mobile/plans/plan-1/approve", headers: bearer("token-a") });

      expect(response.json().error?.code).not.toBe("AI_PAUSED");
      expect(spendBreaker.holdsWelcomeGrants()).toBe(false);
      await app.close();
    });
  });

  it("caps a reader's own day with a 429 that says when it resets", async () => {
    // Narration is a plan perk, so this is a subscriber past a subscriber's cap.
    spend({ userUsd: { "user-a": 31 } });
    vi.mocked(hasActiveSubscriptionEntitlement).mockResolvedValue(true);
    finishedBookForNarration();
    const app = await buildMobileApp();

    const response = await startNarration(app);

    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({ error: { code: "AI_DAILY_LIMIT", message: AI_DAILY_LIMIT_MESSAGE, resetsAt: TODAY_RESET() } });
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
    expectNothingSpent();
    await app.close();
  });

  it("keeps the reset time on a route that declares its 429", async () => {
    spend({ userUsd: { "user-a": 1.6 } });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/characters/lib-1/portrait",
      headers: bearer("token-a"),
      payload: { requestId: "portrait-request-1" }
    });

    expect(response.statusCode).toBe(429);
    expect(response.json().error).toMatchObject({ code: "AI_DAILY_LIMIT", resetsAt: TODAY_RESET() });
    expectNothingSpent();
    await app.close();
  });

  it("lets everything through on a normal day", async () => {
    spend({});
    vi.mocked(hasActiveSubscriptionEntitlement).mockResolvedValue(true);
    finishedBookForNarration();
    const app = await buildMobileApp();

    const response = await startNarration(app);

    expect(response.statusCode).toBe(202);
    expect(vi.mocked(reserveCredits)).toHaveBeenCalled();
    await app.close();
  });
});
