import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { enqueueGenerationJob } from "../queue.js";
import {
  approvedPlanRecord,
  bearer,
  buildMobileApp,
  editablePages,
  generatedPages,
  jobRecord,
  mockAccessTokens,
  mockPrisma,
  projectRecord,
  resetMobileHarness,
  state,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

/**
 * What the app needs to *draw* a proposal turn, as opposed to settle one:
 * which proposal still takes an Apply, and which message its operation card
 * belongs under. Both were things the app had to guess, and both guesses were
 * wrong after an Apply — a spent card kept its buttons, and the finished card
 * rendered above the reply announcing the work rather than below it.
 */

describe("proposal card state", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  const completeProject = () =>
    projectRecord({
      id: "project-1",
      status: "COMPLETE",
      currentPlanId: "plan-1",
      currentPlan: approvedPlanRecord(),
      pages: generatedPages()
    });

  const proposeExactEdit = async (app: Awaited<ReturnType<typeof buildMobileApp>>) => {
    const proposal = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Replace rabbit with fly throughout the whole book." }
    });
    expect(proposal.statusCode).toBe(200);
    const card = proposal.json().reply.metadata.editProposal;
    expect(card?.id).toBeTruthy();
    return card.id as string;
  };

  const openChat = async (app: Awaited<ReturnType<typeof buildMobileApp>>) => {
    const chat = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/chat",
      headers: bearer("token-a")
    });
    expect(chat.statusCode).toBe(200);
    return chat.json();
  };

  it("reports the open proposal, and stops once it is applied", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.pages = editablePages();
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-1", type: "APPLY_BOOK_EDIT" }));
    const app = await buildMobileApp();
    const proposalId = await proposeExactEdit(app);

    expect((await openChat(app)).openProposalId).toBe(proposalId);

    const applied = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/proposals/apply",
      headers: bearer("token-a"),
      payload: { proposalId, requestId: "req-apply-1" }
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().openProposalId).toBeNull();
    expect((await openChat(app)).openProposalId).toBeNull();
    await app.close();
  });

  it("keeps a cancelled proposal closed as well", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.pages = editablePages();
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    const app = await buildMobileApp();
    const proposalId = await proposeExactEdit(app);

    const cancelled = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/proposals/cancel",
      headers: bearer("token-a"),
      payload: { proposalId, requestId: "req-cancel-1" }
    });
    expect(cancelled.statusCode).toBe(200);
    expect((await openChat(app)).openProposalId).toBeNull();
    await app.close();
  });

  it("anchors the applied operation to the reply announcing it", async () => {
    // The row is read before that reply is written, so the response used to
    // point at the user's "Apply" — which places the card above the sentence
    // that introduces it.
    mockAccessTokens({ "token-a": "user-a" });
    state.pages = editablePages();
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-1", type: "APPLY_BOOK_EDIT" }));
    const app = await buildMobileApp();
    const proposalId = await proposeExactEdit(app);

    const applied = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/proposals/apply",
      headers: bearer("token-a"),
      payload: { proposalId, requestId: "req-apply-1" }
    });
    expect(applied.statusCode).toBe(200);
    const body = applied.json();
    expect(body.operation.anchorMessageId).toBe(body.reply.id);
    await app.close();
  });
});
