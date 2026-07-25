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

});
