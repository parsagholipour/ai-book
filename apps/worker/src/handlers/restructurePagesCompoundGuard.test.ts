import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  waitForStructuralPageLease: vi.fn(),
  compensateStructuralPageChangeTx: vi.fn(),
  rebuildRolledBackProjectStoryState: vi.fn(),
  redeliverUnrevertedStructuralEdit: vi.fn()
}));

vi.mock("../generation/structuralPageLease.js", () => ({
  waitForStructuralPageLease: mocks.waitForStructuralPageLease
}));
vi.mock("../generation/storyStateStore.js", () => ({
  rebuildRolledBackProjectStoryState: mocks.rebuildRolledBackProjectStoryState
}));
vi.mock("./restructurePagesRedelivery.js", () => ({
  redeliverUnrevertedStructuralEdit: mocks.redeliverUnrevertedStructuralEdit
}));
vi.mock("@book-maker/db", () => ({
  PAGE_RESTRUCTURE_TRANSACTION_OPTIONS: { timeout: 30_000 },
  compensateStructuralPageChangeTx: mocks.compensateStructuralPageChangeTx,
  prisma: {
    $transaction: vi.fn(async (run: (tx: { marker: string }) => Promise<unknown>) => run({ marker: "tx" }))
  }
}));

import { EDIT_ADHERENCE_FAILED, ReaderEditFailure } from "@book-maker/core/editFailure";
import { UnownedStructuralDeliveryError } from "../runtime/jobTypes.js";
import { guardCompoundStructuralDelivery } from "./restructurePagesCompoundGuard.js";

const stamp = {
  action: "delete" as const,
  insertedPageIds: [],
  removedPages: [],
  pageOrderBefore: [],
  insertedAtIndex: null,
  basePlanVersionId: "plan-1",
  newPlanVersionId: "plan-2",
  previousTargetPages: 3,
  previousChapterTargetPages: {},
  appliedAt: "2026-08-29T10:00:00.000Z"
};

const compound = {
  projectId: "project-1",
  operationId: "operation-1",
  generationJobId: "job-1",
  ownerToken: "owner-1",
  edit: { action: "delete" as const, anchorPageIndex: null, pageIndexes: [2], pageCount: 0 },
  editInstruction: "Remove page 2. Content requirements: Move its final quote to page 3."
};

