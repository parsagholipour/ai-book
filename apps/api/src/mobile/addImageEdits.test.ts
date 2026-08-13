import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { reserveCredits } from "@book-maker/db/billing";

import { PROPOSAL_GATED_EDIT_KINDS } from "../bookEditIntent.js";
import { enqueueGenerationJob } from "../queue.js";
import { addImageQuotaLimit } from "./addImageOperations.js";
import { operationQueuedMessage } from "./bookEditIntents.js";
import { UNDOABLE_EDIT_KINDS } from "./manualEdits.js";
import { pendingEditProposalFromMetadata } from "./pendingEditState.js";
import { serializeBookEditOperation } from "./projectChat.js";
import { currentActionForEditOperation } from "./projectSerializers.js";
import {
  applyProposal,
  completeProject,
  imageQuota,
  quotaAllowed,
  sendChat,
  withRouter,
  withTier
} from "./testing/addImageChatSupport.js";
import {
  appliedEditOperationRecord,
  approvedPlanRecord,
  bearer,
  buildMobileApp,
  generatedPages,
  jobRecord,
  mockAccessTokens,
  mockBilling,
  mockPrisma,
  openJobRow,
  projectRecord,
  resetMobileHarness,
  state,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";


describe("chat image insertion", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("proposes an end-of-book illustration card from the router decision, without the zero-page question", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    const app = await buildMobileApp(withRouter());

    const response = await sendChat(app, "Add a photo of a dragon at the end of the book");
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toBeNull();
    // Never the generic zero-page clarify: placement always has a default.
    expect(body.reply.content).not.toMatch(/which page or exact phrase/i);
    expect(body.reply.content).toMatch(/Tap Apply/);
    expect(body.reply.content).not.toMatch(/credits/i);
    expect(body.reply.metadata).toMatchObject({
      charged: false,
      pendingEdit: { clarification: "confirm" },
      editProposal: {
        kind: "add_image",
        scope: "explicit_pages",
        affectedPageIndexes: [2],
        credits: 45,
        summary: "Add an illustration of “a dragon” at the end of the book"
      }
    });
    expect(body.reply.metadata.pendingEdit.intent.imageEdit).toEqual({
      subject: "a dragon",
      placement: "end_of_book"
    });
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    await app.close();
  });

  it("targets the one page whose context mentions the subject when no placement is named", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    const app = await buildMobileApp(withRouter());

    const response = await sendChat(app, "Add a photo of the race");
    const body = response.json();

    expect(body.reply.metadata.editProposal).toMatchObject({
      kind: "add_image",
      affectedPageIndexes: [1],
      summary: "Add an illustration of “the race” on page 1"
    });
    await app.close();
  });

  it("keeps an explicit page placement even when the subject matches nothing", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    const app = await buildMobileApp(withRouter());

    const response = await sendChat(app, "insert an illustration of the castle on page 1");
    const body = response.json();

    expect(body.reply.metadata.editProposal).toMatchObject({
      kind: "add_image",
      affectedPageIndexes: [1],
      summary: "Add an illustration of “the castle” on page 1"
    });
    expect(body.reply.metadata.pendingEdit.intent.imageEdit).toEqual({
      subject: "the castle",
      placement: "page",
      pageIndex: 1
    });
    await app.close();
  });

  // Spelled out rather than derived from the price table: the proposal card is
  // the quote the reader approves, so a tier change has to be typed out here.
  for (const [tier, credits] of [
    ["fast", 45],
    ["balanced", 45],
    ["premium", 85]
  ] as const) {
    it(`quotes one ${tier} illustration at ${credits} credits`, async () => {
      mockAccessTokens({ "token-a": "user-a" });
      mockPrisma.project.findFirst.mockResolvedValue(completeProject(withTier(tier)));
      const app = await buildMobileApp(withRouter());

      const response = await sendChat(app, "Add a photo of a dragon at the end of the book");

      expect(response.json().reply.metadata.editProposal.credits).toBe(credits);
      await app.close();
    });
  }

  it("charges a book with no tier recorded at the balanced rate", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    const app = await buildMobileApp(withRouter());

    const response = await sendChat(app, "Add a photo of a dragon at the end of the book");

    expect(response.json().reply.metadata.editProposal.credits).toBe(45);
    await app.close();
  });

  it("applies the proposal: IMAGE_GENERATION reservation and the imageInsertion payload", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-image", type: "APPLY_BOOK_EDIT" }));
    const app = await buildMobileApp(withRouter());

    const proposal = await sendChat(app, "Add a photo of a dragon at the end of the book");
    const proposalId = proposal.json().reply.metadata.editProposal.id;

    const confirm = await applyProposal(app, proposalId);
    const body = confirm.json();

    expect(confirm.statusCode).toBe(200);
    expect(body.operation).toMatchObject({
      kind: "add_image",
      status: "queued",
      affectedPageIndexes: [2],
      creditsCharged: 45
    });
    expect(body.reply.content).not.toMatch(/credits/i);
    expect(body.reply.metadata.creditsCharged).toBe(45);
    expect(vi.mocked(reserveCredits)).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "IMAGE_GENERATION", amountCredits: 45 })
    );
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        type: "APPLY_BOOK_EDIT",
        payload: expect.objectContaining({
          intentKind: "add_image",
          affectedPageIndexes: [2],
          imageInsertion: { subject: "a dragon", placement: "end_of_book", targetPageIndex: 2 },
          planId: "plan-1",
          billingLedgerEntryId: expect.any(String)
        })
      })
    );
    // Paid tier (no quota object): no illustrated-book slot is touched.
    expect(mockBilling.consumeIllustratedBookUse).not.toHaveBeenCalled();
    await app.close();
  });

  describe("free-tier illustrated-book quota", () => {
    async function proposeAndApply() {
      const app = await buildMobileApp(withRouter());
      const proposal = await sendChat(app, "Add a photo of a dragon at the end of the book");
      const proposalId = proposal.json().reply.metadata.editProposal.id;
      const confirm = await applyProposal(app, proposalId);
      return { app, confirm };
    }

    it("claims a slot for the edit that turns a free text-only book illustrated", async () => {
      mockAccessTokens({ "token-a": "user-a" });
      mockPrisma.project.findFirst.mockResolvedValue(completeProject());
      mockBilling.getImageQuota.mockResolvedValue(imageQuota(0) as never);
      mockBilling.consumeIllustratedBookUse.mockResolvedValue(quotaAllowed);
      vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-image", type: "APPLY_BOOK_EDIT" }));

      const { app, confirm } = await proposeAndApply();

      expect(confirm.statusCode).toBe(200);
      expect(confirm.json().operation).toMatchObject({ kind: "add_image" });
      expect(mockBilling.consumeIllustratedBookUse).toHaveBeenCalledWith({ userId: "user-a", limit: 3 });
      await app.close();
    });

    it("claims nothing for a book already holding an inline illustration", async () => {
      mockAccessTokens({ "token-a": "user-a" });
      mockPrisma.project.findFirst.mockResolvedValue(completeProject());
      mockBilling.getImageQuota.mockResolvedValue(imageQuota(1) as never);
      vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-image", type: "APPLY_BOOK_EDIT" }));
      state.pages.push({
        id: "page-1",
        projectId: "project-1",
        index: 1,
        title: "Rabbit Starts Fast",
        markdown: "Rabbit runs.\n\n![Scene](/assets/images/project-1/page-1.png)",
        summary: "Rabbit starts.",
        revision: 1
      });

      const { app, confirm } = await proposeAndApply();

      expect(confirm.statusCode).toBe(200);
      expect(confirm.json().operation).toMatchObject({ kind: "add_image" });
      expect(mockBilling.consumeIllustratedBookUse).not.toHaveBeenCalled();
      await app.close();
    });

    it("still claims when a page pastes another project's asset path", async () => {
      // Only a ref shaped exactly /assets/images/<thisProjectId>/<filename>
      // counts as this book's illustration; pasted text naming any other
      // project (or a traversal) does not spend the slot decision.
      mockAccessTokens({ "token-a": "user-a" });
      mockPrisma.project.findFirst.mockResolvedValue(completeProject());
      mockBilling.getImageQuota.mockResolvedValue(imageQuota(0) as never);
      mockBilling.consumeIllustratedBookUse.mockResolvedValue(quotaAllowed);
      vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-image", type: "APPLY_BOOK_EDIT" }));
      state.pages.push({
        id: "page-1",
        projectId: "project-1",
        index: 1,
        title: "Rabbit Starts Fast",
        markdown:
          "![Scene](/assets/images/anything/whatever.png)\n\n![Climb](/assets/images/project-1/../project-2/art.png)",
        summary: "Rabbit starts.",
        revision: 1
      });

      const { app, confirm } = await proposeAndApply();

      expect(confirm.statusCode).toBe(200);
      expect(mockBilling.consumeIllustratedBookUse).toHaveBeenCalledWith({ userId: "user-a", limit: 3 });
      await app.close();
    });

    it("still claims when a page merely mentions the asset path in prose", async () => {
      mockAccessTokens({ "token-a": "user-a" });
      mockPrisma.project.findFirst.mockResolvedValue(completeProject());
      mockBilling.getImageQuota.mockResolvedValue(imageQuota(0) as never);
      mockBilling.consumeIllustratedBookUse.mockResolvedValue(quotaAllowed);
      vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-image", type: "APPLY_BOOK_EDIT" }));
      state.pages.push({
        id: "page-1",
        projectId: "project-1",
        index: 1,
        title: "Rabbit Starts Fast",
        markdown: "See /assets/images/project-1/page-1.png for details.",
        summary: "Rabbit starts.",
        revision: 1
      });

      const { app, confirm } = await proposeAndApply();

      expect(confirm.statusCode).toBe(200);
      expect(mockBilling.consumeIllustratedBookUse).toHaveBeenCalledWith({ userId: "user-a", limit: 3 });
      await app.close();
    });

    it("claims nothing for a book whose approved illustrations all failed to render", async () => {
      mockAccessTokens({ "token-a": "user-a" });
      mockPrisma.project.findFirst.mockResolvedValue(completeProject());
      mockBilling.getImageQuota.mockResolvedValue(imageQuota(1) as never);
      mockPrisma.page.findFirst.mockResolvedValue({ id: "page-1" });
      vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-image", type: "APPLY_BOOK_EDIT" }));

      const { app, confirm } = await proposeAndApply();

      expect(confirm.statusCode).toBe(200);
      expect(mockBilling.consumeIllustratedBookUse).not.toHaveBeenCalled();
      await app.close();
    });

    it("claims nothing when a prior applied ADD_IMAGE already spent the book's slot (add, undo, add)", async () => {
      mockAccessTokens({ "token-a": "user-a" });
      mockPrisma.project.findFirst.mockResolvedValue(completeProject());
      mockBilling.getImageQuota.mockResolvedValue(imageQuota(1) as never);
      vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-image", type: "APPLY_BOOK_EDIT" }));
      state.bookEditOperations.push(
        appliedEditOperationRecord({ id: "operation-earlier-image", kind: "ADD_IMAGE", requestId: "earlier-request" })
      );

      const { app, confirm } = await proposeAndApply();

      expect(confirm.statusCode).toBe(200);
      expect(mockBilling.consumeIllustratedBookUse).not.toHaveBeenCalled();
      await app.close();
    });

    it("never claims for a zero-priced image, which would leak the slot on failure", async () => {
      await expect(addImageQuotaLimit("user-a", "project-1", 0)).resolves.toBeNull();
      expect(mockBilling.getImageQuota).not.toHaveBeenCalled();
    });

    it("answers a spent limit with a resumable card whose fresh proposalId works after upgrading", async () => {
      mockAccessTokens({ "token-a": "user-a" });
      mockPrisma.project.findFirst.mockResolvedValue(completeProject());
      mockBilling.getImageQuota.mockResolvedValueOnce(imageQuota(3) as never);
      mockBilling.consumeIllustratedBookUse.mockResolvedValueOnce({
        allowed: false,
        used: 3,
        limit: 3,
        periodKey: "2026-08",
        resetsAt: new Date("2026-09-01T00:00:00.000Z")
      });
      vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-image", type: "APPLY_BOOK_EDIT" }));

      const { app, confirm } = await proposeAndApply();
      const blocked = confirm.json();

      expect(confirm.statusCode).toBe(200);
      expect(blocked.operation).toBeNull();
      expect(blocked.reply.content).toMatch(/illustrated book/i);
      expect(blocked.reply.content).toMatch(/upgrade/i);
      expect(blocked.reply.content).not.toMatch(/credits/i);
      expect(blocked.reply.metadata.imageLimit).toEqual({
        used: 3,
        limit: 3,
        resetsAt: "2026-09-01T00:00:00.000Z"
      });
      expect(blocked.reply.metadata.pendingEdit.clarification).toBe("confirm");
      const freshProposalId = blocked.reply.metadata.editProposal.id;
      expect(typeof freshProposalId).toBe("string");
      // Nothing was reserved: the quota refusal precedes the reservation.
      expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();

      // After upgrading (no quota object any more) the fresh card's Apply runs.
      const retried = await applyProposal(app, freshProposalId);
      const body = retried.json();

      expect(retried.statusCode).toBe(200);
      expect(body.operation).toMatchObject({ kind: "add_image", status: "queued" });
      expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "APPLY_BOOK_EDIT",
          payload: expect.objectContaining({
            intentKind: "add_image",
            imageInsertion: { subject: "a dragon", placement: "end_of_book", targetPageIndex: 2 }
          })
        })
      );
      await app.close();
    });
  });

  it("re-proposes instead of charging past the quoted ceiling", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    // A card quoted below today's price: the book's tier moved after the card.
    state.projectChatMessages.push(
      {
        id: "chat-user-old",
        projectId: "project-1",
        role: "USER",
        content: "Add a photo of a dragon at the end of the book",
        operationId: null,
        metadata: {},
        createdAt: new Date("2026-06-15T11:00:00.000Z")
      },
      {
        id: "chat-assistant-old",
        projectId: "project-1",
        role: "ASSISTANT",
        content: "Add an illustration of “a dragon” at the end of the book. Tap Apply to confirm, or Cancel to drop it.",
        operationId: null,
        metadata: {
          pendingEdit: {
            request: "Add a photo of a dragon at the end of the book",
            clarification: "confirm",
            proposalId: "6f3f9a3e-8f6b-4a2e-9a3f-2b1c4d5e6f70",
            affectedPageIndexes: [2],
            credits: 10,
            intent: {
              kind: "add_image",
              confidence: 0.95,
              reasoning: "r",
              assistantMessage: "x",
              affectedPageIndexes: [2],
              scope: "explicit_pages",
              impact: "small_text",
              clarification: "none",
              imageEdit: { subject: "a dragon", placement: "end_of_book" }
            }
          },
          editProposal: {
            id: "6f3f9a3e-8f6b-4a2e-9a3f-2b1c4d5e6f70",
            kind: "add_image",
            scope: "explicit_pages",
            affectedPageIndexes: [2],
            credits: 10,
            summary: "Add an illustration of “a dragon” at the end of the book"
          }
        },
        createdAt: new Date("2026-06-15T11:01:00.000Z")
      }
    );
    const app = await buildMobileApp(withRouter());

    const response = await applyProposal(app, "6f3f9a3e-8f6b-4a2e-9a3f-2b1c4d5e6f70");
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toBeNull();
    expect(body.reply.metadata.editProposal).toMatchObject({ kind: "add_image", credits: 45 });
    expect(body.reply.metadata.editProposal.id).not.toBe("6f3f9a3e-8f6b-4a2e-9a3f-2b1c4d5e6f70");
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  it("deflects Apply while the book is busy and resumes the same priced proposal later", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-image", type: "APPLY_BOOK_EDIT" }));
    const app = await buildMobileApp(withRouter());

    const proposal = await sendChat(app, "Add a photo of a dragon at the end of the book");
    const proposalId = proposal.json().reply.metadata.editProposal.id;

    mockPrisma.generationJob.findMany.mockResolvedValueOnce([openJobRow()]);
    const deflected = await applyProposal(app, proposalId);
    const deflectedBody = deflected.json();

    expect(deflected.statusCode).toBe(200);
    expect(deflectedBody.operation).toBeNull();
    expect(deflectedBody.reply.metadata).toMatchObject({
      blockedByActiveJob: true,
      pendingEdit: { clarification: "busy", proposalId }
    });
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();

    const resumed = await sendChat(app, "apply it");
    const body = resumed.json();

    expect(resumed.statusCode).toBe(200);
    expect(body.operation).toMatchObject({ kind: "add_image", affectedPageIndexes: [2] });
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "APPLY_BOOK_EDIT",
        payload: expect.objectContaining({
          imageInsertion: { subject: "a dragon", placement: "end_of_book", targetPageIndex: 2 }
        })
      })
    );
    await app.close();
  });

  it("routes an image request on a still-generating book to a plan revision", async () => {
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
    vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-revision", type: "REVISE_PLAN" }));
    const app = await buildMobileApp(withRouter());

    const response = await sendChat(app, "Add a photo of a dragon at the end of the book");
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.operation).toMatchObject({ kind: "plan_revision" });
    expect(body.reply.metadata.editProposal).toBeUndefined();
    await app.close();
  });
});

