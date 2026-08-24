import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The one durable write a page review loop makes: what its compare-and-swap
 * claims, and what it says when the claim misses.
 *
 * Split out of `pageReviewRecovery.test.ts` at that file's size budget, along
 * the seam the suite already had. Everything left there is decided in memory —
 * where recovery starts, what a rewrite is told, which copy of a chapter brief
 * moves and when the loop takes the write at all — and everything here is the
 * row: which value the write stakes its claim on, what it leaves behind, and
 * which of the two silent outcomes an operator is looking at. Same two mocks
 * the sibling needs (`runtime/dispatch.js` opens a Redis connection at import
 * time and the db client wants a database) plus the row itself.
 */

const mocks = vi.hoisted(() => ({
  chapter: { findUnique: vi.fn(), updateMany: vi.fn() }
}));

vi.mock("@book-maker/db", async () => ({
  prisma: { chapter: mocks.chapter },
  Prisma: {},
  ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks()
}));
vi.mock("../runtime/dispatch.js", () => ({ enqueueWorkerJob: vi.fn() }));

import {
  ChapterBriefPublicationRejectedError,
  repairPageBriefForRecovery
} from "./pageReviewRecovery.js";

const beat = (pageIndex: number, text: string) => ({
  pageIndex,
  chapterIndex: 1,
  purpose: text,
  beat: text,
  requiredContinuity: [] as string[],
  endingPressure: ""
});

/** A brief in the shape this module's own writes leave behind: its own parse. */
const chapterBriefFixture = () => ({
  chapterIndex: 1,
  title: "The vault",
  summary: "The crew reaches the vault.",
  continuityFocus: [] as string[],
  pages: [beat(5, "Reach the vault"), beat(6, "Repeat the approach")]
});

const repairedBeat = () => ({ ...beat(6, "Open the vault"), requiredContinuity: ["fresh angle"] });

const strategy = { repairPageBrief: vi.fn() };

/** Only the fields this path reads are real; the repair call itself is mocked. */
const callOptions = (overrides: Record<string, unknown> = {}) =>
  ({
    strategy,
    input: {},
    plan: {},
    chapterBrief: chapterBriefFixture(),
    chapterId: "chapter-1",
    pageBrief: beat(6, "Repeat the approach"),
    pageIndex: 6,
    draft: { title: "Six", markdown: "Six text.", summary: "Six summary.", continuityNotes: [] },
    qualityReport: { approved: false, score: 40, issues: [], requiredRevisions: [], notes: "" },
    previousPages: [],
    continuityNotes: [],
    textModel: {},
    context: "Page 6",
    ...overrides
  }) as never;

/** The write the loop takes once the page keeps a draft this beat briefed. */
const takeDeferredWrite = async (options = callOptions()) => {
  const repair = await repairPageBriefForRecovery(options);
  await repair.persist?.();
  return repair;
};

const chapterWrite = (index: number) =>
  mocks.chapter.updateMany.mock.calls[index]![0] as {
    where: { id: string; productionBrief: { equals: Record<string, unknown> } };
    data: {
      productionBrief: {
        continuityFocus: string[];
        pages: Array<{ pageIndex: number; beat: string; imageMoment?: string }>;
      };
    };
  };

const warnings = () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  return {
    lines: () => warn.mock.calls.map((call) => String(call[0])),
    restore: () => warn.mockRestore()
  };
};

