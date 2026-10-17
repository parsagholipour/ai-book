import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { InsufficientCreditsError, grantProjectEntitlement, hasActiveSubscriptionEntitlement, reserveCredits } from "@book-maker/db/billing";
import { DEFAULT_CREDIT_COSTS, resetCreditPricing, setCreditPricing } from "@book-maker/core";
import { ULTRA_TIER_UNAVAILABLE_MESSAGE } from "./ultraTier.js";
import { enqueueGenerationJob } from "../queue.js";
import { bookEditCreditCost } from "./bookEditPricing.js";
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

/** Ultra launches switched off; the tier ladder below is priced as an operator who turned it on. */
function withUltraOn() {
  resetMobileHarness();
  setCreditPricing({ ...DEFAULT_CREDIT_COSTS, ultraTierEnabled: 1 });
}

function teardown() {
  resetCreditPricing();
  teardownMobileHarness();
}

describe("direct project planning prices by quality tier", () => {
  beforeEach(withUltraOn);
  afterEach(teardown);

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

  it("does not charge direct planning when the project already has a plan", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValueOnce(projectAtTier("balanced"));
    mockPrisma.project.findUnique.mockResolvedValueOnce({ currentPlanId: "plan-1" });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/plan",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({
      code: "GENERATION_COMMAND_CONFLICT",
      message: "This project already has a plan."
    });
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(enqueueGenerationJob).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not charge against a legacy initial-plan job with no attempt", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValueOnce(projectAtTier("premium"));
    mockPrisma.generationAttempt.findUnique.mockResolvedValueOnce(null);
    mockPrisma.generationJob.findUnique.mockResolvedValueOnce({ id: "legacy-plan-job" });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/plan",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({
      code: "GENERATION_COMMAND_CONFLICT",
      message: "Planning has already started for this project."
    });
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(enqueueGenerationJob).not.toHaveBeenCalled();
    expect(mockPrisma.project.update).not.toHaveBeenCalled();
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
describe("plan revisions price by quality tier", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  const REVISION_KEYS = {
    fast: "planRevisionFast",
    balanced: "planRevision",
    premium: "planRevisionPremium",
    ultra: "planRevisionUltra"
  } as const;

  for (const tier of TIERS) {
    it(`charges a ${tier} revision what that tier's first plan cost`, async () => {
      // A flat 40 charged a Quick Draft revision twice the plan it revised.
      mockAccessTokens({ "token-a": "user-a" });
      const project = projectAtTier(tier);
      mockPrisma.planVersion.findFirst.mockResolvedValueOnce({
        id: "plan-1",
        projectId: "project-1",
        status: "DRAFT",
        project
      });
      mockPrisma.project.findUnique.mockResolvedValue(project);
      mockPrisma.project.update.mockResolvedValue({});
      vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-revise", type: "REVISE_PLAN" }));
      const app = await buildMobileApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/plans/plan-1/revise",
        headers: bearer("token-a"),
        payload: { message: "Make the examples warmer." }
      });

      expect(response.statusCode).toBe(202);
      expect(reserveCredits).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "PLAN_REVISION",
          amountCredits: PLAN_TOTALS[tier],
          metadata: expect.objectContaining({ modelTier: tier, pricingKey: REVISION_KEYS[tier] })
        })
      );
      await app.close();
    });

    it(`quotes a ${tier} chat plan revision at the same rate`, () => {
      expect(bookEditCreditCost("plan_revision", 0, projectAtTier(tier) as never)).toBe(PLAN_TOTALS[tier]);
    });
  }
});

