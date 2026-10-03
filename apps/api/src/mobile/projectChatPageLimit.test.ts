import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { getBookPageLimit, reserveCredits } from "@book-maker/db/billing";

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
      pageLimit: { limit: 8, requestedPages: 12, maxPages: 600 },
      editProposal: { kind: "continue_book", credits: 800 }
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
      expect.objectContaining({ operation: "PAGE_REGENERATION", amountCredits: 800 })
    );
    await app.close();
  });
});
