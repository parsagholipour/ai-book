import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { reserveCredits } from "@book-maker/db/billing";
import { PRE_EDIT_PROJECT_STATUS } from "@book-maker/core";

import { enqueueGenerationJob } from "../queue.js";
import { serializeProjectChatMessage, stripCreditAnnouncement } from "./projectChat.js";
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
  state,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

describe("mobile project chat", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("answers plan-stage project chat questions without queuing a revision", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "PLAN_READY",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord({ status: "DRAFT", approvedAt: null }),
        pages: []
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "What is this plan about?" }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toBeNull();
    expect(body.messages).toEqual([
      expect.objectContaining({ role: "user", content: "What is this plan about?" }),
      expect.objectContaining({ role: "assistant", content: expect.stringContaining("Rabbit and Turtle") })
    ]);
    expect(body.reply.content).not.toMatch(/book text edits are available after/i);
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns the newest chat window and paginates earlier active messages chronologically", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1" });
    for (let index = 1; index <= 6; index += 1) {
      state.projectChatMessages.push({
        id: `chat-${index}`,
        projectId: "project-1",
        parentId: index === 1 ? null : `chat-${index - 1}`,
        role: index % 2 === 0 ? "ASSISTANT" : "USER",
        content: `Message ${index}`,
        operationId: null,
        metadata: index === 6 ? { intent: { kind: "answer", reasoning: "private" }, provider: "hidden" } : {},
        isActiveChild: true,
        createdAt: new Date(`2026-06-15T12:0${index}:00.000Z`)
      });
    }
    const app = await buildMobileApp();

    const newest = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/chat?limit=2",
      headers: bearer("token-a")
    });
    expect(newest.statusCode).toBe(200);
    expect(newest.json()).toMatchObject({
      hasMore: true,
      nextCursor: "chat-5",
      messages: [{ id: "chat-5" }, { id: "chat-6" }]
    });
    expect(JSON.stringify(newest.json().messages)).not.toMatch(/reasoning|provider|hidden|private/);

    const earlier = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/chat?limit=2&beforeMessageId=chat-5",
      headers: bearer("token-a")
    });
    expect(earlier.json()).toMatchObject({
      hasMore: true,
      nextCursor: "chat-3",
      messages: [{ id: "chat-3" }, { id: "chat-4" }]
    });
    await app.close();
  });

  it("drops the announced price from transcripts written before the credit badge", () => {
    // Otherwise an old turn states the price twice: once in prose, once on the
    // badge the app now draws from metadata.
    const serialized = serializeProjectChatMessage({
      id: "chat-2",
      projectId: "project-1",
      parentId: "chat-1",
      role: "ASSISTANT",
      content: "I’ll rewrite page 3 and refresh the exports. This uses 80 credits.",
      operationId: null,
      metadata: { charged: true, creditsCharged: 80 },
      isActiveChild: true,
      createdAt: new Date("2026-06-15T12:02:00.000Z")
    });
    expect(serialized.content).toBe("I’ll rewrite page 3 and refresh the exports.");
    expect(serialized.metadata).toMatchObject({ creditsCharged: 80 });
    expect(stripCreditAnnouncement("Edit page 2. It would use 35 credits. Tap Apply to confirm.")).toBe(
      "Edit page 2. Tap Apply to confirm."
    );
    // Not an announcement: this one is the whole message and has to survive.
    const shortfall = "You need 800 credits for that edit, but you have 120.";
    expect(stripCreditAnnouncement(shortfall)).toBe(shortfall);
  });

  it("replays a project-chat request ID without duplicating the turn", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-1", status: "PLAN_READY", currentPlan: approvedPlanRecord() })
    );
    state.projectChatMessages.push(
      {
        id: "chat-user-existing",
        projectId: "project-1",
        requestId: "request-123",
        parentId: null,
        role: "USER",
        content: "What changed?",
        operationId: null,
        metadata: {},
        isActiveChild: true,
        createdAt: new Date("2026-06-15T12:00:00.000Z")
      },
      {
        id: "chat-assistant-existing",
        projectId: "project-1",
        requestId: null,
        parentId: "chat-user-existing",
        role: "ASSISTANT",
        content: "The title changed.",
        operationId: null,
        metadata: {},
        isActiveChild: true,
        createdAt: new Date("2026-06-15T12:01:00.000Z")
      }
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "What changed?", requestId: "request-123" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().reply).toMatchObject({ id: "chat-assistant-existing", content: "The title changed." });
    expect(mockPrisma.projectChatMessage.create).not.toHaveBeenCalled();
    expect(state.projectChatMessages).toHaveLength(2);
    await app.close();
  });

  it("branches project chat history when editing a previous user message", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.projectChatMessages.push(
      {
        id: "chat-old-user",
        projectId: "project-1",
        parentId: null,
        role: "USER",
        content: "What is this plan about?",
        operationId: null,
        metadata: {},
        isActiveChild: true,
        createdAt: new Date("2026-06-15T11:00:00.000Z")
      },
      {
        id: "chat-old-assistant",
        projectId: "project-1",
        parentId: "chat-old-user",
        role: "ASSISTANT",
        content: "This plan is about a rabbit race.",
        operationId: null,
        metadata: {},
        isActiveChild: true,
        createdAt: new Date("2026-06-15T11:01:00.000Z")
      },
      {
        id: "chat-old-follow-up",
        projectId: "project-1",
        parentId: "chat-old-assistant",
        role: "USER",
        content: "Make it warmer.",
        operationId: null,
        metadata: {},
        isActiveChild: true,
        createdAt: new Date("2026-06-15T11:02:00.000Z")
      },
      {
        id: "chat-old-follow-up-reply",
        projectId: "project-1",
        parentId: "chat-old-follow-up",
        role: "ASSISTANT",
        content: "I’ll revise the plan now.",
        operationId: null,
        metadata: {},
        isActiveChild: true,
        createdAt: new Date("2026-06-15T11:03:00.000Z")
      }
    );
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "PLAN_READY",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord({ status: "DRAFT", approvedAt: null }),
        pages: []
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { editMessageId: "chat-old-user", message: "What is this plan really about?" }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toBeNull();
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toMatchObject({
      id: "chat-5",
      parentId: null,
      role: "user",
      content: "What is this plan really about?",
      branch: { index: 2, total: 2, canGoPrevious: true, canGoNext: false }
    });
    expect(body.messages[1]).toMatchObject({
      parentId: "chat-5",
      role: "assistant"
    });
    expect(body.messages.map((message: any) => message.id)).not.toContain("chat-old-follow-up");
    expect(state.projectChatMessages.find((message) => message.id === "chat-old-user")?.isActiveChild).toBe(false);
    await app.close();
  });

  it("switches between project chat sibling branches", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.projectChatMessages.push(
      {
        id: "chat-old-user",
        projectId: "project-1",
        parentId: null,
        role: "USER",
        content: "What is this plan about?",
        operationId: null,
        metadata: {},
        isActiveChild: false,
        createdAt: new Date("2026-06-15T11:00:00.000Z")
      },
      {
        id: "chat-old-assistant",
        projectId: "project-1",
        parentId: "chat-old-user",
        role: "ASSISTANT",
        content: "This plan is about a rabbit race.",
        operationId: null,
        metadata: {},
        isActiveChild: true,
        createdAt: new Date("2026-06-15T11:01:00.000Z")
      },
      {
        id: "chat-new-user",
        projectId: "project-1",
        parentId: null,
        role: "USER",
        content: "What is this plan really about?",
        operationId: null,
        metadata: { editedFromMessageId: "chat-old-user" },
        isActiveChild: true,
        createdAt: new Date("2026-06-15T11:02:00.000Z")
      },
      {
        id: "chat-new-assistant",
        projectId: "project-1",
        parentId: "chat-new-user",
        role: "ASSISTANT",
        content: "This plan is about a warmer rabbit race.",
        operationId: null,
        metadata: {},
        isActiveChild: true,
        createdAt: new Date("2026-06-15T11:03:00.000Z")
      }
    );
    mockPrisma.project.findFirst.mockResolvedValue(projectRecord({ id: "project-1" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/branches",
      headers: bearer("token-a"),
      payload: { messageId: "chat-new-user", direction: "previous" }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.messages.map((message: any) => message.id)).toEqual(["chat-old-user", "chat-old-assistant"]);
    expect(body.messages[0].branch).toMatchObject({ index: 1, total: 2, canGoPrevious: false, canGoNext: true });
    expect(state.projectChatMessages.find((message) => message.id === "chat-old-user")?.isActiveChild).toBe(true);
    expect(state.projectChatMessages.find((message) => message.id === "chat-new-user")?.isActiveChild).toBe(false);
    await app.close();
  });

  it("queues soft plan-stage project chat change requests as plan revisions", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "PLAN_READY",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord({ status: "DRAFT", approvedAt: null }),
        pages: []
      })
    );
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-soft-plan-revise", type: "REVISE_PLAN" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "I want the audience to be parents." }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toMatchObject({ kind: "plan_revision" });
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        type: "REVISE_PLAN",
        payload: expect.objectContaining({
          planId: "plan-1",
          message: "I want the audience to be parents."
        })
      })
    );
    await app.close();
  });

  it("queues negative media plan preferences as plan revisions", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "PLAN_READY",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord({ status: "DRAFT", approvedAt: null }),
        pages: []
      })
    );
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-media-plan-revise", type: "REVISE_PLAN" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "I don't want images or covers" }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toMatchObject({ kind: "plan_revision" });
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        type: "REVISE_PLAN",
        payload: expect.objectContaining({
          planId: "plan-1",
          message: "I don't want images or covers"
        })
      })
    );
    await app.close();
  });

  it("treats saved current plans as plan-chat even when project status is not PLAN_READY", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "PLANNING",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord({ status: "DRAFT", approvedAt: null }),
        pages: []
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "What is this plan about?" }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toBeNull();
    expect(body.reply.content).not.toMatch(/book text edits are available after/i);
    expect(body.reply.content).toContain("Rabbit and Turtle");
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps non-plan in-progress project chat edits on the generated-book fallback path", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "GENERATING",
        currentPlanId: null,
        currentPlan: null,
        pages: []
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Make the book warmer." }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toBeNull();
    expect(body.reply.content).toContain("after the current book work is finished");
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  it("proposes a completed-book whole-book style edit and queues it after confirmation", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const pages = generatedPages();
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages
      })
    );
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-edit", type: "APPLY_BOOK_EDIT" }));
    const app = await buildMobileApp();

    const proposal = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Make the whole book warmer and simpler." }
    });
    const proposalBody = proposal.json();

    expect(proposal.statusCode).toBe(200);
    expect(proposalBody.operation).toBeNull();
    expect(proposalBody.reply.content).toContain("whole book");
    expect(proposalBody.reply.content).toMatch(/Tap Apply|apply it/i);
    // The price rides in metadata for the app's credit badge; the reply itself
    // never states it.
    expect(proposalBody.reply.content).not.toMatch(/credits/i);
    expect(proposalBody.reply.metadata.editProposal.credits).toBeGreaterThan(0);
    expect(proposalBody.reply.metadata).toMatchObject({
      charged: false,
      pendingEdit: { clarification: "confirm" },
      editProposal: {
        kind: "page_rewrite",
        affectedPageIndexes: [1, 2]
      }
    });
    expect(typeof proposalBody.reply.metadata.editProposal.id).toBe("string");
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();

    const confirm = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/proposals/apply",
      headers: bearer("token-a"),
      payload: { proposalId: proposalBody.reply.metadata.editProposal.id }
    });
    const body = confirm.json();

    expect(confirm.statusCode).toBe(200);
    expect(body.operation).toMatchObject({
      kind: "page_rewrite",
      affectedPageIndexes: [1, 2]
    });
    expect(body.reply.content).not.toMatch(/credits/i);
    expect(body.reply.metadata.creditsCharged).toBeGreaterThan(0);
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        type: "APPLY_BOOK_EDIT",
        payload: expect.objectContaining({
          affectedPageIndexes: [1, 2],
          intentKind: "page_rewrite",
          [PRE_EDIT_PROJECT_STATUS]: "COMPLETE"
        })
      })
    );
    await app.close();
  });

  it("stamps REVIEW_REQUIRED on a text edit before enqueue changes the project status", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "REVIEW_REQUIRED",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages()
      })
    );
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-edit", type: "APPLY_BOOK_EDIT" }));
    const app = await buildMobileApp();

    const proposal = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Make the whole book warmer and simpler." }
    });
    await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/proposals/apply",
      headers: bearer("token-a"),
      payload: { proposalId: proposal.json().reply.metadata.editProposal.id }
    });

    expect(vi.mocked(enqueueGenerationJob).mock.calls.at(-1)?.[0].payload[PRE_EDIT_PROJECT_STATUS]).toBe(
      "REVIEW_REQUIRED"
    );
    await app.close();
  });

  it("stores the quoted message when a chat turn is a reply", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.projectChatMessages.push({
      id: "chat-quoted",
      projectId: "project-1",
      parentId: null,
      role: "ASSISTANT",
      content: "This plan is about a rabbit race.",
      operationId: null,
      metadata: {},
      isActiveChild: true,
      createdAt: new Date("2026-06-15T11:00:00.000Z")
    });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "PLAN_READY",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord({ status: "DRAFT", approvedAt: null }),
        pages: []
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "What does that mean?", replyToMessageId: "chat-quoted" }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    const sent = body.messages.find((message: any) => message.content === "What does that mean?");
    // The quote is a snapshot, not a lookup: the transcript prunes, and the
    // excerpt has to survive the original being folded away.
    expect(sent.metadata.replyTo).toEqual({
      messageId: "chat-quoted",
      role: "assistant",
      excerpt: "This plan is about a rabbit race."
    });
    await app.close();
  });

  it("rejects a reply to a message that is not in this project", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "PLAN_READY",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord({ status: "DRAFT", approvedAt: null }),
        pages: []
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "What does that mean?", replyToMessageId: "chat-missing" }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("MESSAGE_NOT_FOUND");
    expect(mockPrisma.projectChatMessage.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("prices a reply exactly as it prices the same message sent on its own", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    // The quote is chosen to be maximally dangerous to the pricing path: it
    // names a page and carries two quoted phrases, which is the shape
    // pageIndexesFromMessage and replacementTermsFromMessage read as an
    // exact-replacement instruction targeting page 1.
    const poisonedQuote =
      'On page 1 I changed "the rabbit" into "the fly" for you.';
    const request = "Make the whole book warmer and simpler.";
    const proposalFor = async (payload: Record<string, unknown>) => {
      resetMobileHarness();
      mockAccessTokens({ "token-a": "user-a" });
      state.projectChatMessages.push({
        id: "chat-quoted",
        projectId: "project-1",
        parentId: null,
        role: "ASSISTANT",
        content: poisonedQuote,
        operationId: null,
        metadata: {},
        isActiveChild: true,
        createdAt: new Date("2026-06-15T11:00:00.000Z")
      });
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
        payload: { message: request, ...payload }
      });
      await app.close();
      return response.json().reply.metadata.editProposal;
    };

    const plain = await proposalFor({});
    const replied = await proposalFor({ replyToMessageId: "chat-quoted" });

    expect(plain).toBeTruthy();
    expect(replied.kind).toBe(plain.kind);
    expect(replied.scope).toBe(plain.scope);
    expect(replied.affectedPageIndexes).toEqual(plain.affectedPageIndexes);
    expect(replied.credits).toBe(plain.credits);
  });

  it("cancels a priced edit proposal without charging", async () => {
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
    expect(proposal.json().reply.metadata.editProposal.kind).toBe("page_rewrite");
    const proposalId = proposal.json().reply.metadata.editProposal.id as string;

    const cancel = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/proposals/cancel",
      headers: bearer("token-a"),
      payload: { proposalId }
    });
    const body = cancel.json();

    expect(cancel.statusCode).toBe(200);
    expect(body.operation).toBeNull();
    expect(body.reply.content).toContain("dropped that request");
    expect(body.reply.metadata).toMatchObject({ pendingEditCancelled: true, charged: false });
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    await app.close();
  });

  it.each(["COMPLETE", "REVIEW_REQUIRED"] as const)(
    "queues a %s continuation with its pre-edit project status",
    async (origin) => {
      mockAccessTokens({ "token-a": "user-a" });
      mockPrisma.project.findFirst.mockResolvedValue(
        projectRecord({
          id: "project-1",
          status: origin,
          currentPlanId: "plan-1",
          currentPlan: approvedPlanRecord(),
          pages: generatedPages()
        })
      );
      vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(
        jobRecord({ id: "job-continue", type: "CONTINUE_BOOK" })
      );
      const app = await buildMobileApp();

      const proposal = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/chat/messages",
        headers: bearer("token-a"),
        payload: { message: "Continue the story and add 2 more chapters" }
      });
      const proposalBody = proposal.json();

      expect(proposal.statusCode).toBe(200);
      expect(proposalBody.operation).toBeNull();
      expect(proposalBody.reply.content).toContain("2 new chapters");
      expect(proposalBody.reply.metadata).toMatchObject({
        charged: false,
        pendingEdit: { clarification: "confirm" },
        editProposal: {
          kind: "continue_book",
          affectedPageIndexes: [],
          // 2 chapters × 5 estimated pages × 80 credits/page.
          credits: 800
        }
      });
      expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();

      const confirm = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/chat/proposals/apply",
        headers: bearer("token-a"),
        payload: { proposalId: proposalBody.reply.metadata.editProposal.id }
      });
      const body = confirm.json();

      expect(confirm.statusCode).toBe(200);
      expect(body.operation).toMatchObject({ kind: "continue_book" });
      expect(vi.mocked(reserveCredits)).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "PAGE_REGENERATION", amountCredits: 800 })
      );
      expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "project-1",
          type: "CONTINUE_BOOK",
          payload: expect.objectContaining({
            chapterCount: 2,
            newPageCount: 10,
            planId: "plan-1",
            [PRE_EDIT_PROJECT_STATUS]: origin
          })
        })
      );
      await app.close();
    }
  );

  it("finds quoted edit targets with a database text search instead of loaded page bodies", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const pages = generatedPages();
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages
      })
    );
    // The quoted phrase lives only in page 2's markdown, which chat no longer
    // loads up front — the match must come from the contains query.
    state.pages = pages.map((page) => ({ ...page, projectId: "project-1", revision: 1 }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: 'Replace "learns to be kind" with "learns to be patient".' }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toBeNull();
    expect(body.reply.metadata).toMatchObject({
      editProposal: {
        kind: "local_patch",
        affectedPageIndexes: [2]
      }
    });
    expect(mockPrisma.page.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: "project-1",
          OR: expect.arrayContaining([{ markdown: { contains: "learns to be kind", mode: "insensitive" } }])
        })
      })
    );
    await app.close();
  });

});
