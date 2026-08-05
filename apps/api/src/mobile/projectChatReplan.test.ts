import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { reserveCredits } from "@book-maker/db/billing";

import { enqueueGenerationJob } from "../queue.js";
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

  it("proposes a completed-book structural character change as a book replan", async () => {
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
      summary: "Rebuild as a new 3-page copy without illustrations",
      // The 12-page illustrated book quotes 851; this is the book asked for.
      credits: 644
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
    expect(vi.mocked(reserveCredits)).toHaveBeenCalledWith(expect.objectContaining({ amountCredits: 644 }));
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

});