describe("add_image resume rebuild", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  const pendingBase = {
    clarification: "confirm",
    proposalId: "proposal-1",
    affectedPageIndexes: [2],
    credits: 45
  };

  function rebuild(imageEdit: unknown) {
    return pendingEditProposalFromMetadata(
      {},
      {
        ...pendingBase,
        intent: {
          kind: "add_image",
          scope: "explicit_pages",
          impact: "small_text",
          clarification: "none",
          affectedPageIndexes: [2],
          imageEdit
        }
      },
      "Add a photo of a dragon"
    );
  }

  it("rebuilds an add_image proposal with its imageEdit intact", () => {
    const proposal = rebuild({ subject: "a dragon", placement: "page", pageIndex: 2 });

    expect(proposal.proposalId).toBe("proposal-1");
    expect(proposal.credits).toBe(45);
    expect(proposal.intent).toMatchObject({
      kind: "add_image",
      imageEdit: { subject: "a dragon", placement: "page", pageIndex: 2 }
    });
  });

  it("drops malformed placement and pageIndex values but keeps the subject", () => {
    expect(rebuild({ subject: "a dragon", placement: "cover", pageIndex: 2 }).intent?.imageEdit).toEqual({
      subject: "a dragon"
    });
    expect(rebuild({ subject: "a dragon", placement: "page", pageIndex: "two" }).intent?.imageEdit).toEqual({
      subject: "a dragon",
      placement: "page"
    });
    expect(rebuild({ subject: "a dragon", placement: "end_of_book", pageIndex: -3 }).intent?.imageEdit).toEqual({
      subject: "a dragon",
      placement: "end_of_book"
    });
  });

  it("drops the whole imageEdit when the subject is unusable", () => {
    expect(rebuild({ subject: 42, placement: "page", pageIndex: 2 }).intent?.imageEdit).toBeUndefined();
    expect(rebuild(null).intent?.imageEdit).toBeUndefined();
  });

  it("round-trips a replacement, dropping a malformed one to a plain add", () => {
    expect(
      rebuild({ subject: "a castle", replace: { operationId: "op-old", oldSubject: "a dragon" } }).intent?.imageEdit
    ).toEqual({ subject: "a castle", replace: { operationId: "op-old", oldSubject: "a dragon" } });
    expect(rebuild({ subject: "a castle", replace: { operationId: "op-old" } }).intent?.imageEdit).toEqual({
      subject: "a castle",
      replace: { operationId: "op-old" }
    });
    // A resume that lost the target must not silently add a second picture as
    // a *replacement*; it degrades to a plain add, visible on the card.
    expect(rebuild({ subject: "a castle", replace: { operationId: 42 } }).intent?.imageEdit).toEqual({
      subject: "a castle"
    });
    expect(rebuild({ subject: "a castle", replace: "op-old" }).intent?.imageEdit).toEqual({ subject: "a castle" });
    expect(
      rebuild({
        subject: "a more aggressive fox",
        replace: { operationId: "", assetId: "asset-1", oldSubject: "the illustration on page 1" }
      }).intent?.imageEdit
    ).toEqual({
      subject: "a more aggressive fox",
      replace: { operationId: "", assetId: "asset-1", oldSubject: "the illustration on page 1" }
    });
  });
});

