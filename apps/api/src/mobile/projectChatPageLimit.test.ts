import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { getBookPageLimit, reserveCredits } from "@book-maker/db/billing";
import { DEFAULT_CREDIT_COSTS, resetCreditPricing, setCreditPricing } from "@book-maker/core";

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

/**
 * The book chat meeting the free tier's book length: the proposal still shows
 * its priced card with the reason beside it, Apply refuses without charging and
 * leaves a fresh card, and that card runs once the reader has a plan.
 */
describe("the free tier's book length in the book chat", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("offers a plan for a continuation past the free page limit, and runs it once the reader has one", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages()
      })
    );
    // Two pages today; two chapters of five would make twelve.
    vi.mocked(getBookPageLimit).mockResolvedValue(8);
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-continue", type: "CONTINUE_BOOK" }));
    const app = await buildMobileApp();

    const proposal = (
      await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/chat/messages",
        headers: bearer("token-a"),
        payload: { message: "Continue the story and add 2 more chapters" }
      })
    ).json();
    // The card stays, priced, so the reader sees what a plan buys; the reply
    // says why it needs one, and the metadata is what draws the offer.
    expect(proposal.reply.content).toContain("12-page book");
    expect(proposal.reply.content).toContain("free books go up to 8 pages");
    expect(proposal.reply.metadata).toMatchObject({
      charged: false,
      pageLimit: { limit: 8, requestedPages: 12, maxPages: 200 },
      // Ten pages added, priced like a book: 100 + 10 × 8.
      editProposal: { kind: "continue_book", credits: 180 }
    });

    const refused = (
      await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/chat/proposals/apply",
        headers: bearer("token-a"),
        payload: { proposalId: proposal.reply.metadata.editProposal.id }
      })
    ).json();
    expect(refused.operation).toBeNull();
    expect(refused.reply.metadata).toMatchObject({
      charged: false,
      pageLimit: { limit: 8, requestedPages: 12 },
      editProposal: { kind: "continue_book" }
    });
    // A fresh card: the refused Apply spent its own proposal id.
    expect(refused.reply.metadata.editProposal.id).not.toBe(proposal.reply.metadata.editProposal.id);
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();

    // Upgraded: the fresh card's Apply now runs.
    vi.mocked(getBookPageLimit).mockResolvedValue(null);
    const applied = (
      await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/chat/proposals/apply",
        headers: bearer("token-a"),
        payload: { proposalId: refused.reply.metadata.editProposal.id }
      })
    ).json();
    expect(applied.operation).toMatchObject({ kind: "continue_book" });
    expect(vi.mocked(reserveCredits)).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "PAGE_REGENERATION", amountCredits: 180 })
    );
    await app.close();
  });
});

/**
 * Past the ceiling no plan helps, so the chat says so and offers nothing to
 * Apply; a card quoted before the operator lowered the ceiling is refused at
 * Apply without a fresh one.
 */
describe("the generated-book ceiling in the book chat", () => {
  beforeEach(resetMobileHarness);
  afterEach(() => {
    resetCreditPricing();
    teardownMobileHarness();
  });

  function bookOnAPlan() {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages()
      })
    );
    vi.mocked(getBookPageLimit).mockResolvedValue(null);
  }

  it("answers a continuation past the ceiling with the sentence and no card", async () => {
    bookOnAPlan();
    // Eight more chapters take the book past an operator's 30-page ceiling.
    setCreditPricing({ ...DEFAULT_CREDIT_COSTS, paidMaxBookPages: 30 });
    const app = await buildMobileApp();

    const reply = (
      await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/chat/messages",
        headers: bearer("token-a"),
        payload: { message: "Continue the story and add 8 more chapters" }
      })
    ).json().reply;

    expect(reply.content).toContain("books longer than 30 pages aren't available yet");
    expect(reply.metadata.pageLimit).toBeUndefined();
    expect(reply.metadata.editProposal).toBeUndefined();
    expect(reply.metadata.pendingEdit).toBeUndefined();
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses at Apply a card quoted before the ceiling came down, and leaves no new card", async () => {
    bookOnAPlan();
    const app = await buildMobileApp();
    const proposal = (
      await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/chat/messages",
        headers: bearer("token-a"),
        payload: { message: "Continue the story and add 8 more chapters" }
      })
    ).json();
    expect(proposal.reply.metadata.editProposal).toMatchObject({ kind: "continue_book" });

    setCreditPricing({ ...DEFAULT_CREDIT_COSTS, paidMaxBookPages: 30 });
    const refused = (
      await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/chat/proposals/apply",
        headers: bearer("token-a"),
        payload: { proposalId: proposal.reply.metadata.editProposal.id }
      })
    ).json();

    expect(refused.operation).toBeNull();
    expect(refused.reply.content).toContain("aren't available yet");
    expect(refused.reply.metadata.editProposal).toBeUndefined();
    expect(refused.reply.metadata.pageLimit).toBeUndefined();
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });
});
