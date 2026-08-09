import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { reserveCredits } from "@book-maker/db/billing";

import { enqueueGenerationJob } from "../queue.js";
import {
  MockPrismaKnownRequestError,
  approvedPlanRecord,
  bearer,
  buildMobileApp,
  editablePages,
  generatedPages,
  jobRecord,
  mockAccessTokens,
  mockPrisma,
  mockQueue,
  projectRecord,
  resetMobileHarness,
  state,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

/**
 * Settling a priced edit proposal: Apply and Cancel racing each other, the
 * busy gate, replayed claims, and the durable operation row that decides who
 * won. Split from pendingEdits.test.ts along the describe seam.
 */

describe("proposal settlement", () => {
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

  it("does not re-execute an applied proposal when a later message says ok", async () => {
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
    expect(applied.json().operation).not.toBeNull();
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledTimes(1);

    const followUp = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "ok" }
    });

    // "ok" after Apply used to satisfy the still-pending confirm card and
    // charge the same edit a second time.
    expect(followUp.statusCode).toBe(200);
    expect(followUp.json().operation).toBeNull();
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("does not resurrect a button-cancelled proposal on a later yes", async () => {
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

    const followUp = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "yes" }
    });

    expect(followUp.statusCode).toBe(200);
    expect(followUp.json().operation).toBeNull();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not resurrect a chat-cancelled proposal either", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.pages = editablePages();
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    const app = await buildMobileApp();
    await proposeExactEdit(app);

    const cancelled = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "never mind" }
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().reply.content).toContain("dropped that request");

    const followUp = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "ok" }
    });

    expect(followUp.statusCode).toBe(200);
    expect(followUp.json().operation).toBeNull();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns the permanent proposal winner without running or charging twice", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.pages = editablePages();
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-1", type: "APPLY_BOOK_EDIT" }));
    const app = await buildMobileApp();
    const proposalId = await proposeExactEdit(app);

    const first = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/proposals/apply",
      headers: bearer("token-a"),
      payload: { proposalId, requestId: "req-apply-1" }
    });
    expect(first.statusCode).toBe(200);

    // A retry with the same requestId replays; a fresh requestId used to
    // re-find the confirm card and charge again.
    const second = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/proposals/apply",
      headers: bearer("token-a"),
      payload: { proposalId, requestId: "req-apply-2" }
    });

    expect(second.statusCode).toBe(200);
    expect(second.json().operation).toMatchObject({ id: first.json().operation.id });
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("keeps a busy-deflected Apply retryable", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.pages = editablePages();
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-1", type: "APPLY_BOOK_EDIT" }));
    const app = await buildMobileApp();
    const proposalId = await proposeExactEdit(app);

    // The first tap lands while another job is open: saved, not executed.
    mockPrisma.generationJob.count.mockResolvedValueOnce(1);
    const deflected = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/proposals/apply",
      headers: bearer("token-a"),
      payload: { proposalId, requestId: "req-apply-1" }
    });
    expect(deflected.statusCode).toBe(200);
    expect(deflected.json().operation).toBeNull();
    expect(deflected.json().reply.metadata).toMatchObject({ blockedByActiveJob: true });

    // The work settled; the card is still on screen and its Apply must work.
    const retried = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/proposals/apply",
      headers: bearer("token-a"),
      payload: { proposalId, requestId: "req-apply-2" }
    });

    expect(retried.statusCode).toBe(200);
    expect(retried.json().operation).not.toBeNull();
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("keeps a committed edit queued when dispatch fails after the charge landed", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.pages = editablePages();
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-1", type: "APPLY_BOOK_EDIT" }));
    const app = await buildMobileApp();
    const proposalId = await proposeExactEdit(app);

    // The attempt, debit and durable job committed; only the push to the queue
    // failed. The reconciler will publish the row, so the operation must stay
    // QUEUED — a FAILED here invites a second paid submission for work that
    // still runs.
    mockQueue.dispatchGenerationJob.mockRejectedValueOnce(new Error("Queue unavailable"));
    const applied = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/proposals/apply",
      headers: bearer("token-a"),
      payload: { proposalId, requestId: "req-apply-1" }
    });

    expect(applied.statusCode).toBe(200);
    expect(applied.json().operation).not.toBeNull();
    const operation = state.bookEditOperations.find((candidate) => candidate.requestId === proposalId);
    expect(operation?.status).toBe("QUEUED");
    await app.close();
  });

  it("surfaces the winner's charged operation to a raced Apply that lost the insert", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.pages = editablePages();
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    const app = await buildMobileApp();
    const proposalId = await proposeExactEdit(app);

    // The typed Apply commits between the button Apply's claim check and its
    // insert: the button request passed every check while no operation existed
    // yet, and production's unique [projectId, requestId] index settles the
    // race at the insert. hasOpenProjectWork is the loser's last read before
    // that insert, so the winner lands exactly there.
    mockPrisma.generationJob.count.mockImplementationOnce(async () => {
      state.bookEditOperations.push({
        id: "operation-winner",
        projectId: "project-1",
        requestId: proposalId,
        // The winner's messages live on the typed-Apply branch, which the
        // button Apply's branch never contains.
        userMessageId: "chat-typed-apply",
        assistantMessageId: "chat-typed-apply-reply",
        generationJobId: "job-1",
        ledgerEntryId: null,
        kind: "LOCAL_PATCH",
        status: "QUEUED",
        request: "Replace rabbit with fly throughout the whole book.",
        classifier: {},
        affectedPageIndexes: [1, 2],
        creditsCharged: 0,
        automaticRetryCount: 0,
        automaticRetryLimit: 2,
        nextRetryAt: null,
        lastRetryAt: null,
        lastRetryReason: null,
        retryRequestId: null,
        error: null,
        generationJob: { id: "job-1", status: "QUEUED" },
        createdAt: new Date("2026-06-15T13:30:00.000Z"),
        updatedAt: new Date("2026-06-15T13:30:00.000Z"),
        appliedAt: null
      });
      return 0;
    });

    const raced = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/proposals/apply",
      headers: bearer("token-a"),
      payload: { proposalId, requestId: "req-apply-button" }
    });

    expect(raced.statusCode).toBe(200);
    // The loser is handed the winning operation, runs nothing and charges nothing.
    expect(raced.json().operation).toMatchObject({ id: "operation-winner" });
    expect(raced.json().reply.metadata).toMatchObject({ replayedOperation: true, charged: false });
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    // And the charge stays visible: the loser's branch exposes the operation
    // through the replay reply even though the winner's messages are elsewhere.
    expect(raced.json().operations).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "operation-winner" })])
    );
    await app.close();
  });

  const winnerOperation = (proposalId: string, overrides: Record<string, unknown> = {}) => ({
    id: "operation-winner",
    projectId: "project-1",
    requestId: proposalId,
    userMessageId: "chat-typed-apply",
    assistantMessageId: "chat-typed-apply-reply",
    generationJobId: "job-1",
    ledgerEntryId: "ledger-PAGE_REGENERATION",
    kind: "PAGE_REWRITE",
    status: "QUEUED",
    request: "Rewrite page 1 to be much more dramatic.",
    classifier: {},
    affectedPageIndexes: [1],
    creditsCharged: 35,
    automaticRetryCount: 0,
    automaticRetryLimit: 2,
    nextRetryAt: null,
    lastRetryAt: null,
    lastRetryReason: null,
    retryRequestId: null,
    error: null,
    generationJob: { id: "job-1", status: "QUEUED" },
    createdAt: new Date("2026-06-15T13:30:00.000Z"),
    updatedAt: new Date("2026-06-15T13:30:00.000Z"),
    appliedAt: null,
    ...overrides
  });

  const proposePricedRewrite = async (app: Awaited<ReturnType<typeof buildMobileApp>>) => {
    const proposal = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Rewrite page 1 to be much more dramatic." }
    });
    expect(proposal.statusCode).toBe(200);
    const card = proposal.json().reply.metadata.editProposal;
    expect(card?.id).toBeTruthy();
    // A real paid proposal: the race must not be provable only for free edits.
    expect(card.credits).toBeGreaterThan(0);
    return card.id as string;
  };

  it("replays the winner instead of saving a priced Apply as a pending edit when its own job made the project busy", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.pages = editablePages();
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    const app = await buildMobileApp();
    const proposalId = await proposePricedRewrite(app);

    // The winner committed its operation and job between this request's claim
    // check and its busy check — the busyness IS the winner. Saving the
    // request as a pending edit here is what used to let a later "yes" rebuild
    // the proposal and charge the same rewrite a second time.
    mockPrisma.generationJob.count.mockImplementationOnce(async () => {
      state.bookEditOperations.push(winnerOperation(proposalId));
      return 1;
    });

    const deflected = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/proposals/apply",
      headers: bearer("token-a"),
      payload: { proposalId, requestId: "req-apply-btn" }
    });

    expect(deflected.statusCode).toBe(200);
    expect(deflected.json().operation).toMatchObject({ id: "operation-winner" });
    expect(deflected.json().reply.metadata).toMatchObject({ replayedOperation: true, charged: false });
    // No pending edit was saved and no second debit is reachable from here.
    expect(deflected.json().reply.metadata.pendingEdit).toBeUndefined();
    expect(deflected.json().reply.metadata.blockedByActiveJob).toBeUndefined();
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  it("replays the winner for a typed confirmation deflected by the Apply button's own job", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.pages = editablePages();
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    const app = await buildMobileApp();
    const proposalId = await proposePricedRewrite(app);

    mockPrisma.generationJob.count.mockImplementationOnce(async () => {
      state.bookEditOperations.push(winnerOperation(proposalId));
      return 1;
    });

    const typed = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "yes" }
    });

    expect(typed.statusCode).toBe(200);
    expect(typed.json().operation).toMatchObject({ id: "operation-winner" });
    expect(typed.json().reply.metadata).toMatchObject({ replayedOperation: true, charged: false });
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  it("hands a raced Cancel the executed operation instead of pretending it was dropped", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.pages = editablePages();
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    const app = await buildMobileApp();
    const proposalId = await proposePricedRewrite(app);

    // The Apply commits between the Cancel's pending-card read and its durable
    // claim insert; the unique [projectId, requestId] index settles who owns
    // the proposal.
    const originalCreate = mockPrisma.projectChatMessage.create.getMockImplementation()!;
    mockPrisma.projectChatMessage.create.mockImplementationOnce(async (args: Record<string, unknown>) => {
      state.bookEditOperations.push(winnerOperation(proposalId));
      return originalCreate(args);
    });

    const cancelled = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/proposals/cancel",
      headers: bearer("token-a"),
      payload: { proposalId, requestId: "req-cancel-raced" }
    });

    expect(cancelled.statusCode).toBe(200);
    // The truth, not "nothing was charged": the edit is running and paid for.
    expect(cancelled.json().operation).toMatchObject({ id: "operation-winner" });
    expect(cancelled.json().reply.content).toContain("already being handled");
    expect(cancelled.json().reply.content).not.toContain("dropped that request");
    await app.close();
  });

  it("replays a committed Cancel to a late Apply without executing anything", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.pages = editablePages();
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    const app = await buildMobileApp();
    const proposalId = await proposePricedRewrite(app);

    const cancelled = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/proposals/cancel",
      headers: bearer("token-a"),
      payload: { proposalId, requestId: "req-cancel-1" }
    });
    expect(cancelled.statusCode).toBe(200);
    // Cancel now claims the proposal durably.
    expect(state.bookEditOperations).toEqual(
      expect.arrayContaining([expect.objectContaining({ requestId: proposalId, status: "CANCELED" })])
    );

    const lateApply = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/proposals/apply",
      headers: bearer("token-a"),
      payload: { proposalId, requestId: "req-apply-late" }
    });

    expect(lateApply.statusCode).toBe(200);
    // The replay reuses the cancel reply when it exists, or phrases the
    // cancellation itself; either way nothing ran and nothing was charged.
    expect(lateApply.json().reply.content).toContain("Nothing was changed or charged");
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  it("expires an abandoned jobless claim instead of dead-ending every future edit", async () => {
    const { createOpenBookEditOperation } = await import("./editOperations.js");
    const conflict = new MockPrismaKnownRequestError("one open operation per project", { code: "P2002" });
    mockPrisma.bookEditOperation.create.mockRejectedValueOnce(conflict);
    mockPrisma.bookEditOperation.updateMany.mockResolvedValueOnce({ count: 1 });

    const operation = await createOpenBookEditOperation({
      projectId: "project-1",
      kind: "LOCAL_PATCH",
      status: "QUEUED",
      request: "Fix a typo.",
      classifier: {},
      affectedPageIndexes: [],
      creditsCharged: 0
    });

    // The crashed claim is failed and the slot re-taken in one pass.
    expect(operation).not.toBeNull();
    expect(mockPrisma.bookEditOperation.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ projectId: "project-1", status: "QUEUED", generationJobId: null }),
      data: { status: "FAILED", error: "Abandoned before its generation job was created." }
    });
  });
});
