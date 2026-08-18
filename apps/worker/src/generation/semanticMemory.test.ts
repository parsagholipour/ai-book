import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    character: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    location: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    embedding: { create: vi.fn() },
    $executeRawUnsafe: vi.fn()
  }
}));

vi.mock("@book-maker/db", () => ({
  prisma: mocks.prisma,
  Prisma: { JsonNull: "JsonNull" },
  retrieveSimilarEmbeddings: vi.fn()
}));

import { storeEmbedding, updateEntityStateFromPage } from "./semanticMemory.js";

/**
 * `storeEmbedding` is the provider call and the insert composed, and the two
 * halves are separately callable so a caller publishing under an ownership
 * fence can put the fence between them (`generation/pageReview.ts`). These
 * assertions are on the composed call, because that is what every other caller
 * still uses and what the split must not have changed.
 */
describe("storeEmbedding", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes the vector row when the provider answers", async () => {
    mocks.prisma.$executeRawUnsafe.mockResolvedValue(1);

    await storeEmbedding("project-1", "page:3", "page-row-1", "Summary.", { embed: async () => [0.5, -0.25] });

    expect(mocks.prisma.embedding.create).not.toHaveBeenCalled();
    expect(mocks.prisma.$executeRawUnsafe.mock.calls[0]?.[6]).toBe("[0.5000000,-0.2500000]");
  });

  it("degrades to a vectorless row when the provider call fails", async () => {
    await storeEmbedding("project-1", "page:3", "page-row-1", "Summary.", {
      embed: async () => {
        throw new Error("provider down");
      }
    });

    expect(mocks.prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(mocks.prisma.embedding.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ metadata: { vectorStored: false, error: "provider down" } })
    });
  });

  it("degrades to a vectorless row when the vector insert itself fails", async () => {
    mocks.prisma.$executeRawUnsafe.mockRejectedValue(new Error("type vector does not exist"));

    await storeEmbedding("project-1", "page:3", "page-row-1", "Summary.", { embed: async () => [0.5] });

    expect(mocks.prisma.embedding.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ metadata: { vectorStored: false, error: "type vector does not exist" } })
    });
  });
});

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

  it("does nothing when the page recorded no continuity notes", async () => {
    await updateEntityStateFromPage("project-1", 10, []);

    expect(mocks.prisma.character.findMany).not.toHaveBeenCalled();
  });
});