describe("compound structural legacy guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rebuildRolledBackProjectStoryState.mockResolvedValue(true);
    mocks.redeliverUnrevertedStructuralEdit.mockRejectedValue(new Error("redelivered"));
  });

  it("fails an unstamped legacy row before taking a lease or mutating the manuscript", async () => {
    await expect(guardCompoundStructuralDelivery({ ...compound, application: null })).rejects.toMatchObject({
      message: EDIT_ADHERENCE_FAILED
    });
    expect(mocks.waitForStructuralPageLease).not.toHaveBeenCalled();
    expect(mocks.compensateStructuralPageChangeTx).not.toHaveBeenCalled();
  });

  it("exact-owner compensates a stamped row before entering normal refund settlement", async () => {
    mocks.waitForStructuralPageLease.mockResolvedValue({
      outcome: "acquired",
      phase: "draft",
      application: stamp,
      expiresAt: new Date("2026-08-29T10:03:00.000Z")
    });
    mocks.compensateStructuralPageChangeTx.mockResolvedValue({
      outcome: "compensated",
      currentPlanId: "plan-1"
    });

    await expect(guardCompoundStructuralDelivery({ ...compound, application: stamp })).rejects.toBeInstanceOf(
      ReaderEditFailure
    );
    expect(mocks.compensateStructuralPageChangeTx).toHaveBeenCalledWith(
      { marker: "tx" },
      {
        projectId: "project-1",
        operationId: "operation-1",
        expectedLeaseToken: "owner-1",
        expectedAppliedAt: stamp.appliedAt
      }
    );
    expect(mocks.rebuildRolledBackProjectStoryState).toHaveBeenCalledWith("project-1", "plan-1");
  });

  it("does not compensate a publication winner or another lease owner", async () => {
    mocks.waitForStructuralPageLease.mockResolvedValue({ outcome: "completed" });

    await expect(guardCompoundStructuralDelivery({ ...compound, application: stamp })).rejects.toBeInstanceOf(
      UnownedStructuralDeliveryError
    );
    expect(mocks.compensateStructuralPageChangeTx).not.toHaveBeenCalled();
  });

  it("fails the edit rather than requeueing a shift that is already off the book", async () => {
    // `not-needed` is the stamp already gone, and only a compensation clears one
    // — reverting the pages with it. Requeueing hands the row back for a fresh
    // delivery of the very request this guard refuses to deliver.
    mocks.waitForStructuralPageLease.mockResolvedValue({
      outcome: "acquired",
      phase: "draft",
      application: stamp,
      expiresAt: new Date("2026-08-29T10:03:00.000Z")
    });
    mocks.compensateStructuralPageChangeTx.mockResolvedValue({ outcome: "not-needed" });

    await expect(guardCompoundStructuralDelivery({ ...compound, application: stamp })).rejects.toBeInstanceOf(
      ReaderEditFailure
    );
    expect(mocks.redeliverUnrevertedStructuralEdit).not.toHaveBeenCalled();
    expect(mocks.rebuildRolledBackProjectStoryState).not.toHaveBeenCalled();
  });

  it("redelivers instead of refunding when the exact compensation cannot land", async () => {
    mocks.waitForStructuralPageLease.mockResolvedValue({
      outcome: "acquired",
      phase: "draft",
      application: stamp,
      expiresAt: new Date("2026-08-29T10:03:00.000Z")
    });
    mocks.compensateStructuralPageChangeTx.mockResolvedValue({ outcome: "lost" });

    await expect(guardCompoundStructuralDelivery({ ...compound, application: stamp })).rejects.toThrow(
      "redelivered"
    );
    expect(mocks.redeliverUnrevertedStructuralEdit).toHaveBeenCalledWith(
      "project-1",
      "operation-1",
      "owner-1",
      "job-1"
    );
  });

  it("classifies a stamped row whose own request no longer parses", async () => {
    // `structuralEditFromClassifier` answers null for a tampered or legacy row,
    // and the payload copy is what such a delivery has already lost — so read as
    // "nothing to guard" it resumed the stamped pages and settled APPLIED with
    // the prose half of the request silently dropped. The stamp still knows the
    // action, which is what the classifier needs.
    mocks.waitForStructuralPageLease.mockResolvedValue({
      outcome: "acquired",
      phase: "draft",
      application: stamp,
      expiresAt: new Date("2026-08-29T10:03:00.000Z")
    });
    mocks.compensateStructuralPageChangeTx.mockResolvedValue({
      outcome: "compensated",
      currentPlanId: "plan-1"
    });

    await expect(
      guardCompoundStructuralDelivery({ ...compound, edit: null, application: stamp })
    ).rejects.toBeInstanceOf(ReaderEditFailure);
    expect(mocks.compensateStructuralPageChangeTx).toHaveBeenCalledOnce();
  });

  it("never fires on an unparseable insert, which drafts its own prose here", async () => {
    await expect(
      guardCompoundStructuralDelivery({
        ...compound,
        edit: null,
        editInstruction: "Add 1 new page after page 2. Content requirements: Reveal the key.",
        application: { ...stamp, action: "insert" as const }
      })
    ).resolves.toBeUndefined();
    expect(mocks.waitForStructuralPageLease).not.toHaveBeenCalled();
  });

  it("leaves an unparseable request with no stamp to the handler's own refusal", async () => {
    // Nothing was shifted and nothing is known, and `restructurePages` already
    // settles that row free with `structuralSkipped: "missing_request"`.
    await expect(
      guardCompoundStructuralDelivery({ ...compound, edit: null, application: null })
    ).resolves.toBeUndefined();
    expect(mocks.waitForStructuralPageLease).not.toHaveBeenCalled();
  });

  it("leaves a pure delete and every insertion on their existing paths", async () => {
    await expect(
      guardCompoundStructuralDelivery({
        ...compound,
        editInstruction: "Remove page 2",
        application: null
      })
    ).resolves.toBeUndefined();
    await expect(
      guardCompoundStructuralDelivery({
        ...compound,
        edit: { action: "insert", anchorPageIndex: 2, pageIndexes: [], pageCount: 1 },
        editInstruction: "Add 1 new page after page 2. Content requirements: Reveal the key.",
        application: null
      })
    ).resolves.toBeUndefined();
    // A bare delete stays free even with no request to read it off: the English
    // grammar answers from the instruction alone and never consults the edit.
    await expect(
      guardCompoundStructuralDelivery({
        ...compound,
        edit: null,
        editInstruction: "Remove page 2",
        application: stamp
      })
    ).resolves.toBeUndefined();
    expect(mocks.waitForStructuralPageLease).not.toHaveBeenCalled();
  });
});
