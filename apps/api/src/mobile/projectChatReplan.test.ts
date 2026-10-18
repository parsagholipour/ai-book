import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { grantProjectEntitlement, hasActiveSubscriptionEntitlement, reserveCredits } from "@book-maker/db/billing";

import { enqueueGenerationJob } from "../queue.js";
import { fakeDecideModel } from "../testing/bookEditIntentFixtures.js";
import { replanCopyBookMatter } from "./projectRecords.js";
import {
  approvedPlanRecord,
  bearer,
  buildMobileApp,
  creationDraftRecord,
  generatedPages,
  jobRecord,
  mockAccessTokens,
  mockPrisma,
  projectRecord,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

/**
 * A whole-book replan is the one chat edit that does not touch the book it was
 * asked about: it builds a copy and rebuilds that. These cover what the copy is
 * built from — the settings the request named, at the price they were quoted at.
 */
describe("mobile project chat book replan", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it.each([
    ["a subscriber", true],
    ["a free reader", false]
  ])("charges %s's rebuild once, at the price its card showed, with no export unlock and no grant", async (_reader, paid) => {
    // The copy is a new generated book, priced the way plan approval prices
    // one: a single charge, the same for every reader, and its finished file
    // downloads free (2026-10-15).
    mockAccessTokens({ "token-a": "user-a" });
    vi.mocked(hasActiveSubscriptionEntitlement).mockResolvedValue(paid);
    mockPrisma.project.findFirst.mockResolvedValue(projectRecord({
      status: "COMPLETE", currentPlanId: "plan-1", currentPlan: approvedPlanRecord(), pages: generatedPages()
    }));
    vi.mocked(enqueueGenerationJob).mockResolvedValue(
      jobRecord({ id: "job-replan", projectId: "project-copy", type: "REPLAN_BOOK" })
    );
    const app = await buildMobileApp();
    try {
      const proposal = await app.inject({
        method: "POST", url: "/api/mobile/projects/project-1/chat/messages", headers: bearer("token-a"),
        payload: { message: "Generate again" }
      });
      expect(proposal.statusCode).toBe(200);
      const card = proposal.json().reply.metadata.editProposal;
      expect(card.kind).toBe("book_replan");
      // 12 pages, 2 interior illustrations and a cover at balanced, plus the
      // 120 rebuild base, whoever asks.
      expect(card.credits).toBe(120 + 250 + 12 * 8 + 3 * 70);

      const apply = () => app.inject({
        method: "POST", url: "/api/mobile/projects/project-1/chat/proposals/apply", headers: bearer("token-a"),
        payload: { proposalId: card.id }
      });
      const first = await apply();
      expect(first.statusCode).toBe(200);
      expect(first.json().operation.kind).toBe("book_replan");
      expect(reserveCredits).toHaveBeenCalledWith(expect.objectContaining({
        operation: "BOOK_REPLAN", amountCredits: card.credits
      }));
      // The charge carries its itemised quote, the way plan approval's does, so a
      // delete of the copy mid-run keeps only what the copy delivered (launch review H3).
      const charge = vi.mocked(reserveCredits).mock.calls[0]![0] as { metadata: { creditEstimate?: Record<string, any> } };
      expect(charge.metadata.creditEstimate).toMatchObject({ totalCredits: card.credits });
      expect(charge.metadata.creditEstimate!.lineItems[0]).toMatchObject({ code: "BOOK_REPLAN" });
      const lines = charge.metadata.creditEstimate!.lineItems as Array<{ code: string; credits: number }>;
      expect(lines.reduce((total, line) => total + line.credits, 0)).toBe(card.credits);
      expect(lines.map((line) => line.code)).not.toContain("EXPORT_UNLOCK");

      // A second Apply replays the first: still one charge, still no grant.
      expect((await apply()).statusCode).toBe(200);
      expect(reserveCredits).toHaveBeenCalledTimes(1);
      expect(mockPrisma.project.create).toHaveBeenCalledTimes(1);
      expect(grantProjectEntitlement).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each(["available", "unavailable"])("quotes Generate again and waits for Apply with the router %s", async (availability) => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(projectRecord({
      id: "project-1",
      status: "COMPLETE",
      currentPlanId: "plan-1",
      currentPlan: approvedPlanRecord(),
      pages: generatedPages()
    }));
    const routingTextModel = fakeDecideModel({
      action: "answer",
      confidence: 0.85,
      reasoning: "Generate again is ambiguous and not a specific change request.",
      assistantMessage: "I'm not sure what you'd like me to regenerate.",
      clarification: "none",
      pageIndexes: [],
      chapterIndex: null,
      targetLanguage: null
    });
    routingTextModel.generateText = vi.fn(async () => ({
      text: "I've regenerated the content. Here's the updated version with fresh prose for each page.",
      model: "test-router",
      provider: "test"
    }));
    const app = await buildMobileApp(availability === "available" ? { routingTextModel } : {});
    const proposal = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Generate again" }
    });
    expect(proposal.statusCode).toBe(200);
    const body = proposal.json();
    expect(body.operation).toBeNull();
    expect(body.reply.metadata).toMatchObject({
      editProposal: { kind: "book_replan", credits: expect.any(Number) },
      pendingEdit: { clarification: "confirm" }
    });
    const quotedCredits = body.reply.metadata.editProposal.credits;
    expect(quotedCredits).toBeGreaterThan(0);
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(enqueueGenerationJob).not.toHaveBeenCalled();
    expect(mockPrisma.project.create).not.toHaveBeenCalled();
    expect(routingTextModel.generateText).not.toHaveBeenCalled();

    const confirmation = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "apply it" }
    });
    expect(confirmation.statusCode).toBe(200);
    expect(confirmation.json().operation.kind).toBe("book_replan");
    expect(reserveCredits).toHaveBeenCalledWith(expect.objectContaining({ amountCredits: quotedCredits }));
    expect(enqueueGenerationJob).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-copy",
      type: "REPLAN_BOOK",
      payload: expect.objectContaining({
        sourceProjectId: "project-1",
        sourcePlanId: "plan-1",
        editInstruction: expect.stringMatching(/Regenerate the entire book/)
      })
    }));
    await app.close();
  });

  it("proposes a completed-book structural character change as a book replan", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        bookMatter: { dedication: "For Sara", isbn: "978-0-00-000000-0" },
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages()
      })
    );
    mockPrisma.mobileCreationOutput.findFirst.mockResolvedValueOnce({
      id: "output-source",
      draftId: "draft-1",
      projectId: "project-1",
      title: "Owned Book",
      sequence: 1,
      createdAt: new Date("2026-06-15T12:00:00.000Z"),
      updatedAt: new Date("2026-06-15T12:00:00.000Z"),
      draft: creationDraftRecord({
        id: "draft-1",
        createdProjectId: "project-1",
        outputs: [
          {
            id: "output-source",
            draftId: "draft-1",
            projectId: "project-1",
            title: "Owned Book",
            sequence: 1,
            createdAt: new Date("2026-06-15T12:00:00.000Z"),
            updatedAt: new Date("2026-06-15T12:00:00.000Z"),
            project: { title: "Owned Book", updatedAt: new Date("2026-06-15T12:00:00.000Z") }
          }
        ]
      })
    });
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(
      jobRecord({ id: "job-replan", projectId: "project-copy", type: "REPLAN_BOOK" })
    );
    const app = await buildMobileApp();

    const proposal = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Change the character of rabbit with a fly." }
    });
    const proposalBody = proposal.json();

    expect(proposal.statusCode).toBe(200);
    expect(proposalBody.operation).toBeNull();
    expect(proposalBody.reply.metadata).toMatchObject({
      editProposal: { kind: "book_replan" },
      pendingEdit: { clarification: "confirm" }
    });
    expect(proposalBody.reply.content).toContain("new copy");
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
      kind: "book_replan",
      affectedPageIndexes: []
    });
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-copy",
        type: "REPLAN_BOOK",
        payload: expect.objectContaining({
          sourceProjectId: "project-1",
          sourcePlanId: "plan-1",
          affectedPageIndexes: [],
          intentKind: "book_replan"
        })
      })
    );
    expect(mockPrisma.project.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-a",
          title: "Owned Book (Revised)",
          status: "EDITING",
          // The rebuilt book keeps its dedication and publication details.
          bookMatter: { dedication: "For Sara", isbn: "978-0-00-000000-0" },
          mediaSettings: expect.objectContaining({
            mobile: expect.objectContaining({
              revisionOfProjectId: "project-1",
              revisionOperationId: "operation-1",
              revisionSource: "project_chat_book_replan"
            })
          })
        })
      })
    );
    expect(mockPrisma.mobileCreationOutput.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          draftId: "draft-1",
          projectId: "project-copy",
          sequence: 2
        })
      })
    );
    expect(mockPrisma.mobileCreationDraft.update).toHaveBeenCalledWith({
      where: { id: "draft-1" },
      data: { createdProjectId: "project-copy", status: "ACTIVE" }
    });
    expect(mockPrisma.project.update).not.toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { status: "EDITING" }
    });
    expect(body.reply.content).toContain("new copy");
    expect(body.reply.content).toContain("stays unchanged");
    await app.close();
  });

  it("rebuilds the copy at the length and without the illustrations the request named", async () => {
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
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(
      jobRecord({ id: "job-replan", projectId: "project-copy", type: "REPLAN_BOOK" })
    );
    const app = await buildMobileApp();

    const proposal = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "It's too much talking. I think we should make it 3 pages without illustrations" }
    });
    const proposalBody = proposal.json();

    expect(proposal.statusCode).toBe(200);
    // The card is the last thing shown before the charge, so it has to name the
    // settings — "regenerate the book as a new copy" reads identically whether
    // the request was understood or dropped.
    expect(proposalBody.reply.metadata.editProposal).toMatchObject({
      kind: "book_replan",
      summary:
        "Rebuild as a new 3-page copy without illustrations: It's too much talking. I think we should make it 3 pages without illustrations",
      // The 12-page illustrated book quotes 676 to a free reader; this is the
      // book asked for, without the export unlock a free reader's price leaves out.
      credits: 464
    });

    const confirm = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "apply it" }
    });

    expect(confirm.statusCode).toBe(200);
    // Charged what was quoted: the settings have to survive the round trip
    // through the stored proposal, or Apply prices the old book again.
    expect(vi.mocked(reserveCredits)).toHaveBeenCalledWith(expect.objectContaining({ amountCredits: 464 }));
    expect(mockPrisma.project.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          targetPages: 3,
          mediaSettings: expect.objectContaining({
            fullIllustrations: false,
            illustrationCadence: "manual",
            // "without illustrations" is not "without a cover".
            includeCover: true,
            mobile: expect.objectContaining({ imagesEnabled: true, targetPages: 3, pageCountSource: "chat" })
          })
        })
      })
    );
    // The worker revises the *source* plan's input snapshot, so the number has
    // to travel in the payload or the rebuilt book comes out at 12 pages again.
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "REPLAN_BOOK",
        payload: expect.objectContaining({ targetPages: 3 })
      })
    );
    await app.close();
  });

  it("keeps the page design the source book wears on the rebuilt copy", async () => {
    // The media-settings schema strips the key, and a series pins it there.
    mockAccessTokens({ "token-a": "user-a" });
    const source = projectRecord({
      id: "project-1",
      status: "COMPLETE",
      currentPlanId: "plan-1",
      currentPlan: approvedPlanRecord(),
      pages: generatedPages()
    });
    mockPrisma.project.findFirst.mockResolvedValue({ ...source, mediaSettings: { ...(source.mediaSettings as object), storyPageDesign: "night" } });
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-replan", projectId: "project-copy", type: "REPLAN_BOOK" }));
    const app = await buildMobileApp();
    for (const message of ["It's too much talking. I think we should make it 3 pages without illustrations", "apply it"]) {
      const response = await app.inject({ method: "POST", url: "/api/mobile/projects/project-1/chat/messages", headers: bearer("token-a"), payload: { message } });
      expect(response.statusCode).toBe(200);
    }

    expect(mockPrisma.project.create.mock.calls.at(-1)![0].data.mediaSettings).toMatchObject({ storyPageDesign: "night" });
    await app.close();
  });

  it("proposes a completed-book English language version as a new copy", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        title: "Encontros em Lisboa",
        language: "pt",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages()
      })
    );
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(
      jobRecord({ id: "job-replan", projectId: "project-copy", type: "REPLAN_BOOK" })
    );
    const app = await buildMobileApp();

    const proposal = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Now generate the English version" }
    });
    const proposalBody = proposal.json();

    expect(proposal.statusCode).toBe(200);
    expect(proposalBody.operation).toBeNull();
    expect(proposalBody.reply.metadata).toMatchObject({
      editProposal: {
        kind: "book_replan",
        targetLanguage: "en"
      },
      pendingEdit: { clarification: "confirm" }
    });
    expect(proposalBody.reply.content).toContain("English");
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();

    const confirm = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "yes" }
    });
    const body = confirm.json();

    expect(confirm.statusCode).toBe(200);
    expect(body.operation).toMatchObject({
      kind: "book_replan",
      affectedPageIndexes: []
    });
    expect(mockPrisma.bookEditOperation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceProjectId: "project-1",
          classifier: expect.objectContaining({
            kind: "book_replan",
            targetLanguage: "en"
          })
        })
      })
    );
    expect(mockPrisma.project.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: "Encontros em Lisboa (Revised)",
          language: "en",
          status: "EDITING",
          mediaSettings: expect.objectContaining({
            mobile: expect.objectContaining({
              revisionOfProjectId: "project-1",
              revisionTargetLanguage: "en"
            })
          })
        })
      })
    );
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-copy",
        type: "REPLAN_BOOK",
        payload: expect.objectContaining({
          sourceProjectId: "project-1",
          sourcePlanId: "plan-1",
          targetLanguage: "en",
          intentKind: "book_replan"
        })
      })
    );
    expect(mockPrisma.project.update).not.toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { status: "EDITING" }
    });
    expect(body.reply.content).toContain("English copy");
    await app.close();
  });

  it("leaves the dedication and the biography behind when the copy is rebuilt in another language", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        language: "en",
        status: "COMPLETE",
        bookMatter: {
          dedication: "For my mother",
          aboutAuthor: "Sam Lee writes about the sea.",
          isbn: "978-0-00-000000-0",
          imprint: "Lantern Press",
          allRightsReserved: true
        },
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages()
      })
    );
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(
      jobRecord({ id: "job-replan", projectId: "project-copy", type: "REPLAN_BOOK" })
    );
    const app = await buildMobileApp();

    const proposal = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Now generate the Spanish version" }
    });
    expect(proposal.json().reply.metadata.editProposal).toMatchObject({ kind: "book_replan", targetLanguage: "Spanish" });

    const confirm = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "yes" }
    });

    expect(confirm.statusCode).toBe(200);
    // The Spanish copy prints "Sobre el autor" and a Spanish matter sheet, and
    // nothing translates the reader's own prose under them — so only the fields
    // that read the same in any language come across.
    expect(mockPrisma.project.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          language: "Spanish",
          bookMatter: { isbn: "978-0-00-000000-0", imprint: "Lantern Press", allRightsReserved: true }
        })
      })
    );
    expect(confirm.json().reply.content).toContain(
      "Your dedication and About the Author weren’t copied, so nothing prints untranslated — add them in Spanish"
    );
    await app.close();
  });
});

describe("replanCopyBookMatter", () => {
  const matter = { dedication: "For Sara", aboutAuthor: "Sam writes.", isbn: "978-0-00-000000-0" };

  it("carries the matter verbatim when the copy keeps the book's language", () => {
    expect(replanCopyBookMatter({ language: "en", bookMatter: matter }, null)).toEqual({ bookMatter: matter, withheld: [] });
    // A code and a name for one language are the same language.
    expect(replanCopyBookMatter({ language: "en", bookMatter: matter }, "English")).toEqual({ bookMatter: matter, withheld: [] });
    expect(replanCopyBookMatter({ language: "es", bookMatter: matter }, "Spanish")).toEqual({ bookMatter: matter, withheld: [] });
  });

  it("writes no matter at all when a translation leaves nothing language-neutral", () => {
    expect(replanCopyBookMatter({ language: "Persian", bookMatter: { dedication: "برای مادرم" } }, "en")).toEqual({
      bookMatter: undefined,
      withheld: ["dedication"]
    });
    expect(replanCopyBookMatter({ language: "en", bookMatter: null }, "Spanish")).toEqual({ bookMatter: undefined, withheld: [] });
  });
});
