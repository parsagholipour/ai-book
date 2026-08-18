import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { PRE_EDIT_PROJECT_STATUS } from "@book-maker/core";
import { revertStructuralPageChange } from "@book-maker/db";

import { enqueueGenerationJob } from "../queue.js";
import { bookEditCreditCost } from "./bookEditPricing.js";
import {
  appliedEditOperationRecord,
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

/**
 * Insert, delete and reorder, end to end through the chat.
 *
 * The path these have to survive is the one every other proposal skips:
 * `affectedPagesForIntent` filters against pages that currently exist, so a
 * structural edit that reaches it is answered "which page or exact phrase
 * should I edit?" — for pages it was about to create.
 */
describe("structural page edits in the chat", () => {
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

  const send = async (app: Awaited<ReturnType<typeof buildMobileApp>>, message: string) =>
    app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message }
    });

  it("proposes an insertion as a card priced per new page, not as a whole-book replan", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const project = completeProject();
    mockPrisma.project.findFirst.mockResolvedValue(project);
    // No router model: this is the degraded path, which is exactly where the
    // request used to become a book_replan into a brand new project.
    const app = await buildMobileApp();

    const response = await send(app, "Add 2 pages after page 1.");
    const proposal = response.json().reply.metadata.editProposal;

    expect(response.statusCode).toBe(200);
    expect(proposal).toMatchObject({ kind: "restructure_pages" });
    expect(proposal.summary).toBe("Add 2 new pages after page 1");
    // Two pages of writing at the book's own tier — the same rate a
    // continuation pays for the pages it appends.
    expect(proposal.credits).toBe(bookEditCreditCost("restructure_pages", 2, project as never));
    expect(proposal.structural).toMatchObject({ action: "insert", pageCount: 2, totalPages: 4 });
    await app.close();
  });

  it("charges nothing for a delete and says how the book changes", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    const app = await buildMobileApp();

    const proposal = (await send(app, "Delete page 2.")).json().reply.metadata.editProposal;

    // No model is asked anything, so there is nothing to bill — the same
    // reasoning that prices move_image and remove_image at zero.
    expect(proposal).toMatchObject({ kind: "restructure_pages", credits: 0 });
    expect(proposal.summary).toBe("Remove page 2");
    await app.close();
  });

  it("says the same printed page number in the bubble as on the card", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    // Cover unnumbered, Contents printed 1: printed 3 is model page 2. The
    // bubble and the card sit one above the other in the thread, so a bubble
    // left on model indexes named a different page than the card beside it.
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages(),
        contentRevision: 7,
        pdfPageMap: {
          version: 2,
          totalPdfPages: 4,
          hasCoverPage: true,
          contentsStartPdfPage: 2,
          pages: [
            { index: 1, startPdfPage: 3, endPdfPage: 3 },
            { index: 2, startPdfPage: 4, endPdfPage: 4 }
          ],
          contentRevision: 7
        }
      })
    );
    const app = await buildMobileApp();

    const reply = (await send(app, "Delete page 3.")).json().reply;

    expect(reply.metadata.editProposal.summary).toBe("Remove page 3");
    expect(reply.content).toContain("Remove page 3");
    await app.close();
  });

  it("names the page the insert will really follow when the request overshot the book", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    // Twenty pages and no page map, which is the numbering a pre-map compile
    // still chats in — so whatever number the copy prints is printed verbatim.
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: Array.from({ length: 20 }, (_value, offset) => ({
          id: `page-${offset + 1}`,
          index: offset + 1,
          title: `Page ${offset + 1}`,
          markdown: "Rabbit runs ahead at the start of the race.",
          summary: "Rabbit runs.",
          imagePrompt: null,
          status: "COMPLETED"
        }))
      })
    );
    const app = await buildMobileApp();

    const reply = (await send(app, "Add a page after page 100.")).json().reply;

    // `resolveStructuralPageEdit` reads an anchor past the end as an append and
    // clamps it, so the chip says page 20. The bubble sitting right above it
    // used to interpolate the request's own 100 — one card, two pages.
    expect(reply.metadata.editProposal.structural).toMatchObject({
      action: "insert",
      pageCount: 1,
      totalPages: 21,
      afterReaderPage: 20
    });
    expect(reply.metadata.editProposal.summary).toBe("Add 1 new page after page 20");
    expect(reply.content).toContain("Add 1 new page after page 20");
    expect(reply.content).not.toContain("100");
    await app.close();
  });

  it("keeps the structural block on a card rebuilt from the pending edit", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    const app = await buildMobileApp();

    const proposed = (await send(app, "Delete page 2.")).json().reply.metadata.editProposal;
    // A nudge rather than a confirmation: the recovery reply re-presents the
    // same card, and that one is built from the stored pending state alone —
    // the resolver, and the book it resolves against, are nowhere in reach.
    const recovered = (await send(app, "i already said it")).json().reply.metadata.editProposal;

    expect(proposed.structural).toEqual({
      action: "delete",
      pageCount: 1,
      totalPages: 1,
      // A delete carries pages away and puts none anywhere, so the one field
      // that says where is the one saying there is nowhere: the app draws no
      // destination for it, exactly as the sentence names none.
      placement: "unnamed",
      readerPageNumbers: [2]
    });
    // The chip is drawn from this block and nothing else: a structural edit's
    // affectedPageIndexes are empty by design, so a card that loses it falls
    // through to "Matching pages" for an edit that named page 2.
    expect(recovered.structural).toEqual(proposed.structural);
    await app.close();
  });

  it("puts a new opening page at the front, on the card and on the one rebuilt from state", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    const app = await buildMobileApp();

    const proposed = (await send(app, "Add a page before page 1.")).json().reply.metadata.editProposal;
    // The same nudge as above: this card is rebuilt from the stored plan, so
    // the front-of-book marker has to survive the round trip or the resumed
    // card contradicts the one it replaces.
    const recovered = (await send(app, "i already said it")).json().reply.metadata.editProposal;

    expect(proposed.summary).toBe("Add 1 new page at the front of the book");
    // The chip is this block and nothing else, and to the app a block with no
    // anchor on it means "at the end" — so the head of the book, which has no
    // page for the new one to follow, is marked rather than left out.
    expect(proposed.structural).toEqual({
      action: "insert",
      pageCount: 1,
      totalPages: 3,
      placement: "front",
      atFrontOfBook: true
    });
    expect(recovered.structural).toEqual(proposed.structural);
    await app.close();
  });

  it("rebuilds a proposal stored before the card numbers were kept without inventing any", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    // A pending row from before this was stored: the intent is all it has, and
    // the numbers the card printed cannot be recovered from it. The rebuild
    // leaves the block off — exactly what those rows have always produced —
    // rather than guessing a page count nothing resolved.
    state.projectChatMessages.push(
      {
        id: "chat-legacy-user",
        projectId: "project-1",
        role: "USER",
        content: "Delete page 2.",
        operationId: null,
        metadata: {},
        createdAt: new Date("2026-06-15T11:00:00.000Z")
      },
      {
        id: "chat-legacy-assistant",
        projectId: "project-1",
        role: "ASSISTANT",
        content: "Remove page 2 — tap Apply to run it.",
        operationId: null,
        metadata: {
          pendingEdit: {
            request: "Delete page 2.",
            clarification: "confirm",
            proposalId: "proposal-legacy",
            credits: 0,
            intent: {
              kind: "restructure_pages",
              scope: "none",
              affectedPageIndexes: [],
              structuralEdit: { action: "delete", anchorPageIndex: null, pageIndexes: [2], pageCount: 0 }
            }
          },
          editProposal: { id: "proposal-legacy", kind: "restructure_pages", credits: 0 }
        },
        createdAt: new Date("2026-06-15T11:01:00.000Z")
      }
    );
    const app = await buildMobileApp();

    const recovered = (await send(app, "i already said it")).json().reply.metadata.editProposal;

    expect(recovered).toMatchObject({ id: "proposal-legacy", kind: "restructure_pages" });
    expect(recovered.structural).toBeUndefined();
    await app.close();
  });

  /**
   * The stored edit is the confirmation, and `structuralEditFromMetadata` drops
   * one it cannot parse. Reading the gap through the proposal-side default —
   * an insert of one page — turned the reader's confirmed delete into a priced
   * append instead.
   */
  const brokenStructuralProposal = (credits: number) => [
    {
      id: "chat-broken-user",
      projectId: "project-1",
      role: "USER",
      content: "Delete page 2.",
      operationId: null,
      metadata: {},
      createdAt: new Date("2026-06-15T11:00:00.000Z")
    },
    {
      id: "chat-broken-assistant",
      projectId: "project-1",
      role: "ASSISTANT",
      content: "Remove page 2 — tap Apply to run it.",
      operationId: null,
      metadata: {
        pendingEdit: {
          request: "Delete page 2.",
          clarification: "confirm",
          proposalId: "proposal-broken",
          credits,
          intent: {
            kind: "restructure_pages",
            scope: "none",
            affectedPageIndexes: [],
            // Refused by `structuralPageEditSchema`: page indexes are positive,
            // so this is a stored edit that comes back as nothing at all.
            structuralEdit: { action: "delete", anchorPageIndex: null, pageIndexes: [0], pageCount: 0 }
          }
        },
        editProposal: { id: "proposal-broken", kind: "restructure_pages", credits, summary: "Remove page 2" }
      },
      createdAt: new Date("2026-06-15T11:01:00.000Z")
    }
  ];

  it("settles an Apply whose stored structural edit cannot be read, instead of inventing one", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    // A free delete: the invented one-page insert costs more than the 0 the
    // card quoted, so the ceiling bounced it back as a *new* proposal — the
    // reader's "apply it" answered with "Add 1 new page at the end".
    state.projectChatMessages.push(...brokenStructuralProposal(0));
    const app = await buildMobileApp();

    const applied = await send(app, "apply it");
    const reply = applied.json().reply;

    expect(applied.statusCode).toBe(200);
    expect(applied.json().operation).toBeNull();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    // No card either: a proposal for an edit nobody asked for is one tap from
    // being charged, so this settles the confirmed one instead of re-carding it.
    expect(reply.metadata.editProposal).toBeUndefined();
    expect(reply.metadata.pendingEditCancelled).toBe(true);
    expect(reply.metadata.charged).toBe(false);
    expect(reply.content).toContain("nothing was changed or charged");
    expect(reply.content).not.toContain("new page");
    await app.close();
  });

  it("charges nothing for an unreadable structural edit whose quote left room for one", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const project = completeProject();
    mockPrisma.project.findFirst.mockResolvedValue(project);
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-1", type: "APPLY_BOOK_EDIT" }));
    // The quote is the ceiling, not the price, so a card quoted for three pages
    // let a defaulted one-page insert through: the Apply reserved credits and
    // queued an append at the end of the book for an edit that named page 2.
    state.projectChatMessages.push(...brokenStructuralProposal(bookEditCreditCost("restructure_pages", 3, project as never)));
    const app = await buildMobileApp();

    const applied = await send(app, "apply it");

    expect(applied.statusCode).toBe(200);
    expect(applied.json().operation).toBeNull();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    expect(applied.json().reply.metadata.charged).toBe(false);
    await app.close();
  });

  it("carries the structural edit into the queued job, not a page list", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-1", type: "APPLY_BOOK_EDIT" }));
    const app = await buildMobileApp();

    await send(app, "Add 2 pages after page 1.");
    const applied = await send(app, "apply it");

    expect(applied.statusCode).toBe(200);
    expect(applied.json().operation).toMatchObject({ kind: "restructure_pages" });
    const enqueued = vi.mocked(enqueueGenerationJob).mock.calls.at(0)?.at(0) as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(enqueued.type).toBe("APPLY_BOOK_EDIT");
    expect(enqueued.payload.affectedPageIndexes).toEqual([]);
    expect(enqueued.payload.structuralEdit).toEqual({
      action: "insert",
      anchorPageIndex: 1,
      pageIndexes: [],
      pageCount: 2
    });
    expect(enqueued.payload[PRE_EDIT_PROJECT_STATUS]).toBe("COMPLETE");
    await app.close();
  });

  it("stamps the queued job with the status the book had before the edit", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    // This transaction writes EDITING, so the worker can never read what the
    // book was: the paths where it settles the project itself — a delivered
    // no-op, a recompile it could not queue — would hand a book with open
    // quality findings back as COMPLETE and take the card off the reader.
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "REVIEW_REQUIRED",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages()
      })
    );
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-1", type: "APPLY_BOOK_EDIT" }));
    const app = await buildMobileApp();

    await send(app, "Add 2 pages after page 1.");
    await send(app, "apply it");

    const enqueued = vi.mocked(enqueueGenerationJob).mock.calls.at(0)?.at(0) as {
      payload: Record<string, unknown>;
    };
    expect(enqueued.payload[PRE_EDIT_PROJECT_STATUS]).toBe("REVIEW_REQUIRED");
    await app.close();
  });

  it("settles a delete for free rather than reserving anything", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-1", type: "APPLY_BOOK_EDIT" }));
    const app = await buildMobileApp();

    await send(app, "Delete page 2.");
    const applied = await send(app, "apply it");

    expect(applied.json().operation).toMatchObject({ kind: "restructure_pages", creditsCharged: 0 });
    await app.close();
  });

  it("declines a delete that would empty the book instead of carding it", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    const app = await buildMobileApp();

    const response = await send(app, "Delete pages 1 and 2.");

    // Two pages is the whole fixture book. Nothing is reserved, and the reply
    // names what is in the way rather than offering a card to cancel.
    expect(response.json().reply.metadata.editProposal).toBeUndefined();
    expect(response.json().reply.content).toContain("every page of the book");
    await app.close();
  });

  it("recompiles an undone insert against the plan version the revert restored", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    // The insert approved a plan version of its own and left the project on it.
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-2",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages()
      })
    );
    const undoneOperation = appliedEditOperationRecord({
      kind: "RESTRUCTURE_PAGES",
      request: "Add 2 pages after page 1.",
      creditsCharged: 60,
      // An insert snapshots nothing — the pages it made did not exist before —
      // so the stamp is the whole undo record.
      snapshots: [],
      classifier: {
        structuralApplication: {
          action: "insert",
          pageOrderBefore: [
            { pageId: "page-1", index: 1 },
            { pageId: "page-2", index: 2 }
          ],
          insertedPageIds: ["page-new"],
          removedPages: [],
          basePlanVersionId: "plan-1",
          newPlanVersionId: "plan-2",
          previousTargetPages: 2,
          previousChapterTargetPages: {},
          appliedAt: "2026-08-15T00:00:00.000Z"
        }
      }
    });
    state.bookEditOperations.push(undoneOperation);
    mockPrisma.bookEditOperation.findMany.mockResolvedValue([undoneOperation]);
    vi.mocked(revertStructuralPageChange).mockResolvedValue({ currentPlanId: "plan-1" });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/edits/undo",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(response.statusCode).toBe(200);
    const compile = vi
      .mocked(enqueueGenerationJob)
      .mock.calls.map((call) => call.at(0) as { type: string; dedupeKey: string; payload: Record<string, unknown> })
      .find((job) => job.type === "COMPILE_EXPORT");
    // `plan-2` is the row the revert just deleted, and this compile owns the
    // book's outcome: it cannot load its plan, so it throws, marks a finished
    // and delivered book FAILED and refunds the generation that paid for it.
    expect(compile?.payload.planId).toBe("plan-1");
    expect(compile?.dedupeKey).toContain("plan-1");
    await app.close();
  });

  it("names the shape it put back when the undone edit snapshotted no page text", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    const undoneOperation = appliedEditOperationRecord({
      kind: "RESTRUCTURE_PAGES",
      request: "Move the intro after the first chapter.",
      creditsCharged: 0,
      // A move rewrites no page, so there is nothing to snapshot and the reply
      // cannot be built from snapshots: it used to read "I restored pages  to
      // how they were", an empty list rendered as an empty phrase.
      snapshots: [],
      classifier: {
        structuralApplication: {
          action: "move",
          pageOrderBefore: [
            { pageId: "page-1", index: 1, chapterId: "chapter-1" },
            { pageId: "page-2", index: 2, chapterId: "chapter-2" }
          ],
          previousTargetPages: 2,
          appliedAt: "2026-08-15T00:00:00.000Z"
        }
      }
    });
    state.bookEditOperations.push(undoneOperation);
    mockPrisma.bookEditOperation.findMany.mockResolvedValue([undoneOperation]);
    vi.mocked(revertStructuralPageChange).mockResolvedValue({ currentPlanId: "plan-1" });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/edits/undo",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(response.statusCode).toBe(200);
    const content = response.json().reply.content as string;
    expect(content).toContain("put the pages back in their original order");
    expect(content).toContain("Move the intro after the first chapter.");
    // No page numbers at all: a structural undo just moved every one of them,
    // so any number here is one the reader would read against the old book.
    expect(content).not.toMatch(/pages? \d/);
    expect(vi.mocked(revertStructuralPageChange)).toHaveBeenCalledWith(
      expect.anything(),
      "project-1",
      expect.objectContaining({
        pageOrderBefore: [
          { pageId: "page-1", index: 1, chapterId: "chapter-1" },
          { pageId: "page-2", index: 2, chapterId: "chapter-2" }
        ]
      })
    );
    await app.close();
  });

  it("puts a book with no plan left back rather than stranding it in EDITING", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "REVIEW_REQUIRED",
        currentPlanId: "plan-2",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages()
      })
    );
    mockPrisma.project.update.mockResolvedValue({ contentRevision: 9 });
    const undoneOperation = appliedEditOperationRecord({
      kind: "RESTRUCTURE_PAGES",
      request: "Delete page 2.",
      creditsCharged: 0,
      snapshots: [],
      classifier: {
        structuralApplication: {
          action: "delete",
          pageOrderBefore: [{ pageId: "page-1", index: 1 }],
          newPlanVersionId: "plan-2",
          previousTargetPages: 2,
          appliedAt: "2026-08-15T00:00:00.000Z"
        }
      }
    });
    state.bookEditOperations.push(undoneOperation);
    mockPrisma.bookEditOperation.findMany.mockResolvedValue([undoneOperation]);
    // A stamp that named the version it created but not the one it superseded:
    // deleting it leaves `currentPlanId` null through the foreign key.
    vi.mocked(revertStructuralPageChange).mockResolvedValue({ currentPlanId: null });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/edits/undo",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(response.statusCode).toBe(200);
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    // EDITING is what the mobile status stream keeps the reader waiting on, and
    // only a compile leaves it — so a compile that can never be queued has to
    // hand the book back to the status it was finished in.
    expect(mockPrisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: "project-1", status: "EDITING", contentRevision: 9 },
      data: { status: "REVIEW_REQUIRED" }
    });
    await app.close();
  });

  it("runs the undo under the same transaction ceiling the apply side uses", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-2",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages()
      })
    );
    mockPrisma.project.update.mockResolvedValue({ contentRevision: 4 });
    const undoneOperation = appliedEditOperationRecord({
      kind: "RESTRUCTURE_PAGES",
      request: "Delete page 2.",
      creditsCharged: 0,
      snapshots: [],
      classifier: {
        structuralApplication: {
          action: "delete",
          pageOrderBefore: [{ pageId: "page-1", index: 1 }],
          newPlanVersionId: "plan-2",
          previousTargetPages: 2,
          appliedAt: "2026-08-15T00:00:00.000Z"
        }
      }
    });
    state.bookEditOperations.push(undoneOperation);
    mockPrisma.bookEditOperation.findMany.mockResolvedValue([undoneOperation]);
    vi.mocked(revertStructuralPageChange).mockResolvedValue({ currentPlanId: "plan-1" });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/edits/undo",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(response.statusCode).toBe(200);
    // An undo replays the apply's work backwards inside one transaction — the
    // raw index shifts, both `PlanVersion` writes, then every snapshot on top —
    // so Prisma's 5 s default aborts it midway on a long book while the apply
    // that created the shape ran with 30 s.
    expect(mockPrisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 30_000,
      maxWait: 10_000
    });
    await app.close();
  });

  it("offers the changes view for a structural edit, which snapshots nothing", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    state.bookEditOperations.push(
      appliedEditOperationRecord({
        id: "operation-structural",
        kind: "RESTRUCTURE_PAGES",
        request: "Delete page 2.",
        creditsCharged: 0,
        classifier: {
          structuralApplication: {
            action: "delete",
            pageOrderBefore: [{ pageId: "page-1", index: 1 }],
            previousTargetPages: 2,
            appliedAt: "2026-08-15T00:00:00.000Z"
          }
        }
      }),
      // The page-edit case, unchanged: the snapshot count is still the whole
      // answer for an edit that rewrites text, so an operation that wrote none
      // has nothing to review.
      appliedEditOperationRecord({ id: "operation-text" })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/chat",
      headers: bearer("token-a")
    });
    const operations = response.json().operations as Array<{ id: string; changesAvailable: boolean }>;

    // A structural edit changes which pages the book has rather than what any
    // page says, so it writes no `PageEditSnapshot` and counting those left the
    // app's only review affordance switched off for it. The stamp is its record.
    expect(operations.find((operation) => operation.id === "operation-structural")?.changesAvailable).toBe(true);
    expect(operations.find((operation) => operation.id === "operation-text")?.changesAvailable).toBe(false);
    await app.close();
  });

  it("keeps the changes view shut for a structural edit the worker declined", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    // The resolver refused because the book changed under the card, so the
    // handler settled it as a delivered no-op *before* the shift — no stamp, no
    // shape to show, and the same answer `operationCanUndo` gives it.
    state.bookEditOperations.push(
      appliedEditOperationRecord({
        id: "operation-skipped",
        kind: "RESTRUCTURE_PAGES",
        request: "Delete page 9.",
        creditsCharged: 0,
        affectedPageIndexes: [],
        classifier: { structuralSkipped: "unknown_pages" }
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/chat",
      headers: bearer("token-a")
    });

    // And the card says so, rather than confirming the delete the queued reply
    // promised: the worker writes no chat message, so this is the only surface
    // that can take that promise back.
    expect(response.json().operations[0]).toMatchObject({
      changesAvailable: false,
      canUndo: false,
      currentAction: "Nothing was changed: those pages aren’t in the book any more."
    });
    await app.close();
  });

  // `rollbackStructuralChange` erases the stamp inside the revert's own
  // transaction, and the `updateMany` that flips the row APPLIED → FAILED
  // afterwards is `.catch()`ed — so a connection blip leaves an APPLIED
  // `RESTRUCTURE_PAGES` row carrying neither the stamp nor `structuralSkipped`.
  // Nothing about it says "no-op", but there is no shape to put back, and the
  // undo picker takes the newest row with a record: the edit *before* it.
  it("does not offer Undo for a rolled-back structural edit still marked APPLIED", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    state.pages = generatedPages().map((page) => ({ ...page, projectId: "project-1", revision: 2 }));
    const olderTextEdit = appliedEditOperationRecord({
      id: "operation-text",
      request: 'On page 1, replace "night" with "day".',
      createdAt: new Date("2026-06-15T13:10:00.000Z"),
      appliedAt: new Date("2026-06-15T13:11:00.000Z"),
      _count: { snapshots: 1 },
      snapshots: [
        {
          pageId: "page-1",
          pageIndex: 1,
          titleBefore: "Rabbit Starts Fast",
          markdownBefore: "Rabbit runs ahead at the start of the race.",
          summaryBefore: "Rabbit starts the race quickly.",
          revisionBefore: 1
        }
      ]
    });
    const rolledBack = appliedEditOperationRecord({
      id: "operation-rolled-back",
      kind: "RESTRUCTURE_PAGES",
      request: "Add 2 pages after page 1.",
      creditsCharged: 60,
      createdAt: new Date("2026-06-15T13:20:00.000Z"),
      appliedAt: new Date("2026-06-15T13:21:00.000Z"),
      snapshots: [],
      classifier: { structuralRolledBackAt: "2026-08-16T00:00:00.000Z" }
    });
    state.bookEditOperations.push(olderTextEdit, rolledBack);
    const app = await buildMobileApp();

    const chat = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/chat",
      headers: bearer("token-a")
    });
    const operations = chat.json().operations as Array<{ id: string; canUndo: boolean }>;
    expect(operations.find((operation) => operation.id === "operation-rolled-back")?.canUndo).toBe(false);
    // The button belongs to the edit an undo would actually revert, so the two
    // cannot name different rows.
    expect(operations.find((operation) => operation.id === "operation-text")?.canUndo).toBe(true);

    const undo = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/edits/undo",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(undo.statusCode).toBe(200);
    // Nothing to put back: the revert already ran in the worker, and running it
    // again on a stamp that is gone would be an undo of the older edit wearing
    // this one's confirmation.
    expect(vi.mocked(revertStructuralPageChange)).not.toHaveBeenCalled();
    expect(undo.json().reply.content).toContain('replace "night" with "day"');
    expect(mockPrisma.page.update).toHaveBeenCalledWith({
      where: { id: "page-1" },
      data: expect.objectContaining({ markdown: "Rabbit runs ahead at the start of the race." })
    });
    await app.close();
  });

  it("counts what a structural edit added or removed from its own record", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    state.pages = [
      { id: "page-new", projectId: "project-1", index: 2, title: "Page 2", markdown: "A new page of prose.", revision: 1 }
    ];
    state.bookEditOperations.push(
      appliedEditOperationRecord({
        id: "operation-delete",
        kind: "RESTRUCTURE_PAGES",
        request: "Delete page 2.",
        creditsCharged: 0,
        classifier: {
          structuralApplication: {
            action: "delete",
            pageOrderBefore: [{ pageId: "page-1", index: 1 }],
            removedPages: [
              {
                id: "page-2",
                index: 2,
                chapterId: null,
                title: "Night Falls",
                markdown: "The turtle waited by the gate.",
                summary: "",
                imagePrompt: null,
                revision: 1
              }
            ],
            previousTargetPages: 2,
            appliedAt: "2026-08-15T00:00:00.000Z"
          }
        }
      }),
      appliedEditOperationRecord({
        id: "operation-insert",
        kind: "RESTRUCTURE_PAGES",
        request: "Add a page after page 1.",
        creditsCharged: 30,
        classifier: {
          structuralApplication: {
            action: "insert",
            pageOrderBefore: [{ pageId: "page-1", index: 1 }],
            insertedPageIds: ["page-new"],
            previousTargetPages: 1,
            appliedAt: "2026-08-15T00:00:00.000Z"
          }
        }
      })
    );
    const app = await buildMobileApp();

    const removed = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/operations/operation-delete/changes",
      headers: bearer("token-a")
    });
    const added = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/operations/operation-insert/changes",
      headers: bearer("token-a")
    });

    // No page diffs, and that is the honest answer: this view is a before/after
    // of page text and a structural edit rewrote none. The two totals are real
    // though — the removed page rides the stamp whole, and the inserted one is
    // a `Page` row the drafting pass wrote — so the card is not left blank.
    expect(removed.json().changes).toMatchObject({
      kind: "restructure_pages",
      pages: [],
      addedWords: 0,
      removedWords: 6
    });
    expect(added.json().changes).toMatchObject({
      kind: "restructure_pages",
      pages: [],
      addedWords: 5,
      removedWords: 0
    });
    await app.close();
  });
});