describe("plan approval prices by quality tier", () => {
  beforeEach(withUltraOn);
  afterEach(teardown);

  /** A reader on a plan unless told otherwise; the price is the same either way. */
  async function approveAtTier(tier: Tier, paid = true) {
    mockAccessTokens({ "token-a": "user-a" });
    vi.mocked(hasActiveSubscriptionEntitlement).mockResolvedValue(paid);
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

  // 12 pages, 2 interior illustrations plus a cover. No export unlock: the
  // finished book downloads free (2026-10-15).
  const totals = {
    fast: 150 + 12 * 5 + 3 * 70,
    balanced: 250 + 12 * 8 + 3 * 70,
    premium: 500 + 12 * 30 + 3 * 130 + 200,
    ultra: 650 + 12 * 130 + 3 * 130 + 200
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

  it.each([
    ["a free reader", false],
    ["a subscriber", true]
  ])("charges %s the same single price, once, and grants nothing beside it", async (_reader, paid) => {
    // Spelled out, like the totals above: the app mirrors it with no quote route.
    const response = await approveAtTier("balanced", paid);

    expect(response.statusCode).toBe(202);
    expect(reserveCredits).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ operation: "FULL_BOOK_GENERATION", amountCredits: 250 + 12 * 8 + 3 * 70 })
    );
    const { metadata } = vi.mocked(reserveCredits).mock.calls[0]![0];
    const estimate = (metadata as { creditEstimate: { lineItems: Array<{ code: string }>; assumptions: object } }).creditEstimate;
    expect(estimate.lineItems.map((line) => line.code)).not.toContain("EXPORT_UNLOCK");
    expect(estimate.assumptions).not.toHaveProperty("includesExportUnlock");
    expect(grantProjectEntitlement).not.toHaveBeenCalled();
    // The plan is no longer asked at all: it changes nothing about the price.
    expect(hasActiveSubscriptionEntitlement).not.toHaveBeenCalled();
  });

  it("charges a book with no tier recorded at the balanced rates", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    vi.mocked(hasActiveSubscriptionEntitlement).mockResolvedValue(true);
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

  // 2 chapters × 5 estimated pages, priced like the book they join: the flat
  // 100-credit base plus each tier's own writing rate per page added. At the
  // old page-rewrite rate (40 / 80 / 220 / 280) ten more pages cost more than a
  // new ten-page book.
  const continuationCredits = { fast: 100 + 10 * 5, balanced: 100 + 10 * 8, premium: 100 + 10 * 30, ultra: 100 + 10 * 130 } as const;

  it("prices inserted pages like a continuation and leaves a page rewrite at the rewrite rate", () => {
    const totals = (kind: "restructure_pages" | "page_rewrite", pages: number) =>
      TIERS.map((tier) => bookEditCreditCost(kind, pages, projectAtTier(tier) as never));
    // Three new pages: the base plus 3 × the tier's writing rate.
    expect(totals("restructure_pages", 3)).toEqual([100 + 3 * 5, 100 + 3 * 8, 100 + 3 * 30, 100 + 3 * 130]);
    // A delete or a move writes no page, so it costs nothing — base included.
    expect(totals("restructure_pages", 0)).toEqual([0, 0, 0, 0]);
    // Rewriting existing pages keeps its own rate.
    expect(totals("page_rewrite", 3)).toEqual([3 * 40, 3 * 80, 3 * 220, 3 * 280]);
  });

  it("quotes a chat rebuild through the same function the charge stores its quote from", () => {
    // 12 pages, 2 interior illustrations and a cover at balanced, plus the 120
    // rebuild base — and no export unlock, for any reader.
    expect(bookEditCreditCost("book_replan", 0, projectAtTier("balanced") as never)).toBe(
      120 + 250 + 12 * 8 + 3 * 70
    );
  });

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

/**
 * While the operator has Ultra off (the launch default), no *new* book starts
 * at Ultra — and a book that already did keeps its tier for every edit (the
 * continuation suite above runs with the switch off).
 */
describe("the Ultra switch", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardown);

  it("refuses a first plan at Ultra before anything is reserved", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValueOnce(projectAtTier("ultra"));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/plan",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: { code: "QUALITY_TIER_UNAVAILABLE", message: ULTRA_TIER_UNAVAILABLE_MESSAGE } });
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(enqueueGenerationJob).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses to approve an Ultra plan, and approves a Premium one", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.planVersion.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.project.updateMany.mockResolvedValue({ count: 1 });
    vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-generate" }));
    const app = await buildMobileApp();

    mockPrisma.planVersion.findFirst.mockResolvedValueOnce({
      id: "plan-1",
      projectId: "project-1",
      status: "DRAFT",
      project: projectAtTier("ultra")
    });
    const ultra = await app.inject({ method: "POST", url: "/api/mobile/plans/plan-1/approve", headers: bearer("token-a") });
    expect(ultra.statusCode).toBe(422);
    expect(ultra.json().error.code).toBe("QUALITY_TIER_UNAVAILABLE");
    expect(reserveCredits).not.toHaveBeenCalled();

    mockPrisma.planVersion.findFirst.mockResolvedValueOnce({
      id: "plan-1",
      projectId: "project-1",
      status: "DRAFT",
      project: projectAtTier("premium")
    });
    const premium = await app.inject({ method: "POST", url: "/api/mobile/plans/plan-1/approve", headers: bearer("token-a") });
    expect(premium.statusCode).toBe(202);
    await app.close();
  });

  it("lets an Ultra plan through once the operator switches Ultra on", async () => {
    setCreditPricing({ ...DEFAULT_CREDIT_COSTS, ultraTierEnabled: 1 });
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValueOnce(projectAtTier("ultra"));
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-plan-ultra" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/plan",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(response.statusCode).toBe(202);
    await app.close();
  });
});