describe("add_image presentation", () => {
  it("names the running operation as illustration work", () => {
    expect(
      currentActionForEditOperation(
        appliedEditOperationRecord({ kind: "ADD_IMAGE", status: "ACTIVE", appliedAt: null }) as never
      )
    ).toBe("Creating your illustration.");
  });

  it("keeps an applied image insertion undoable", () => {
    expect(UNDOABLE_EDIT_KINDS).toContain("ADD_IMAGE");
  });

  it("says what the finished edit did, not just that it is done", () => {
    // The card used to read "Edit applied." for every kind, so the one line
    // the reader gets after paying said the least of anything in the turn.
    const applied = (overrides: Record<string, unknown>) =>
      currentActionForEditOperation(appliedEditOperationRecord(overrides) as never);

    expect(applied({ kind: "ADD_IMAGE" })).toBe("New illustration on page 1.");
    // The worker records what it swapped out; that is the only thing that
    // separates a replacement from a picture the book did not have before.
    expect(
      applied({ kind: "ADD_IMAGE", classifier: { previousAsset: { id: "asset-1" } } })
    ).toBe("Illustration replaced on page 1.");
    expect(applied({ kind: "PAGE_REWRITE", affectedPageIndexes: [2, 3] })).toBe("Pages 2 and 3 rewritten.");
    expect(applied({ kind: "CONTINUE_BOOK", affectedPageIndexes: [] })).toBe("New chapters added.");
    expect(applied({ kind: "PLAN_REVISION", affectedPageIndexes: [] })).toBe("Plan revised.");
    expect(applied({ kind: "LOCAL_PATCH" })).toBe("Edit applied.");
  });

  it("names no page when the edit recorded none", () => {
    // `describeEditPages([])` answers "the selected pages", which is a fine
    // fallback mid-sentence and nonsense as a statement of what just happened.
    expect(
      currentActionForEditOperation(
        appliedEditOperationRecord({ kind: "ADD_IMAGE", affectedPageIndexes: [] }) as never
      )
    ).toBe("New illustration.");
  });

  it("still explains pages it had to skip", () => {
    expect(
      currentActionForEditOperation(
        appliedEditOperationRecord({
          kind: "ADD_IMAGE",
          classifier: { previousAsset: { id: "asset-1" }, skippedPageIndexes: [4] }
        }) as never
      )
    ).toBe(
      "Illustration replaced on page 1. Page 4 no longer contained that text and was left unchanged."
    );
  });

  it("serializes add_image and continue_book operations under their own DTO kinds", () => {
    expect(serializeBookEditOperation(appliedEditOperationRecord({ kind: "ADD_IMAGE" }) as never).kind).toBe(
      "add_image"
    );
    expect(serializeBookEditOperation(appliedEditOperationRecord({ kind: "CONTINUE_BOOK" }) as never).kind).toBe(
      "continue_book"
    );
  });

  it("says the card's destination in the queued reply", () => {
    const intent = (imageEdit: Record<string, unknown>, affectedPageIndexes: number[]) =>
      ({
        kind: "add_image",
        confidence: 0.95,
        reasoning: "r",
        assistantMessage: "a",
        affectedPageIndexes,
        scope: "explicit_pages",
        impact: "small_text",
        clarification: "none",
        imageEdit
      }) as never;

    expect(
      operationQueuedMessage("add_image", [2], intent({ subject: "a dragon", placement: "end_of_book" }, [2]))
    ).toBe("I’m creating that illustration now and adding it at the end of the book, then I’ll refresh the exports.");
    expect(
      operationQueuedMessage(
        "add_image",
        [1],
        intent({ subject: "a dragon", placement: "page", pageIndex: 1 }, [1])
      )
    ).toBe("I’m creating that illustration now and adding it to page 1, then I’ll refresh the exports.");
    expect(
      operationQueuedMessage(
        "add_image",
        [2],
        intent(
          { subject: "a castle", placement: "page", pageIndex: 2, replace: { operationId: "op-old" } },
          [2]
        )
      )
    ).toBe("I’m creating that illustration now and replacing the one on page 2, then I’ll refresh the exports.");
  });
});

describe("proposal resume allowlist", () => {
  it("derives the resumable kinds from the proposal-gated set plus plan_revision", () => {
    for (const kind of [...PROPOSAL_GATED_EDIT_KINDS, "plan_revision"]) {
      const proposal = pendingEditProposalFromMetadata(
        {},
        {
          clarification: "confirm",
          proposalId: "proposal-kind",
          affectedPageIndexes: [1],
          credits: 10,
          intent: { kind }
        },
        "request"
      );
      expect(proposal.intent?.kind).toBe(kind);
    }
  });
});
