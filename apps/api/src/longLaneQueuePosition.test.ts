import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("@book-maker/db", () => ({ prisma: { generationJob: { findMany: mocks.findMany } } }));

import { longLaneQueuePosition, resetLongLaneSnapshotForTests } from "./longLaneQueuePosition.js";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 13, 10, minute));

/** The two snapshot reads: plain long-lane types, then the payload-laned ones. */
function openRows(plain: Array<Record<string, unknown>>, laned: Array<Record<string, unknown>> = []) {
  mocks.findMany.mockImplementation(async (args: { select: { payload?: boolean } }) => (args.select.payload ? laned : plain));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetLongLaneSnapshotForTests();
});

describe("longLaneQueuePosition", () => {
  it("counts the books ahead of a waiting book run, in books, by the lane's own order", async () => {
    openRows(
      [
        { projectId: "running", type: "GENERATE_BOOK", status: "ACTIVE", createdAt: at(1) },
        { projectId: "older", type: "GENERATE_BOOK", status: "QUEUED", createdAt: at(2) },
        { projectId: "newer", type: "GENERATE_BOOK", status: "QUEUED", createdAt: at(9) }
      ],
      [
        // A short recompile of someone's edit is interactive and holds nobody up.
        { projectId: "edited", type: "COMPILE_EXPORT", status: "QUEUED", createdAt: at(0), payload: { skipFinalReview: true } },
        // A generation's own compile continues a book already under way.
        { projectId: "finishing", type: "COMPILE_EXPORT", status: "QUEUED", createdAt: at(20), payload: { exportPublicationProjectStatus: "GENERATING" } }
      ]
    );
    const mine = [{ projectId: "mine", type: "GENERATE_BOOK", status: "QUEUED", createdAt: at(5), payload: {} }];

    await expect(longLaneQueuePosition("mine", mine, 1_000)).resolves.toEqual({ booksAhead: 3 });
  });

  it("is null while the book's long work runs, or when it has none waiting", async () => {
    openRows([]);
    await expect(
      longLaneQueuePosition("mine", [
        { projectId: "mine", type: "GENERATE_PAGE", status: "ACTIVE", createdAt: at(1) },
        { projectId: "mine", type: "GENERATE_PAGE", status: "QUEUED", createdAt: at(2) }
      ])
    ).resolves.toBeNull();
    await expect(
      longLaneQueuePosition("mine", [{ projectId: "mine", type: "APPLY_BOOK_EDIT", status: "QUEUED", createdAt: at(1) }])
    ).resolves.toBeNull();
    await expect(
      longLaneQueuePosition("mine", [{ projectId: "mine", type: "GENERATE_BOOK", status: "COMPLETED", createdAt: at(1) }])
    ).resolves.toBeNull();
    // None of those needed the global read.
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("tells a book waiting on a whole-book edit how many books are ahead of it, and reads others' edits by payload", async () => {
    const wholeBook = { affectedPageIndexes: Array.from({ length: 150 }, (_, index) => index + 1) };
    openRows(
      [{ projectId: "running", type: "GENERATE_BOOK", status: "ACTIVE", createdAt: at(1) }],
      [
        // Someone else's whole-book edit, queued first, starts long work ahead of mine.
        { projectId: "rewriting", type: "APPLY_BOOK_EDIT", status: "QUEUED", createdAt: at(2), payload: wholeBook },
        // A three-page edit runs on the interactive lane and holds nobody up.
        { projectId: "tweaking", type: "APPLY_BOOK_EDIT", status: "QUEUED", createdAt: at(3), payload: { affectedPageIndexes: [1, 2, 3] } }
      ]
    );
    const mine = [{ projectId: "mine", type: "APPLY_BOOK_EDIT", status: "QUEUED", createdAt: at(5), payload: wholeBook }];

    await expect(longLaneQueuePosition("mine", mine, 50_000)).resolves.toEqual({ booksAhead: 2 });
  });

  it("answers zero for the first book in line", async () => {
    openRows([]);
    const mine = [{ projectId: "mine", type: "IMPORT_BOOK", status: "QUEUED", createdAt: at(1) }];
    await expect(longLaneQueuePosition("mine", mine)).resolves.toEqual({ booksAhead: 0 });
  });

  it("shares one read of the lane between polls for a few seconds, and never caches a failure", async () => {
    openRows([{ projectId: "other", type: "GENERATE_BOOK", status: "ACTIVE", createdAt: at(1) }]);
    const mine = [{ projectId: "mine", type: "GENERATE_BOOK", status: "QUEUED", createdAt: at(5) }];
    await longLaneQueuePosition("mine", mine, 10_000);
    await longLaneQueuePosition("mine", mine, 11_000);
    expect(mocks.findMany).toHaveBeenCalledTimes(2);
    await longLaneQueuePosition("mine", mine, 14_000);
    expect(mocks.findMany).toHaveBeenCalledTimes(4);

    resetLongLaneSnapshotForTests();
    mocks.findMany.mockRejectedValueOnce(new Error("pool exhausted"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(longLaneQueuePosition("mine", mine, 20_000)).resolves.toBeNull();
    errors.mockRestore();
    openRows([]);
    await expect(longLaneQueuePosition("mine", mine, 20_500)).resolves.toEqual({ booksAhead: 0 });
  });
});
