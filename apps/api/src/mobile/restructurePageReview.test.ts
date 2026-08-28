import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { revertStructuralPageChange } from "@book-maker/db";

import {
  appliedEditOperationRecord,
  approvedPlanRecord,
  bearer,
  buildMobileApp,
  generatedPages,
  mockAccessTokens,
  mockPrisma,
  projectRecord,
  resetMobileHarness,
  state,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

/**
 * Reviewing a structural edit after it landed: the changes view and the Undo
 * affordance beside it.
 *
 * Split from `restructurePageEdits.test.ts`, which covers proposing, applying
 * and undoing one. The seam is real rather than a line count: everything here
 * reads a settled `BookEditOperation` back through
 * `hasBookEditUndoRecord`/`loadEditChanges`, and both of those answer from the
 * `structuralApplication` stamp because a structural edit writes no
 * `PageEditSnapshot` — which is exactly what the other file's tests are busy
 * putting on the row.
 */
describe("reviewing a structural page edit", () => {
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

  it("shows the text a structural edit added or removed, read off its own record", async () => {
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

    // A structural edit writes no `PageEditSnapshot`, but both sides of it are
    // recorded elsewhere: the removed page rides the stamp whole, and the
    // inserted one is a `Page` row the drafting pass wrote. Reading a page count
    // off those was all this view used to do, and an insert's whole point is the
    // page it added — so each is diffed against the emptiness on its other side.
    expect(removed.json().changes).toMatchObject({
      kind: "restructure_pages",
      addedWords: 0,
      removedWords: 6,
      pages: [
        {
          pageIndex: 2,
          structuralChange: "removed",
          titleBefore: "Night Falls",
          titleAfter: "Night Falls",
          titleChanged: false,
          addedWords: 0,
          removedWords: 6,
          blocks: [
            { type: "removed", runs: [{ type: "delete", text: "The turtle waited by the gate." }] }
          ]
        }
      ]
    });
    expect(added.json().changes).toMatchObject({
      kind: "restructure_pages",
      addedWords: 5,
      removedWords: 0,
      pages: [
        {
          pageIndex: 2,
          structuralChange: "added",
          titleBefore: "Page 2",
          titleAfter: "Page 2",
          addedWords: 5,
          removedWords: 0,
          blocks: [{ type: "added", runs: [{ type: "insert", text: "A new page of prose." }] }]
        }
      ]
    });
    await app.close();
  });

  it("says where a moved page came from, and lists only the pages the reader named", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    // Page 3 went to the front, so pages 1 and 2 are renumbered behind it. None
    // of those moved in any sense the reader means, and listing them would bury
    // the one page that did.
    state.pages = [
      { id: "page-c", projectId: "project-1", index: 1, title: "Third", markdown: "Third page.", revision: 1 },
      { id: "page-a", projectId: "project-1", index: 2, title: "First", markdown: "First page.", revision: 1 },
      { id: "page-b", projectId: "project-1", index: 3, title: "Second", markdown: "Second page.", revision: 1 }
    ];
    state.bookEditOperations.push(
      appliedEditOperationRecord({
        id: "operation-move",
        kind: "RESTRUCTURE_PAGES",
        request: "Move page 3 to the front.",
        creditsCharged: 0,
        classifier: {
          structuralEdit: { action: "move", anchorPageIndex: 0, pageIndexes: [3], pageCount: 1 },
          structuralApplication: {
            action: "move",
            pageOrderBefore: [
              { pageId: "page-a", index: 1 },
              { pageId: "page-b", index: 2 },
              { pageId: "page-c", index: 3 }
            ],
            previousTargetPages: 3,
            appliedAt: "2026-08-15T00:00:00.000Z"
          }
        }
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/operations/operation-move/changes",
      headers: bearer("token-a")
    });

    // A move rewrote nothing, so there is no diff to show — where it came from
    // is the whole change, and "+0 −0" is the honest count beside it.
    expect(response.json().changes).toMatchObject({
      kind: "restructure_pages",
      addedWords: 0,
      removedWords: 0,
      pages: [
        {
          pageIndex: 1,
          pageIndexBefore: 3,
          structuralChange: "moved",
          titleAfter: "Third",
          blocks: []
        }
      ]
    });
    await app.close();
  });
});
