import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { InsufficientCreditsError, reserveCredits } from "@book-maker/db/billing";
import { enqueueGenerationJob } from "../queue.js";
import {
  approvedPlanRecord,
  bearer,
  buildMobileApp,
  generatedPages,
  jobRecord,
  mockAccessTokens,
  mockPrisma,
  projectRecord,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

type Tier = "fast" | "balanced" | "premium" | "ultra";
const TIERS: Tier[] = ["fast", "balanced", "premium", "ultra"];
const PLAN_TOTALS = { fast: 20, balanced: 40, premium: 80, ultra: 120 } as const;
const PLAN_KEYS = {
  fast: "planGenerationFast",
  balanced: "planGeneration",
  premium: "planGenerationPremium",
  ultra: "planGenerationUltra"
} as const;

/** The harness book at one tier: 12 pages, lead magnet, illustrated, AI cover. */
function projectAtTier(tier: Tier, overrides: Record<string, unknown> = {}) {
  return projectRecord({
    id: "project-1",
    mediaSettings: {
      fullIllustrations: true,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "business",
      finalReview: true,
      toneProfile: "neutral",
      modelTier: tier,
      mobile: {
        bookType: "lead_magnet",
        lengthPreset: "short",
        qualityPreset: tier,
        imagesEnabled: true
      }
    },
    ...overrides
  });
}

describe("direct project planning prices by quality tier", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  for (const tier of TIERS) {
    it(`reserves and stamps the ${tier} plan quote`, async () => {
      mockAccessTokens({ "token-a": "user-a" });
      mockPrisma.project.findFirst.mockResolvedValueOnce(projectAtTier(tier));
      vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: `job-plan-${tier}` }));
      const app = await buildMobileApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/plan",
        headers: bearer("token-a"),
        payload: {}
      });

      expect(response.statusCode).toBe(202);
      expect(reserveCredits).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "PLAN_GENERATION",
          amountCredits: PLAN_TOTALS[tier],
          metadata: expect.objectContaining({
            initialPlan: true,
            modelTier: tier,
            pricingKey: PLAN_KEYS[tier]
          })
        })
      );
      await app.close();
    });
  }

  it("charges a project with no stored tier at the Balanced plan rate", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValueOnce(projectRecord({ id: "project-1" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/plan",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(response.statusCode).toBe(202);
    expect(reserveCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCredits: 40,
        metadata: expect.objectContaining({ modelTier: "balanced", pricingKey: "planGeneration" })
      })
    );
    await app.close();
  });

  it("replays a direct planning command without charging or queueing twice", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(projectAtTier("premium"));
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-plan" }));
    const app = await buildMobileApp();

    const first = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/plan",
      headers: bearer("token-a"),
      payload: {}
    });
    const replay = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/plan",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(202);
    expect(reserveCredits).toHaveBeenCalledTimes(1);
    expect(enqueueGenerationJob).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("does not queue or mutate a project when direct planning lacks credits", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValueOnce(projectAtTier("ultra"));
    vi.mocked(reserveCredits).mockRejectedValueOnce(
      new InsufficientCreditsError({ requiredCredits: 120, availableCredits: 10, reservedCredits: 0 })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/plan",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(response.statusCode).toBe(402);
    expect(response.json().error).toMatchObject({
      code: "INSUFFICIENT_CREDITS",
      requiredCredits: 120,
      availableCredits: 10
    });
    expect(enqueueGenerationJob).not.toHaveBeenCalled();
    expect(mockPrisma.project.update).not.toHaveBeenCalled();
    await app.close();
  });
});

/**
 * What approving a plan charges, per quality tier.
 *
 * Lives beside `plans.test.ts` rather than in it because that file is two lines
 * under the size budget — the split is a budget, not a seam.
 *
 * The totals are written out rather than derived from the price table. The app
 * mirrors this formula in Dart and there is no server quote route to fall back
 * on, so the number a reader is shown and the number the ledger takes are kept
 * equal by two implementations agreeing — which is only worth anything if a
 * change to either has to be typed out here.
 */
