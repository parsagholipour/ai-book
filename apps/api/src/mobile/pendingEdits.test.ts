import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { reserveCredits } from "@book-maker/db/billing";

import { enqueueGenerationJob } from "../queue.js";
import { isPendingEditConfirmationMessage } from "./bookEditIntents.js";
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
  projectRecord,
  resetMobileHarness,
  state,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

describe("mobile pending edit recovery", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("queues project chat edits as a pending request while generation is active", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "GENERATING",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: []
      })
    );
    mockPrisma.generationJob.count.mockResolvedValueOnce(1);
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Make the whole book warmer." }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toBeNull();
    expect(body.reply.content).toContain("saved that request");
    expect(body.reply.metadata).toMatchObject({
      blockedByActiveJob: true,
      pendingEdit: { request: "Make the whole book warmer.", clarification: "busy" }
    });
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns the busy reply without charging when a concurrent edit wins the open-operation slot", async () => {
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
    const app = await buildMobileApp();

    const proposal = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Make the whole book warmer and simpler." }
    });
    expect(proposal.statusCode).toBe(200);
    expect(proposal.json().operation).toBeNull();

    // The one-open-edit-per-project partial unique index (migration 000026)
    // rejects the second concurrent create even though hasOpenProjectWork saw
    // no open work when this confirmation started.
    mockPrisma.bookEditOperation.create.mockRejectedValueOnce(
      new MockPrismaKnownRequestError("Unique constraint failed", { code: "P2002" })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "apply it" }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toBeNull();
    expect(body.reply.content).toContain("saved that request");
    expect(body.reply.metadata).toMatchObject({
      blockedByActiveJob: true,
      pendingEdit: { request: "Make the whole book warmer and simpler.", clarification: "busy" }
    });
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  it("uses a whole-book follow-up to resolve the previous pending edit scope", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.projectChatMessages.push(
      {
        id: "chat-old-user",
        projectId: "project-1",
        role: "USER",
        content: "Replace rabbit with fly",
        operationId: null,
        metadata: {},
        createdAt: new Date("2026-06-15T11:00:00.000Z")
      },
      {
        id: "chat-old-assistant",
        projectId: "project-1",
        role: "ASSISTANT",
        content: "Should I change a specific page, matching phrase, or the whole book?",
        operationId: null,
        metadata: {
          pendingEdit: { request: "Replace rabbit with fly", clarification: "scope" }
        },
        createdAt: new Date("2026-06-15T11:01:00.000Z")
      }
    );
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages()
      })
    );
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-follow-up", type: "APPLY_BOOK_EDIT" }));
    const app = await buildMobileApp();

    const proposal = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "whole book" }
    });
    const proposalBody = proposal.json();

    expect(proposal.statusCode).toBe(200);
    expect(proposalBody.operation).toBeNull();
    expect(proposalBody.reply.metadata).toMatchObject({
      editProposal: {
        kind: "local_patch",
        affectedPageIndexes: [1, 2]
      },
      pendingEdit: { clarification: "confirm" }
    });
    expect(proposalBody.reply.content).not.toContain("I can help with questions");
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();

    const confirm = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "apply it" }
    });
    const body = confirm.json();

    expect(confirm.statusCode).toBe(200);
    expect(body.operation).toMatchObject({
      kind: "local_patch",
      affectedPageIndexes: [1, 2]
    });
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
          type: "APPLY_BOOK_EDIT",
          payload: expect.objectContaining({
          request: "Replace rabbit with fly throughout the whole book.",
          exactReplacement: { from: "rabbit", to: "fly" },
          affectedPageIndexes: [1, 2]
        })
      })
    );
    await app.close();
  });

  it("recovers a whole-book follow-up from legacy scope questions without pending metadata", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.projectChatMessages.push(
      {
        id: "chat-old-user",
        projectId: "project-1",
        role: "USER",
        content: "Replace rabbit with fly",
        operationId: null,
        metadata: {},
        createdAt: new Date("2026-06-15T11:00:00.000Z")
      },
      {
        id: "chat-old-assistant",
        projectId: "project-1",
        role: "ASSISTANT",
        content: "Which page or exact phrase should I change?",
        operationId: null,
        metadata: {
          intent: {
            kind: "clarify",
            assistantMessage: "Which page or exact phrase should I change?",
            affectedPageIndexes: []
          },
          charged: false
        },
        createdAt: new Date("2026-06-15T11:01:00.000Z")
      },
      {
        id: "chat-stranded-user",
        projectId: "project-1",
        role: "USER",
        content: "whole book",
        operationId: null,
        metadata: {},
        createdAt: new Date("2026-06-15T11:02:00.000Z")
      },
      {
        id: "chat-stranded-assistant",
        projectId: "project-1",
        role: "ASSISTANT",
        content: "I can help with questions about the book or make edits if you tell me what to change.",
        operationId: null,
        metadata: {
          intent: { kind: "answer", reasoning: "No edit intent was detected.", affectedPageIndexes: [] },
          charged: false
        },
        createdAt: new Date("2026-06-15T11:03:00.000Z")
      }
    );
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages()
      })
    );
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-legacy-follow-up", type: "APPLY_BOOK_EDIT" }));
    const app = await buildMobileApp();

    const proposal = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "I said whole book" }
    });
    const proposalBody = proposal.json();

    expect(proposal.statusCode).toBe(200);
    expect(proposalBody.operation).toBeNull();
    expect(proposalBody.reply.metadata).toMatchObject({
      editProposal: {
        kind: "local_patch",
        affectedPageIndexes: [1, 2]
      },
      pendingEdit: { clarification: "confirm" }
    });
    expect(proposalBody.reply.content).not.toContain("I can help with questions");
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();

    const confirm = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "apply it" }
    });
    const body = confirm.json();

    expect(confirm.statusCode).toBe(200);
    expect(body.operation).toMatchObject({
      kind: "local_patch",
      affectedPageIndexes: [1, 2]
    });
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "APPLY_BOOK_EDIT",
        payload: expect.objectContaining({
          request: "Replace rabbit with fly throughout the whole book.",
          exactReplacement: { from: "rabbit", to: "fly" },
          affectedPageIndexes: [1, 2]
        })
      })
    );
    await app.close();
  });

  it("uses a stranded whole-book scope when the user confirms the old edit", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.projectChatMessages.push(
      {
        id: "chat-old-user",
        projectId: "project-1",
        role: "USER",
        content: "Replace rabbit with fly",
        operationId: null,
        metadata: {},
        createdAt: new Date("2026-06-15T11:00:00.000Z")
      },
      {
        id: "chat-old-assistant",
        projectId: "project-1",
        role: "ASSISTANT",
        content: "Which page or exact phrase should I change?",
        operationId: null,
        metadata: {
          intent: {
            kind: "clarify",
            assistantMessage: "Which page or exact phrase should I change?",
            affectedPageIndexes: []
          },
          charged: false
        },
        createdAt: new Date("2026-06-15T11:01:00.000Z")
      },
      {
        id: "chat-stranded-user",
        projectId: "project-1",
        role: "USER",
        content: "whole book",
        operationId: null,
        metadata: {},
        createdAt: new Date("2026-06-15T11:02:00.000Z")
      },
      {
        id: "chat-stranded-assistant",
        projectId: "project-1",
        role: "ASSISTANT",
        content: "I can help with questions about the book or make edits if you tell me what to change.",
        operationId: null,
        metadata: {
          intent: { kind: "answer", reasoning: "No edit intent was detected.", affectedPageIndexes: [] },
          charged: false
        },
        createdAt: new Date("2026-06-15T11:03:00.000Z")
      }
    );
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages()
      })
    );
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-legacy-ok", type: "APPLY_BOOK_EDIT" }));
    const app = await buildMobileApp();

    const proposal = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "ok" }
    });
    const proposalBody = proposal.json();

    expect(proposal.statusCode).toBe(200);
    expect(proposalBody.operation).toBeNull();
    expect(proposalBody.reply.metadata).toMatchObject({
      editProposal: {
        kind: "local_patch",
        affectedPageIndexes: [1, 2]
      },
      pendingEdit: { clarification: "confirm" }
    });
    expect(proposalBody.messages.at(-2).metadata.resolvedPendingEdit).toMatchObject({
      request: "Replace rabbit with fly",
      scope: "all_pages",
      scopeMessage: "ok"
    });

    const confirm = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "apply it" }
    });
    const body = confirm.json();

    expect(confirm.statusCode).toBe(200);
    expect(body.operation).toMatchObject({
      kind: "local_patch",
      affectedPageIndexes: [1, 2]
    });
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "APPLY_BOOK_EDIT",
        payload: expect.objectContaining({
          request: "Replace rabbit with fly throughout the whole book.",
          exactReplacement: { from: "rabbit", to: "fly" },
          affectedPageIndexes: [1, 2]
        })
      })
    );
    await app.close();
  });

  it("recovers stranded edit context for frustrated follow-ups instead of generic help", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.projectChatMessages.push(
      {
        id: "chat-old-user",
        projectId: "project-1",
        role: "USER",
        content: "Replace rabbit with fly",
        operationId: null,
        metadata: {},
        createdAt: new Date("2026-06-15T11:00:00.000Z")
      },
      {
        id: "chat-old-assistant",
        projectId: "project-1",
        role: "ASSISTANT",
        content: "Which page or exact phrase should I change?",
        operationId: null,
        metadata: {},
        createdAt: new Date("2026-06-15T11:01:00.000Z")
      },
      {
        id: "chat-stranded-user",
        projectId: "project-1",
        role: "USER",
        content: "whole book",
        operationId: null,
        metadata: {},
        createdAt: new Date("2026-06-15T11:02:00.000Z")
      },
      {
        id: "chat-stranded-assistant",
        projectId: "project-1",
        role: "ASSISTANT",
        content: "I can help with questions about the book or make edits if you tell me what to change.",
        operationId: null,
        metadata: {},
        createdAt: new Date("2026-06-15T11:03:00.000Z")
      }
    );
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages()
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "wow" }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toBeNull();
    expect(body.reply.content).toContain("I still have your earlier edit");
    expect(body.reply.content).toContain("whole book");
    expect(body.reply.content).not.toContain("I can help with questions");
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  // Regression: "Aranha and the Big Match". The user asked to add a character,
  // was asked who it was, said "Just add", and was asked the same question
  // again — a loop with no reply that could escape it, because a scope
  // clarification whose scope is "none" can never be resolved.
  it("acts on an insistent follow-up instead of asking the same question again", async () => {
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
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-kaka", type: "APPLY_BOOK_EDIT" }));
    const app = await buildMobileApp();

    // One question is still allowed, and it stores what was asked about.
    const asked = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Add Kaka in the match" }
    });
    expect(asked.statusCode).toBe(200);
    expect(asked.json().reply.metadata).toMatchObject({
      intent: { kind: "clarify" },
      pendingEdit: { request: "Add Kaka in the match", clarification: "scope" }
    });

    const proposal = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Just add" }
    });
    const proposalBody = proposal.json();

    expect(proposal.statusCode).toBe(200);
    expect(proposalBody.reply.metadata.intent.kind).not.toBe("clarify");
    expect(proposalBody.reply.metadata).toMatchObject({
      charged: false,
      editProposal: { kind: "page_rewrite", affectedPageIndexes: [1, 2] },
      pendingEdit: { clarification: "confirm" }
    });
    // Both halves survive: the request the router acts on is the original ask
    // plus the follow-up, never the bare fragment.
    expect(proposalBody.reply.metadata.pendingEdit.request).toContain("Add Kaka in the match");
    expect(proposalBody.reply.metadata.pendingEdit.request).toContain("Just add");
    // A proposal is free; only Apply reserves credits.
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();

    const applied = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "apply it" }
    });

    expect(applied.statusCode).toBe(200);
    expect(applied.json().operation).toMatchObject({ kind: "page_rewrite", affectedPageIndexes: [1, 2] });
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "APPLY_BOOK_EDIT",
        payload: expect.objectContaining({ request: expect.stringContaining("Add Kaka in the match") })
      })
    );
    await app.close();
  });

  it("treats insistence as a confirmation without needing the exact word", async () => {
    expect(isPendingEditConfirmationMessage("Just add")).toBe(true);
    expect(isPendingEditConfirmationMessage("just do it")).toBe(true);
    expect(isPendingEditConfirmationMessage("add it")).toBe(true);
    expect(isPendingEditConfirmationMessage("do it anyway")).toBe(true);
    expect(isPendingEditConfirmationMessage("you decide")).toBe(true);
    expect(isPendingEditConfirmationMessage("up to you")).toBe(true);
    // Bare verbs stay out: this also confirms a priced proposal.
    expect(isPendingEditConfirmationMessage("change")).toBe(false);
    expect(isPendingEditConfirmationMessage("fix")).toBe(false);
    expect(isPendingEditConfirmationMessage("no")).toBe(false);
    expect(isPendingEditConfirmationMessage("add a dragon to page 2")).toBe(false);
  });
});

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

  it("answers a second Apply tap with 404 instead of running the edit twice", async () => {
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

    expect(second.statusCode).toBe(404);
    expect(second.json().error.code).toBe("PROPOSAL_NOT_FOUND");
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
});