describe("the repaired beat's durable chapter write", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    strategy.repairPageBrief.mockResolvedValue(repairedBeat());
  });

  it("reads nothing until the deferred write is taken", async () => {
    mocks.chapter.findUnique.mockResolvedValue({ productionBrief: chapterBriefFixture() });
    mocks.chapter.updateMany.mockResolvedValue({ count: 1 });

    const repair = await repairPageBriefForRecovery(callOptions());

    expect(mocks.chapter.findUnique).not.toHaveBeenCalled();
    expect(mocks.chapter.updateMany).not.toHaveBeenCalled();

    await repair.persist?.();

    expect(mocks.chapter.updateMany).toHaveBeenCalledTimes(1);
  });

  it("merges the repair into a freshly-read chapter brief and writes it back conditionally", async () => {
    mocks.chapter.findUnique.mockResolvedValue({ productionBrief: chapterBriefFixture() });
    mocks.chapter.updateMany.mockResolvedValue({ count: 1 });

    await takeDeferredWrite();

    expect(mocks.chapter.updateMany).toHaveBeenCalledTimes(1);
    expect(chapterWrite(0).where.id).toBe("chapter-1");
    expect(chapterWrite(0).data.productionBrief.pages.map((page) => page.beat)).toEqual([
      "Reach the vault",
      "Open the vault"
    ]);
  });

  it("writes nothing at all for a chapter row that holds no brief", async () => {
    mocks.chapter.findUnique.mockResolvedValue({ productionBrief: null });

    const repair = await repairPageBriefForRecovery(callOptions());

    await expect(repair.persist?.()).resolves.toBe("no-stored-brief");

    expect(mocks.chapter.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a combined publication when the chapter holds no brief", async () => {
    mocks.chapter.findUnique.mockResolvedValue({ productionBrief: null });
    const repair = await repairPageBriefForRecovery(callOptions());

    await expect(repair.persist?.({ chapter: mocks.chapter } as never)).rejects.toMatchObject({
      name: "ChapterBriefPublicationRejectedError",
      chapterId: "chapter-1",
      outcome: "no-stored-brief"
    } satisfies Partial<ChapterBriefPublicationRejectedError>);

    expect(mocks.chapter.updateMany).not.toHaveBeenCalled();
  });

  /**
   * The stake, which is the row's own JSON and not what that JSON parses to.
   *
   * `parseChapterBrief` is `chapterBriefSchema`, a `z.preprocess` that renames
   * aliases, defaults two lists into existence and strips every key it does not
   * name — so a stored document that is not already its own parse is one the
   * old `equals: currentBrief` predicate could never equal. Not "usually
   * missed": missed on every attempt, for as long as the row holds that
   * spelling, at three `updateMany` and three `findUnique` a page — and the
   * compile's repair pass now brings a `chapterId` for every flagged page it
   * rewrites.
   */
  describe("the value it stakes its claim on", () => {
    /**
     * A brief the schema would not hand back unchanged, in both of the ways a
     * producer can write one: the beat spells its image field `visualMoment`
     * (which the parse renames to `imageMoment`), and neither the beat nor the
     * brief carries the lists `.default([])` materialises.
     */
    const storedInAnOlderSpelling = () => ({
      chapterIndex: 1,
      title: "The vault",
      summary: "The crew reaches the vault.",
      pages: [
        {
          pageIndex: 5,
          chapterIndex: 1,
          purpose: "Reach the vault",
          beat: "Reach the vault",
          endingPressure: "",
          visualMoment: "The door, lit from below."
        },
        { pageIndex: 6, chapterIndex: 1, purpose: "Repeat", beat: "Repeat the approach", endingPressure: "" }
      ]
    });

    it("claims the stored document itself, aliases and missing defaults and all", async () => {
      const stored = storedInAnOlderSpelling();
      mocks.chapter.findUnique.mockResolvedValue({ productionBrief: stored });
      mocks.chapter.updateMany.mockResolvedValue({ count: 1 });

      await takeDeferredWrite();

      // The row as the read handed it over — the same object, so nothing
      // between the read and the predicate reshaped it.
      expect(chapterWrite(0).where.productionBrief.equals).toBe(stored);
      expect(chapterWrite(0).where.productionBrief.equals).toEqual(storedInAnOlderSpelling());
      // One attempt: a claim made out of the row's own bytes matches the row,
      // so there is no retry to pay for and no warning to print.
      expect(mocks.chapter.updateMany).toHaveBeenCalledTimes(1);
      expect(mocks.chapter.findUnique).toHaveBeenCalledTimes(1);
    });

    it("still merges the repair through the parse, so the write canonicalises the row", async () => {
      mocks.chapter.findUnique.mockResolvedValue({ productionBrief: storedInAnOlderSpelling() });
      mocks.chapter.updateMany.mockResolvedValue({ count: 1 });

      await takeDeferredWrite();

      // What goes back is the merge of the *parse*: the alias resolved, the
      // defaulted lists present, the repaired beat in page 6's place. Which is
      // why the next repair on this chapter stakes on a document the schema
      // would hand back unchanged.
      const written = chapterWrite(0).data.productionBrief;
      expect(written.pages[0]?.imageMoment).toBe("The door, lit from below.");
      expect(written.pages[0]).not.toHaveProperty("visualMoment");
      expect(written.continuityFocus).toEqual(["fresh angle"]);
      expect(written.pages.map((page) => page.beat)).toEqual(["Reach the vault", "Open the vault"]);
    });
  });

  it("retries against the winner's brief instead of clobbering it when a concurrent repair lands first", async () => {
    // A sibling page's repair (for page 7) committed between our read and our
    // write: the CAS misses, and the retry must fold page 6's repair onto the
    // *winner's* brief — including page 7's repair — not overwrite it.
    const winnerBrief = { ...chapterBriefFixture(), pages: [...chapterBriefFixture().pages, beat(7, "Sibling repair")] };
    mocks.chapter.findUnique
      .mockResolvedValueOnce({ productionBrief: chapterBriefFixture() })
      .mockResolvedValueOnce({ productionBrief: winnerBrief });
    mocks.chapter.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

    await takeDeferredWrite();

    expect(mocks.chapter.updateMany).toHaveBeenCalledTimes(2);
    expect(chapterWrite(1).where.productionBrief.equals).toBe(winnerBrief);
    expect(chapterWrite(1).data.productionBrief.pages.map((page) => page.pageIndex)).toEqual([5, 6, 7]);
    expect(chapterWrite(1).data.productionBrief.pages[1]!.beat).toBe("Open the vault");
  });

  /**
   * Both ways this write can end up writing nothing, and neither of them is an
   * error: the beat still steered the page that paid for it. They are different
   * *faults* though — one is ordinary traffic on a fanned-out chapter, the
   * other is a row this function cannot claim — and the run log is the only
   * place an operator can tell them apart.
   */
  describe("what it tells an operator when it writes nothing", () => {
    const siblingBrief = (label: string) => ({
      ...chapterBriefFixture(),
      pages: [...chapterBriefFixture().pages, beat(7, label)]
    });

    it("names the race when the row moves under every attempt", async () => {
      // A row that moves under each miss is a sibling committing between our
      // read and our write, over and over — the case the retry budget is for.
      mocks.chapter.findUnique
        .mockResolvedValueOnce({ productionBrief: siblingBrief("Sibling A") })
        .mockResolvedValueOnce({ productionBrief: siblingBrief("Sibling B") })
        .mockResolvedValueOnce({ productionBrief: siblingBrief("Sibling C") });
      mocks.chapter.updateMany.mockResolvedValue({ count: 0 });
      const warn = warnings();

      const repair = await takeDeferredWrite();
      const lines = warn.lines();
      warn.restore();

      expect(repair.beat).toEqual(repairedBeat());
      expect(mocks.chapter.updateMany).toHaveBeenCalledTimes(3);
      expect(lines).toEqual([expect.stringContaining("lost the CAS race")]);
    });

    it("rejects a combined publication after exhausting the moving-row CAS", async () => {
      mocks.chapter.findUnique
        .mockResolvedValueOnce({ productionBrief: siblingBrief("Sibling A") })
        .mockResolvedValueOnce({ productionBrief: siblingBrief("Sibling B") })
        .mockResolvedValueOnce({ productionBrief: siblingBrief("Sibling C") });
      mocks.chapter.updateMany.mockResolvedValue({ count: 0 });
      const warn = warnings();
      const repair = await repairPageBriefForRecovery(callOptions());

      await expect(repair.persist?.({ chapter: mocks.chapter } as never)).rejects.toMatchObject({
        name: "ChapterBriefPublicationRejectedError",
        outcome: "lost-race"
      } satisfies Partial<ChapterBriefPublicationRejectedError>);
      const lines = warn.lines();
      warn.restore();

      expect(mocks.chapter.updateMany).toHaveBeenCalledTimes(3);
      expect(lines).toEqual([expect.stringContaining("lost the CAS race")]);
    });

    it("says a miss nobody caused differently, and stops paying for it", async () => {
      // The mock stands in for a row this predicate cannot name — which is
      // exactly what a stake on the *parsed* brief produced for every stored
      // document that was not already its own parse. Nothing wrote the row, so
      // the retries could only miss again: it says so and gives up, rather than
      // reporting a race that never happened and buying two more round trips to
      // reach the same silence.
      mocks.chapter.findUnique.mockResolvedValue({ productionBrief: chapterBriefFixture() });
      mocks.chapter.updateMany.mockResolvedValue({ count: 0 });
      const warn = warnings();

      await takeDeferredWrite();
      const lines = warn.lines();
      warn.restore();

      expect(mocks.chapter.updateMany).toHaveBeenCalledTimes(1);
      expect(mocks.chapter.findUnique).toHaveBeenCalledTimes(2);
      expect(lines).toEqual([expect.stringContaining("matched no row while the stored brief was unchanged")]);
      expect(lines[0]).not.toContain("lost the CAS race");
    });
  });
});