describe("plan approval prices by quality tier", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  async function approveAtTier(tier: Tier) {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.planVersion.findFirst.mockResolvedValueOnce({
      id: "plan-1",
      projectId: "project-1",
      status: "DRAFT",
      project: projectAtTier(tier)
    });
    mockPrisma.planVersion.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.project.updateMany.mockResolvedValue({ count: 1 });
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-generate" }));
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/plans/plan-1/approve",
      headers: bearer("token-a")
    });
    await app.close();
    return response;
  }

  // 12 pages, 2 interior illustrations plus a cover.
  const totals = {
    fast: 220 + 12 * 5 + 3 * 45 + 150,
    balanced: 350 + 12 * 8 + 3 * 45 + 150,
    premium: 500 + 12 * 30 + 3 * 85 + 200 + 150,
    ultra: 650 + 12 * 71 + 3 * 85 + 200 + 150
  } as const;

  for (const tier of TIERS) {
    it(`reserves the ${tier} tier's own total`, async () => {
      const response = await approveAtTier(tier);

      expect(response.statusCode).toBe(202);
      expect(reserveCredits).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "FULL_BOOK_GENERATION",
          amountCredits: totals[tier]
        })
      );
    });
  }

  it("keeps the tier that was priced on the reservation", async () => {
    await approveAtTier("premium");

    // The estimate is read back long after the project row may have moved, so
    // the tier it was priced at travels with it rather than being re-derived.
    expect(reserveCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          creditEstimate: expect.objectContaining({
            assumptions: expect.objectContaining({ modelTier: "premium" })
          })
        })
      })
    );
  });

  it("charges a book with no tier recorded at the balanced rates", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    // The harness project carries the app's `qualityPreset` echo and no tier —
    // the shape of every row written before tier routing existed. Those books
    // run the legacy single model, which is balanced work.
    mockPrisma.planVersion.findFirst.mockResolvedValueOnce({
      id: "plan-1",
      projectId: "project-1",
      status: "DRAFT",
      project: projectRecord({ id: "project-1" })
    });
    mockPrisma.planVersion.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.project.updateMany.mockResolvedValue({ count: 1 });
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-generate" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/plans/plan-1/approve",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(202);
    expect(reserveCredits).toHaveBeenCalledWith(
      expect.objectContaining({ amountCredits: totals.balanced })
    );
    await app.close();
  });
});

/**
 * Rewriting a page of a premium book runs the premium prose model, so the
 * per-page edit rates follow the tier the book was generated at — not the tier
 * of whatever the reader is making today.
 */
describe("book edits price by the book's own quality tier", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  // 2 chapters × 5 estimated pages, at each tier's page-rewrite rate.
  const continuationCredits = { fast: 10 * 40, balanced: 10 * 80, premium: 10 * 220, ultra: 10 * 280 } as const;

  for (const tier of TIERS) {
    it(`quotes and charges a continuation at the ${tier} rate`, async () => {
      mockAccessTokens({ "token-a": "user-a" });
      mockPrisma.project.findFirst.mockResolvedValue(
        projectAtTier(tier, {
          status: "COMPLETE",
          currentPlanId: "plan-1",
          currentPlan: approvedPlanRecord(),
          pages: generatedPages()
        })
      );
      vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-continue", type: "CONTINUE_BOOK" }));
      const app = await buildMobileApp();

      const proposal = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/chat/messages",
        headers: bearer("token-a"),
        payload: { message: "Continue the story and add 2 more chapters" }
      });
      const proposalBody = proposal.json();

      expect(proposal.statusCode).toBe(200);
      expect(proposalBody.reply.metadata.editProposal).toMatchObject({
        kind: "continue_book",
        credits: continuationCredits[tier]
      });

      const confirm = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/chat/proposals/apply",
        headers: bearer("token-a"),
        payload: { proposalId: proposalBody.reply.metadata.editProposal.id }
      });

      // The card is the confirmation, so the quote it showed is the charge.
      expect(confirm.statusCode).toBe(200);
      expect(vi.mocked(reserveCredits)).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "PAGE_REGENERATION",
          amountCredits: continuationCredits[tier]
        })
      );
      await app.close();
    });
  }
});
