import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Per-entity continuity state: what a saved page's notes do to the character and
 * location rows later pages read back. Pages generate in parallel waves, so most
 * of what is asserted here is the compare-and-swap — what happens when two of
 * them name the same entity at once.
 */
const mocks = await vi.hoisted(async () => ({
  prisma: {
    character: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    location: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() }
  },
  /**
   * The shared degrade stand-in from `testing/degradeRetrievalArmFake.ts`.
   * Neither half of this module logs its own failures any more — both hand them
   * to the policy the embedding arms share, and the one thing that must still
   * escape it is a stop.
   */
  degradeRetrievalArm: (await import("./testing/degradeRetrievalArmFake.js")).createDegradeRetrievalArmFake()
}));

vi.mock("@book-maker/db", () => ({
  prisma: mocks.prisma,
  Prisma: { JsonNull: "JsonNull" },
  degradeRetrievalArm: mocks.degradeRetrievalArm
}));

import { StopRequestedError } from "../runtime/jobTypes.js";
import { updateEntityStateFromPage } from "./entityState.js";

describe("updateEntityStateFromPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.location.findMany.mockResolvedValue([]);
  });

  it("appends the page's note onto the entity's existing state", async () => {
    mocks.prisma.character.findMany.mockResolvedValue([
      { id: "char-1", name: "Ada", state: { notes: ["p9 note"], updatedAtPage: 9 } }
    ]);
    mocks.prisma.character.updateMany.mockResolvedValue({ count: 1 });

    await updateEntityStateFromPage("project-1", 10, ["Ada picks up the lantern."]);

    expect(mocks.prisma.character.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.character.updateMany).toHaveBeenCalledWith({
      where: { id: "char-1", state: { equals: { notes: ["p9 note"], updatedAtPage: 9 } } },
      data: { state: { notes: ["p9 note", "Ada picks up the lantern."], updatedAtPage: 10 } }
    });
  });

  it("retries against the winning write instead of losing a concurrent page's note", async () => {
    // Page 11's job (a sibling in the same parallel wave) committed its own
    // note between our read and our write: the CAS misses, and the retry must
    // fold page 10's note onto the winner's state, not overwrite it.
    mocks.prisma.character.findMany.mockResolvedValue([
      { id: "char-1", name: "Ada", state: { notes: ["p9 note"], updatedAtPage: 9 } }
    ]);
    const winnerState = { notes: ["p9 note", "p11 note"], updatedAtPage: 11 };
    mocks.prisma.character.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    mocks.prisma.character.findUnique.mockResolvedValue({ state: winnerState });

    await updateEntityStateFromPage("project-1", 10, ["Ada picks up the lantern."]);

    expect(mocks.prisma.character.updateMany).toHaveBeenCalledTimes(2);
    expect(mocks.prisma.character.updateMany).toHaveBeenLastCalledWith({
      where: { id: "char-1", state: { equals: winnerState } },
      data: { state: { notes: ["p9 note", "p11 note", "Ada picks up the lantern."], updatedAtPage: 10 } }
    });
  });

  it("gives up and logs rather than looping forever when every attempt loses the race", async () => {
    mocks.prisma.character.findMany.mockResolvedValue([{ id: "char-1", name: "Ada", state: null }]);
    mocks.prisma.character.updateMany.mockResolvedValue({ count: 0 });
    mocks.prisma.character.findUnique.mockResolvedValue({ state: { notes: ["someone else's note"], updatedAtPage: 12 } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await updateEntityStateFromPage("project-1", 10, ["Ada picks up the lantern."]);

    expect(mocks.prisma.character.updateMany).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("lost the CAS race"));
    warn.mockRestore();
  });

  it("matches a Persian entity name a model echoed back in another script", async () => {
    // The library "علی" saved from a Persian keyboard; the note names "علي"
    // (Arabic yeh) with a ZWNJ. A raw lowercase includes() would miss it; the
    // fold makes them one name so the entity's state still updates.
    mocks.prisma.character.findMany.mockResolvedValue([{ id: "char-1", name: "علی", state: null }]);
    mocks.prisma.character.updateMany.mockResolvedValue({ count: 1 });

    await updateEntityStateFromPage("project-1", 4, ["علي‌ نامه را باز کرد."]);

    expect(mocks.prisma.character.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.character.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "char-1" }) })
    );
  });

  it("keeps two Hindi characters apart when their names differ only by a vowel sign", async () => {
    // The fold behind this check used to strip every `\p{M}`, and Devanagari
    // matras are `Mn`/`Mc`: "मीरा" and "मारा" both became "मर", so a note about
    // one of them was appended to the other's state — a continuity line telling
    // later pages the wrong thing about the wrong character.
    mocks.prisma.character.findMany.mockResolvedValue([
      { id: "char-meera", name: "मीरा", state: null },
      { id: "char-mara", name: "मारा", state: null }
    ]);
    mocks.prisma.character.updateMany.mockResolvedValue({ count: 1 });

    await updateEntityStateFromPage("project-1", 12, ["मारा ने चाबी छिपा दी।"]);

    expect(mocks.prisma.character.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.character.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "char-mara" }) })
    );
  });

  it("only writes entities the page's notes actually mention", async () => {
    mocks.prisma.character.findMany.mockResolvedValue([
      { id: "char-1", name: "Ada", state: null },
      { id: "char-2", name: "Beatrice", state: null }
    ]);
    mocks.prisma.character.updateMany.mockResolvedValue({ count: 1 });

    await updateEntityStateFromPage("project-1", 10, ["Ada picks up the lantern."]);

    expect(mocks.prisma.character.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.character.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "char-1" }) })
    );
  });

  it("gives each entity only the notes that name it when one page names several", async () => {
    // The notes are folded once and the folds are reused across every entity,
    // so this is the shape that fails if a folded note stops lining up with the
    // note it was folded from: three notes over two characters and a location,
    // each entity keeping its own subset in the page's own order.
    mocks.prisma.character.findMany.mockResolvedValue([
      { id: "char-ada", name: "Ada", state: null },
      { id: "char-ali", name: "علی", state: null }
    ]);
    mocks.prisma.location.findMany.mockResolvedValue([
      { id: "loc-vault", name: "The Vault of Hours", state: null }
    ]);
    mocks.prisma.character.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.location.updateMany.mockResolvedValue({ count: 1 });

    await updateEntityStateFromPage("project-1", 20, [
      "Ada unlocks The Vault of Hours.",
      "علي‌ waits outside.",
      "Ada leaves the lantern behind."
    ]);

    expect(mocks.prisma.character.updateMany).toHaveBeenCalledTimes(2);
    expect(mocks.prisma.character.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ id: "char-ada" }),
        data: { state: { notes: ["Ada unlocks The Vault of Hours.", "Ada leaves the lantern behind."], updatedAtPage: 20 } }
      })
    );
    expect(mocks.prisma.character.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ id: "char-ali" }),
        data: { state: { notes: ["علي‌ waits outside."], updatedAtPage: 20 } }
      })
    );
    expect(mocks.prisma.location.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.location.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "loc-vault" }),
        data: { state: { notes: ["Ada unlocks The Vault of Hours."], updatedAtPage: 20 } }
      })
    );
  });

  /**
   * The catch around this fold is best-effort by design — a continuity line
   * nobody could write must not fail a page that is already saved — so the only
   * thing separating a stopped run from a degraded one is the predicate handed
   * to the shared policy. Degrading a stop here would let the page job settle
   * as a success and enqueue the next page of a run the reader has ended.
   */
  it("lets a stopped run out rather than degrading it to a missing state line", async () => {
    const stop = new StopRequestedError();
    mocks.prisma.character.findMany.mockRejectedValue(stop);

    await expect(updateEntityStateFromPage("project-1", 10, ["Ada picks up the lantern."])).rejects.toBe(stop);
  });

  /**
   * The ordinary failure, for contrast: it reaches the shared policy — counted
   * per (arm, message) and reported on its ladder rather than once per page job
   * — and the page carries on without the state line.
   */
  it("hands an ordinary failure to the shared degrade policy instead of failing the page", async () => {
    const failure = new Error("relation \"Character\" does not exist");
    mocks.prisma.character.findMany.mockRejectedValue(failure);

    await updateEntityStateFromPage("project-1", 10, ["Ada picks up the lantern."]);

    expect(mocks.degradeRetrievalArm).toHaveBeenCalledWith({
      arm: "Entity state update",
      projectId: "project-1",
      error: failure,
      fallback: undefined,
      rethrowIf: expect.any(Function)
    });
  });

  it("does nothing when the page recorded no continuity notes", async () => {
    await updateEntityStateFromPage("project-1", 10, []);

    expect(mocks.prisma.character.findMany).not.toHaveBeenCalled();
  });
});
