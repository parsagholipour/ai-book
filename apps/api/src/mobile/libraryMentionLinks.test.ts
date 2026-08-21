import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import {
  CHARACTER_MENTION_KIND,
  REPLACED_MENTION_KINDS,
  replaceLibraryMentions
} from "./libraryMentionLinks.js";
import { libraryMentionTargetSchema } from "./characterSchemas.js";
import { libraryMentionRefs, survivingMentionIds } from "./libraryMentionRows.js";
import { LibraryMentionError } from "./httpErrors.js";
import { generationDescription, libraryMentionInclude } from "@book-maker/db/libraryMentions";
import { serializeLibraryCharacter } from "./characterSerializer.js";
import {
  bearer,
  buildMobileApp,
  mockAccessTokens,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";
import { mockPrisma, resetCharacterMocks } from "./testing/mobileApiMocks.js";

/**
 * A mention table that filters the way the database does, because the hazard
 * is a `where` that reaches wider than the rows the write puts back.
 */
function mentionTable(rows: Array<{ sourceCharacterId: string; targetKind: string; targetId: string }>) {
  const table = [...rows];
  mockPrisma.libraryMention.deleteMany.mockImplementation(async ({ where }: { where: any }) => {
    const kinds: string[] | undefined =
      where.targetKind?.in ?? (typeof where.targetKind === "string" ? [where.targetKind] : undefined);
    const doomed = table.filter(
      (row) => row.sourceCharacterId === where.sourceCharacterId && (!kinds || kinds.includes(row.targetKind))
    );
    for (const row of doomed) table.splice(table.indexOf(row), 1);
    return { count: doomed.length };
  });
  mockPrisma.libraryMention.createMany.mockImplementation(async ({ data }: { data: any[] }) => {
    table.push(...data);
    return { count: data.length };
  });
  return table;
}

/**
 * One row as `storedMentionLinks` reads it back: the three columns the
 * "did these links already move" comparison is made of, and the join the drop
 * is named through. A stored row carrying no join is one nothing can name —
 * `libraryMentionCharacterRefs` drops it, and its marker is one this write
 * cannot locate.
 */
function storedLink(target: { id: string; name: string }, sortOrder: number) {
  return {
    targetKind: "CHARACTER" as const,
    targetId: target.id,
    sortOrder,
    targetCharacter: { id: target.id, name: target.name }
  };
}

function libraryMentionWrite(targetId: string, sortOrder: number) {
  return {
    sourceCharacterId: "char-1",
    targetKind: "CHARACTER" as const,
    targetId,
    targetCharacterId: targetId,
    otherType: null,
    sortOrder
  };
}

/**
 * One source's stored links, as `libraryMentionInclude` hands them over.
 *
 * A LOCATION entry is built the way the arc CHECK forces one — `targetId` and
 * no join at all — because that is the row every reader here has to decide
 * about, and the deciding is on the kind.
 */
function linkedTo(targets: ReadonlyArray<{ id: string; name?: string; kind?: "CHARACTER" | "LOCATION" }>) {
  return {
    outgoingMentions: targets.map(({ id, name, kind }, sortOrder) =>
      kind === "LOCATION"
        ? { ...libraryMentionWrite(id, sortOrder), targetKind: "LOCATION" as const, targetCharacterId: null, targetCharacter: null }
        : { ...libraryMentionWrite(id, sortOrder), targetCharacter: { id, name: name ?? id } }
    )
  };
}

/**
 * The durable side, unit level: these run on the transaction client the routes
 * hand them, and every one of them is a whole-set claim rather than a scan of
 * one name in isolation.
 *
 * Narrowed to the *outgoing* write — the links one description owns
 * (`libraryMentionLinks.ts`). The incoming direction, where a rename or a
 * delete rewrites everybody else's prose under one claim, is
 * `libraryMentionRewrites.test.ts`; the two readings of a row that is already
 * stored are `libraryMentionRows.test.ts`. Each was split off as this file
 * reached its size budget, and each names the module it now sits beside.
 */
describe("durable mention links", () => {
  const tx = () => mockPrisma as never;

  beforeEach(() => {
    vi.resetAllMocks();
    resetCharacterMocks();
  });

  it("links two names that differ only in case, each to its own token", async () => {
    // Both rows are legal — the [userId, name] unique index is case-sensitive —
    // and canonicalizing them one at a time converted both tokens to "@Bram"
    // and then both back to "@bram", so the save always died on the validation
    // and a create took the whole character down with it.
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([
      { id: "char-upper", name: "Bram" },
      { id: "char-lower", name: "bram" }
    ]);

    const { description } = await replaceLibraryMentions(tx(), {
      sourceCharacterId: "char-1",
      userId: "user-a",
      description: "@Bram met @bram.",
      mentionedCharacterIds: ["char-upper", "char-lower"]
    });

    expect(description).toBe("@Bram met @bram.");
    expect(mockPrisma.libraryMention.createMany).toHaveBeenCalledWith({
      data: [libraryMentionWrite("char-upper", 0), libraryMentionWrite("char-lower", 1)]
    });
  });

  it("keeps a nested name out of the longer name's token", async () => {
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([
      { id: "char-luna", name: "Luna" },
      { id: "char-vega", name: "Luna Vega" }
    ]);

    const { description } = await replaceLibraryMentions(tx(), {
      sourceCharacterId: "char-1",
      userId: "user-a",
      description: "@Luna and @Luna Vega",
      mentionedCharacterIds: ["char-vega", "char-luna"]
    });

    expect(description).toBe("@Luna and @Luna Vega");
    // Stored order is first-token order, and the tokens are two distinct spans.
    expect(mockPrisma.libraryMention.createMany).toHaveBeenCalledWith({
      data: [libraryMentionWrite("char-luna", 0), libraryMentionWrite("char-vega", 1)]
    });
  });

  it("resolves the mentioned ids in the caller's order, not the ownership read's", async () => {
    // The `IN` answers in whatever order it likes, so `mentionedTargets`
    // restores the request's through `orderedCharacterRefs` — the same helper
    // the two chat routes reorder with, rather than a second copy of it
    // holding a non-null assertion. The refusal below is where that order is
    // visible: the first mentioned character the prose cannot account for is
    // the one the reader is told to go and re-type.
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([
      { id: "char-luna", name: "Luna" },
      { id: "char-vega", name: "Luna Vega" }
    ]);

    const failure = await replaceLibraryMentions(tx(), {
      sourceCharacterId: "char-1",
      userId: "user-a",
      description: "Nobody is named here at all.",
      mentionedCharacterIds: ["char-vega", "char-luna"]
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LibraryMentionError);
    const error = failure as LibraryMentionError;
    expect(error.code).toBe("INVALID_CHARACTER_MENTION");
    expect(error.message).toBe("The description no longer contains @Luna Vega.");
    expect(mockPrisma.libraryMention.createMany).not.toHaveBeenCalled();
  });

  it("lets an old client save prose that drops a nested link", async () => {
    // No mentionedCharacterIds in the PATCH: the surviving set is derived, and
    // a short link that "survived" on its occurrence inside a longer linked
    // name came back as an id the write then refused — an ordinary prose edit
    // that could not be saved at all.
    const source = linkedTo([
      { id: "char-luna", name: "Luna" },
      { id: "char-vega", name: "Luna Vega" }
    ]);
    const edited = "Only @Luna Vega appears now.";
    const surviving = survivingMentionIds(edited, source);
    expect(surviving).toEqual(["char-vega"]);

    mockPrisma.libraryCharacter.findMany.mockResolvedValue([{ id: "char-vega", name: "Luna Vega" }]);
    await expect(
      replaceLibraryMentions(tx(), {
        sourceCharacterId: "char-1",
        userId: "user-a",
        description: edited,
        mentionedCharacterIds: surviving
      })
    ).resolves.toMatchObject({ description: edited });
  });

  it("takes the marker of a mention the save gives up out of the stored prose", async () => {
    // The rows are the only record of which span a marker sits on, so a save
    // that deletes them and keeps the token strands an `@Mina` naming nobody —
    // and nothing can repair it, because every later scan is driven by the rows
    // this write just removed. The last assertion is why that is not merely
    // untidy: `generationDescription` counts its name list against the
    // surviving rows, finds them equal, takes the strip *by name*, and hands
    // whatever it could not name to the planner brief and to
    // `buildLibraryCharacterPortraitPrompt` with its `@` still on.
    mockPrisma.libraryMention.findMany.mockResolvedValue([
      storedLink({ id: "char-bram", name: "Bram" }, 0),
      storedLink({ id: "char-mina", name: "Mina" }, 1)
    ]);
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([{ id: "char-bram", name: "Bram" }]);

    const { description } = await replaceLibraryMentions(tx(), {
      sourceCharacterId: "char-1",
      userId: "user-a",
      description: "Knows @Bram and @Mina.",
      mentionedCharacterIds: ["char-bram"]
    });

    // The marker goes and the reader's own spelling stays as ordinary prose,
    // exactly as deleting Mina would have left it
    // (`unlinkIncomingLibraryMentions`).
    expect(description).toBe("Knows @Bram and Mina.");
    expect(mockPrisma.libraryMention.createMany).toHaveBeenCalledWith({
      data: [libraryMentionWrite("char-bram", 0)]
    });
    expect(
      generationDescription({ description, ...linkedTo([{ id: "char-bram", name: "Bram" }]) })
    ).toBe("Knows Bram and Mina.");
    // Two questions off one statement: which links this save gives up, and
    // whether it gives up anything at all. The ids alone answer the second and
    // say nothing about *where* a dropped marker sits, so the join is what the
    // strip is spelled with — looked up afterwards it would be a second read of
    // rows this one already holds.
    expect(mockPrisma.libraryMention.findMany).toHaveBeenCalledTimes(1);
    const [query] = mockPrisma.libraryMention.findMany.mock.calls.at(-1)!;
    expect(query.select.targetCharacter).toEqual({ select: { id: true, name: true } });
  });

  it("clears every marker when the save gives up the whole cast", async () => {
    // `PATCH {mentionedCharacterIds: []}` carries no description at all, so
    // this is the one shape where nothing upstream could have taken the tokens
    // out: the request says only "these characters are no longer mentioned",
    // and the prose it is stored beside is whatever the row already held.
    mockPrisma.libraryMention.findMany.mockResolvedValue([
      storedLink({ id: "char-bram", name: "Bram" }, 0),
      storedLink({ id: "char-mina", name: "Mina" }, 1)
    ]);
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([]);

    const { description } = await replaceLibraryMentions(tx(), {
      sourceCharacterId: "char-1",
      userId: "user-a",
      description: "Knows @Bram and @Mina.",
      mentionedCharacterIds: []
    });

    expect(description).toBe("Knows Bram and Mina.");
    expect(mockPrisma.libraryMention.deleteMany).toHaveBeenCalledWith({
      where: { sourceCharacterId: "char-1", targetKind: { in: [...REPLACED_MENTION_KINDS] } }
    });
    expect(mockPrisma.libraryMention.createMany).not.toHaveBeenCalled();
  });

  it("strips a dropped name's own token and leaves the longer one it sits inside", async () => {
    // The strip is handed the survivors as siblings, so its scan is the one
    // scan over dropped ∪ kept that the whole module is built on. Given the
    // dropped name alone it would claim the "@Luna" that opens "@Luna Vega" and
    // strip the marker off the link this write is *storing*.
    const stored = [
      storedLink({ id: "char-luna", name: "Luna" }, 0),
      storedLink({ id: "char-vega", name: "Luna Vega" }, 1)
    ];
    mockPrisma.libraryMention.findMany.mockResolvedValue(stored);
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([{ id: "char-vega", name: "Luna Vega" }]);

    await expect(
      replaceLibraryMentions(tx(), {
        sourceCharacterId: "char-1",
        userId: "user-a",
        description: "@Luna and @Luna Vega",
        mentionedCharacterIds: ["char-vega"]
      })
    ).resolves.toMatchObject({ description: "Luna and @Luna Vega" });

    // And the other way round: the longer name is the one given up, and taking
    // its marker off may not disturb the short one standing on its own.
    mockPrisma.libraryMention.findMany.mockResolvedValue(stored);
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([{ id: "char-luna", name: "Luna" }]);

    await expect(
      replaceLibraryMentions(tx(), {
        sourceCharacterId: "char-1",
        userId: "user-a",
        description: "@Luna and @Luna Vega",
        mentionedCharacterIds: ["char-luna"]
      })
    ).resolves.toMatchObject({ description: "@Luna and Luna Vega" });
  });

  it("strips nothing for a row it created a statement ago, because it can hold no links", async () => {
    // The read is skipped on create, so the drop has nothing to derive from —
    // and there is nothing to derive: a source minted by this transaction is
    // visible to nobody and can hold no stored link to give up. An `@` in that
    // prose that names no selected character is the reader's own text, exactly
    // as it is anywhere else nothing claims it.
    mockPrisma.libraryMention.findMany.mockResolvedValue([storedLink({ id: "char-mina", name: "Mina" }, 0)]);
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([{ id: "char-bram", name: "Bram" }]);

    const { description } = await replaceLibraryMentions(tx(), {
      sourceCharacterId: "char-new",
      userId: "user-a",
      description: "Knows @Bram and @Mina.",
      mentionedCharacterIds: ["char-bram"],
      sourceCreatedInThisTransaction: true
    });

    expect(description).toBe("Knows @Bram and @Mina.");
    expect(mockPrisma.libraryMention.findMany).not.toHaveBeenCalled();
  });

  it("agrees with the set an old client's edit derives, so a derived drop strips nothing twice", async () => {
    // `survivingMentionIds` scans the prose against the source's stored links,
    // and the strip's scan is over dropped ∪ kept — the same set, because
    // everything the derived path keeps came out of the same rows. So a link
    // the reader's own edit already took the token out of has nothing left to
    // strip, and a token that survived inside a longer name is one the strip
    // binds to the same owner that scan did. The two cannot disagree, which is
    // what keeps the derived path from ever meeting the refusal below.
    const source = linkedTo([
      { id: "char-luna", name: "Luna" },
      { id: "char-vega", name: "Luna Vega" }
    ]);
    const edited = "Only @Luna Vega appears now.";
    const surviving = survivingMentionIds(edited, source);
    expect(surviving).toEqual(["char-vega"]);

    mockPrisma.libraryMention.findMany.mockResolvedValue([
      storedLink({ id: "char-luna", name: "Luna" }, 0),
      storedLink({ id: "char-vega", name: "Luna Vega" }, 1)
    ]);
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([{ id: "char-vega", name: "Luna Vega" }]);

    await expect(
      replaceLibraryMentions(tx(), {
        sourceCharacterId: "char-1",
        userId: "user-a",
        description: edited,
        mentionedCharacterIds: surviving
      })
    ).resolves.toMatchObject({ description: edited });
  });

  it("refuses a set the one scan cannot bind rather than storing a link on somebody else's token", async () => {
    // The reverse of the nested case, and the one behaviour the strip changes
    // beyond taking a marker out: asked to keep Luna over prose whose only
    // token is "@Luna Vega", the scan binds that span to the name being given
    // up. Both other endings are worse than the refusal — storing Luna's link
    // on the prefix of a longer name is the nested-token bug the whole-set scan
    // exists to prevent, and stripping the span while writing Luna's row leaves
    // a link whose token nothing can find. No client sends this: the app
    // resolves against the whole library, longest name first, so it would bind
    // that span to Vega too.
    mockPrisma.libraryMention.findMany.mockResolvedValue([
      storedLink({ id: "char-vega", name: "Luna Vega" }, 0)
    ]);
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([{ id: "char-luna", name: "Luna" }]);

    const failure = await replaceLibraryMentions(tx(), {
      sourceCharacterId: "char-1",
      userId: "user-a",
      description: "@Luna Vega",
      mentionedCharacterIds: ["char-luna"]
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LibraryMentionError);
    expect((failure as LibraryMentionError).message).toBe("The description no longer contains @Luna.");
    expect(mockPrisma.libraryMention.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.libraryMention.createMany).not.toHaveBeenCalled();
  });

  it("writes CHARACTER rows with both ids and a null otherType", async () => {
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([{ id: "char-2", name: "Bram" }]);

    await replaceLibraryMentions(tx(), {
      sourceCharacterId: "char-1",
      userId: "user-a",
      description: "Knows @Bram.",
      mentionedCharacterIds: ["char-2"]
    });

    expect(mockPrisma.libraryMention.createMany).toHaveBeenCalledWith({
      data: [libraryMentionWrite("char-2", 0)]
    });
  });

  it("writes nothing at all when the save keeps the cast it already had", async () => {
    // The editor sheet sends `description` and `mentionedCharacterIds` together
    // on every description save, so the ordinary edit — a typo, one sentence
    // added — re-sent the same cast and paid a `deleteMany` plus a `createMany`
    // for it, inside the transaction holding the character's row lock. That
    // pair is also the shape `namesMentionPrimaryKey` exists to translate: two
    // writes of one character that the claim does not serialize meet on
    // [sourceCharacterId, targetKind, targetId], the loser deleting nothing and
    // inserting onto rows already there, and the reader is handed a 409 to
    // retry for a save that asked for no link change at all. A save with
    // nothing to write cannot lose that race.
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([{ id: "char-2", name: "Bram" }]);
    mockPrisma.libraryMention.findMany.mockResolvedValue([
      { targetKind: "CHARACTER", targetId: "char-2", sortOrder: 0 }
    ]);

    const { description } = await replaceLibraryMentions(tx(), {
      sourceCharacterId: "char-1",
      userId: "user-a",
      description: "Still knows @Bram, and now bakes bread.",
      mentionedCharacterIds: ["char-2"]
    });

    // The prose still comes back canonicalized; it is the links that had
    // nowhere to move.
    expect(description).toBe("Still knows @Bram, and now bakes bread.");
    expect(mockPrisma.libraryMention.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.libraryMention.createMany).not.toHaveBeenCalled();
    // What it reads instead is exactly the rows the delete would have taken, in
    // the order the include argues for: a second spelling of either would
    // compare this write against rows it does not own.
    const [query] = mockPrisma.libraryMention.findMany.mock.calls.at(-1)!;
    expect(query.where).toEqual({
      sourceCharacterId: "char-1",
      targetKind: { in: [...REPLACED_MENTION_KINDS] }
    });
    expect(query.orderBy).toEqual(libraryMentionInclude.outgoingMentions.orderBy);
  });

  it("does not ask a row it created a statement ago what links it already holds", async () => {
    // The read above is a PATCH property. On create the source id was minted by
    // this transaction and is visible to nothing, so it came back empty every
    // time and `stored.length === insertion.length` settled the comparison on
    // its own — a round trip spent inside the transaction holding the new row's
    // lock.
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([{ id: "char-2", name: "Bram" }]);

    const { description } = await replaceLibraryMentions(tx(), {
      sourceCharacterId: "char-new",
      userId: "user-a",
      description: "Knows @Bram.",
      mentionedCharacterIds: ["char-2"],
      sourceCreatedInThisTransaction: true
    });

    expect(description).toBe("Knows @Bram.");
    expect(mockPrisma.libraryMention.findMany).not.toHaveBeenCalled();
    // Only the read is skipped. The delete is what makes the insert safe, so it
    // still runs even where this caller can prove there is nothing to delete.
    expect(mockPrisma.libraryMention.deleteMany).toHaveBeenCalledWith({
      where: { sourceCharacterId: "char-new", targetKind: { in: [...REPLACED_MENTION_KINDS] } }
    });
    expect(mockPrisma.libraryMention.createMany).toHaveBeenCalledTimes(1);
  });

  it("rewrites the same cast when the prose reorders it, and clears one it gives up", async () => {
    // Identical is the same rows in the same order, never the same set:
    // `sortOrder` is where a target's first token falls in the description, so
    // swapping two names keeps the cast and changes every row this write owns.
    // Skipped as a set comparison would skip it, the stored order would go on
    // describing a sentence the book no longer has — and that order is what
    // `expandLibraryCharacterGraph` spends its cast budget in.
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([
      { id: "char-2", name: "Bram" },
      { id: "char-3", name: "Ada" }
    ]);
    mockPrisma.libraryMention.findMany.mockResolvedValue([
      { targetKind: "CHARACTER", targetId: "char-2", sortOrder: 0 },
      { targetKind: "CHARACTER", targetId: "char-3", sortOrder: 1 }
    ]);

    await replaceLibraryMentions(tx(), {
      sourceCharacterId: "char-1",
      userId: "user-a",
      description: "@Ada met @Bram.",
      mentionedCharacterIds: ["char-2", "char-3"]
    });

    expect(mockPrisma.libraryMention.createMany).toHaveBeenCalledWith({
      data: [libraryMentionWrite("char-3", 0), libraryMentionWrite("char-2", 1)]
    });

    // And the other side of the same comparison: an empty batch against stored
    // rows is a change like any other, so the delete runs and only the insert
    // is skipped. Reading "nothing to write" as "nothing to do" here would
    // leave the mentions the reader just cleared sitting on the row.
    mockPrisma.libraryMention.deleteMany.mockClear();
    mockPrisma.libraryMention.createMany.mockClear();
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([]);

    await replaceLibraryMentions(tx(), {
      sourceCharacterId: "char-1",
      userId: "user-a",
      description: "Ada met Bram.",
      mentionedCharacterIds: []
    });

    expect(mockPrisma.libraryMention.deleteMany).toHaveBeenCalledWith({
      where: { sourceCharacterId: "char-1", targetKind: { in: [...REPLACED_MENTION_KINDS] } }
    });
    expect(mockPrisma.libraryMention.createMany).not.toHaveBeenCalled();
  });

  it("replaces only the kinds it writes, so a location link survives a description save", async () => {
    // The delete and the `createMany` behind it name one set of kinds or this
    // is a write API that destroys links it was never given: unfiltered, the
    // delete owns the whole source, so the first PATCH carrying a description
    // would take every LOCATION and OTHER edge with it — silently, permanently,
    // with no reader having touched them.
    const table = mentionTable([
      { sourceCharacterId: "char-1", targetKind: "CHARACTER", targetId: "char-stale" },
      { sourceCharacterId: "char-1", targetKind: "LOCATION", targetId: "loc-1" },
      { sourceCharacterId: "char-other", targetKind: "CHARACTER", targetId: "char-2" }
    ]);
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([{ id: "char-2", name: "Bram" }]);

    await replaceLibraryMentions(tx(), {
      sourceCharacterId: "char-1",
      userId: "user-a",
      description: "Knows @Bram.",
      mentionedCharacterIds: ["char-2"]
    });

    expect(table).toEqual([
      { sourceCharacterId: "char-1", targetKind: "LOCATION", targetId: "loc-1" },
      { sourceCharacterId: "char-other", targetKind: "CHARACTER", targetId: "char-2" },
      libraryMentionWrite("char-2", 0)
    ]);
    // And not narrower than the write either: a kind written but not cleared is
    // a stale row the next save meets on the primary key.
    const [deletion] = mockPrisma.libraryMention.deleteMany.mock.calls.at(-1)!;
    const [insertion] = mockPrisma.libraryMention.createMany.mock.calls.at(-1)!;
    for (const row of insertion.data as Array<{ targetKind: string }>) {
      expect(deletion.where.targetKind.in).toContain(row.targetKind);
    }
  });

  it("keeps the kind it writes inside the kinds it clears, at compile time", () => {
    // The runtime check above only sees the pair as it is today; this one is
    // about which constant depends on which. The written kind used to *be*
    // `REPLACED_MENTION_KINDS[0]`, so widening the delete the way its docblock
    // tells you to — prepend `"LOCATION"` so the delete covers it — retargeted
    // the insert too, and every cast row went in as a LOCATION carrying a
    // `targetCharacterId` that `LibraryMention_target_arc` forbids. The
    // dependency runs the other way now: the delete may be as wide as it likes
    // and this assignment is what fails, here and at the definition, if the
    // kind being written ever leaves the set being cleared.
    const clearedKind: (typeof REPLACED_MENTION_KINDS)[number] = CHARACTER_MENTION_KIND;

    expect(REPLACED_MENTION_KINDS).toContain(clearedKind);
  });

  it("writes rows the arc's own CHARACTER arm accepts", async () => {
    // `libraryMentionTargetSchema` (`characterSchemas.ts`) is the TypeScript
    // copy of `LibraryMention_target_arc`, and no request body reaches it —
    // there is no `targetKind` on any body, so the union parses nothing in
    // production and would drift unnoticed beside the LOCATION library it is
    // waiting for. The batch this writer emits is the one thing that *does*
    // have to satisfy the arc today, so it is what the arc is asked about: the
    // shape half is checked by the compiler (`CharacterMentionRow` is the arm),
    // and this is the refinement the compiler cannot make — that the two ids
    // are the same id.
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([
      { id: "char-2", name: "Bram" },
      { id: "char-3", name: "Ada" }
    ]);

    await replaceLibraryMentions(tx(), {
      sourceCharacterId: "char-1",
      userId: "user-a",
      description: "Knows @Bram and @Ada.",
      mentionedCharacterIds: ["char-2", "char-3"]
    });

    const [insertion] = mockPrisma.libraryMention.createMany.mock.calls.at(-1)!;
    const rows = insertion.data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // The arc is about the three target columns; the arms are `.strict()`, and
      // the row's own two columns are not the arc's business.
      const { sourceCharacterId: _source, sortOrder: _order, ...target } = row;
      expect(libraryMentionTargetSchema.safeParse(target)).toMatchObject({ success: true });
    }
  });

  it("carries the one kind a request body would have to name, which is still none", () => {
    // The tripwire for the arc scaffolding in `characterSchemas.ts`. While this
    // list is CHARACTER alone that union parses nothing: no write body carries a
    // `targetKind`, so this writer picks the kind and the arc is held by the
    // migration CHECK plus the compile-time tie above. A kind added here is the
    // moment that stops being true, and five things land together — a
    // `targetKind` in both write bodies' Zod schemas, the same in their
    // JSON-schema twins, this list, the `targetCharacterId: target.id` in the
    // batch below (true of CHARACTER alone), and the join that gives the new
    // kind a name in `libraryMentionInclude`. Failing here is the reminder;
    // `libraryMentionTargetSchema`'s docblock is the list.
    expect([...REPLACED_MENTION_KINDS]).toEqual([CHARACTER_MENTION_KIND]);
  });

  it("numbers one save from 0 inside a single kind, which is all sortOrder is comparable over", async () => {
    // The reader compares `sortOrder` within a kind and nowhere else —
    // `libraryMentionInclude` (`@book-maker/db`) orders `targetKind` first —
    // because every write restarts the count at 0 and a location write would
    // land its own 0 beside this one's. This is the writer's half of that
    // arrangement, and it is the half no type states: the kind is a column, so
    // a `map` that derived it per row would number two kinds from 0 against a
    // reader that has just been told the numbers are comparable, and the
    // interleaving that came back would be Postgres' choice among equal sort
    // keys. Lifting the kind into a batch parameter is not the fix — it would
    // write the CHARACTER arm's `targetCharacterId` onto a LOCATION row, which
    // `LibraryMention_target_arc` refuses — so the batch is asked instead.
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([
      { id: "char-2", name: "Bram" },
      { id: "char-3", name: "Ada" }
    ]);

    await replaceLibraryMentions(tx(), {
      sourceCharacterId: "char-1",
      userId: "user-a",
      description: "Knows @Bram and @Ada.",
      mentionedCharacterIds: ["char-2", "char-3"]
    });

    const [insertion] = mockPrisma.libraryMention.createMany.mock.calls.at(-1)!;
    const rows = insertion.data as Array<{ targetKind: string; sortOrder: number }>;
    expect(new Set(rows.map((row) => row.targetKind))).toEqual(new Set([CHARACTER_MENTION_KIND]));
    expect(rows.map((row) => row.sortOrder)).toEqual(rows.map((_, position) => position));
  });

  it("hands its caller the rows it wrote, in the shape and order the include reads them back", async () => {
    // The write already holds every row it stored and every name it resolved
    // them from, so the two write routes serialize *this* rather than ending
    // their transaction with one more `findFirst({ include })` — an indexed
    // read plus the nested join, taken while the source's claim and up to 99
    // sibling claims are still held. What makes that substitution safe is the
    // shape and the order: `libraryMentionInclude` returns the row's columns
    // plus `targetCharacter`, sorted by kind, then `sortOrder`, then
    // `targetId`, and this batch is one kind numbered from 0 in first-token
    // order. The columns are asserted against the `createMany` batch itself,
    // which is the same statement the arc test parses — so a join that leaked
    // into the write, or a column that stopped reaching the reader, fails here.
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([
      { id: "char-2", name: "Bram" },
      { id: "char-3", name: "Ada" }
    ]);

    const { mentions } = await replaceLibraryMentions(tx(), {
      sourceCharacterId: "char-1",
      userId: "user-a",
      description: "Knows @Ada and @Bram.",
      mentionedCharacterIds: ["char-2", "char-3"]
    });

    expect(mentions).toEqual([
      { ...libraryMentionWrite("char-3", 0), targetCharacter: { id: "char-3", name: "Ada" } },
      { ...libraryMentionWrite("char-2", 1), targetCharacter: { id: "char-2", name: "Bram" } }
    ]);
    // The join is the reader's, not a column: `createMany` would send it to the
    // engine as an unknown field, and the `.strict()` arc arms refuse it.
    const [batch] = mockPrisma.libraryMention.createMany.mock.calls.at(-1)!;
    expect(batch.data).toEqual([libraryMentionWrite("char-3", 0), libraryMentionWrite("char-2", 1)]);
    // The same rows the reader is handed, so `libraryMentionRefs` over them is
    // the wire list a reload would have produced.
    expect(libraryMentionRefs({ outgoingMentions: mentions })).toEqual([
      { id: "char-3", name: "Ada", kind: "character", otherType: null },
      { id: "char-2", name: "Bram", kind: "character", otherType: null }
    ]);
  });

  it("hands back the stored rows on the save it skips, because that is what the skip proves", async () => {
    // The early return writes nothing — the batch it built equals the rows
    // already stored, column for column, in `libraryMentionOrder` — so the set
    // it hands back describes the database exactly as a read of it would. The
    // two columns the comparison does not make are settled by
    // `LibraryMention_target_arc`: a CHARACTER row's `targetCharacterId` is its
    // `targetId` and its `otherType` is null.
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([{ id: "char-2", name: "Bram" }]);
    mockPrisma.libraryMention.findMany.mockResolvedValue([storedLink({ id: "char-2", name: "Bram" }, 0)]);

    const { mentions } = await replaceLibraryMentions(tx(), {
      sourceCharacterId: "char-1",
      userId: "user-a",
      description: "Knows @Bram.",
      mentionedCharacterIds: ["char-2"]
    });

    expect(mockPrisma.libraryMention.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.libraryMention.createMany).not.toHaveBeenCalled();
    expect(mentions).toEqual([
      { ...libraryMentionWrite("char-2", 0), targetCharacter: { id: "char-2", name: "Bram" } }
    ]);
  });

  it("serializes character mentions with kind character and a null otherType", () => {
    expect(
      libraryMentionRefs({
        outgoingMentions: [
          {
            sourceCharacterId: "char-1",
            targetKind: "CHARACTER",
            targetId: "char-2",
            targetCharacterId: "char-2",
            otherType: null,
            sortOrder: 0,
            targetCharacter: { id: "char-2", name: "Bram" }
          },
          {
            sourceCharacterId: "char-1",
            targetKind: "LOCATION",
            targetId: "loc-1",
            targetCharacterId: null,
            otherType: null,
            sortOrder: 1,
            targetCharacter: null
          }
        ]
      })
    ).toEqual([{ id: "char-2", name: "Bram", kind: "character", otherType: null }]);

    const serialized = serializeLibraryCharacter({
      id: "char-1",
      userId: "user-a",
      name: "Luna",
      description: "Knows @Bram.",
      fields: [],
      photoPath: null,
      photoKind: null,
      suggestedDescription: null,
      appearance: null,
      portraitPath: null,
      portraitSource: null,
      portraitStatus: "NONE",
      portraitError: null,
      portraitJobId: null,
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
      updatedAt: new Date("2026-08-01T10:00:00.000Z"),
      outgoingMentions: [
        {
          sourceCharacterId: "char-1",
          targetKind: "CHARACTER",
          targetId: "char-2",
          targetCharacterId: "char-2",
          otherType: null,
          sortOrder: 0,
          targetCharacter: { id: "char-2", name: "Bram" }
        }
      ]
    });

    expect(serialized.mentions).toEqual([
      { id: "char-2", name: "Bram", kind: "character", otherType: null }
    ]);
  });
});

/**
 * The same derivation at the route, on the one path no app build takes: the
 * editor sheet always sends `description` and `mentionedCharacterIds` together
 * or neither, so this fallback answers old clients only.
 */
describe("PATCH /api/mobile/characters/:id with no mention list", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("saves prose over a stored location link without touching it", async () => {
    const stored = {
      id: "char-1",
      userId: "user-a",
      name: "Luna",
      description: "Knows @Bram, and lives at Thornwood.",
      fields: [],
      photoPath: null,
      photoKind: null,
      suggestedDescription: null,
      appearance: null,
      portraitPath: null,
      portraitSource: null,
      portraitStatus: "NONE",
      portraitError: null,
      portraitJobId: null,
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
      updatedAt: new Date("2026-08-01T10:00:00.000Z"),
      ...linkedTo([{ id: "char-2", name: "Bram" }, { id: "loc-1", kind: "LOCATION" }])
    };
    const table = mentionTable([
      { sourceCharacterId: "char-1", targetKind: "CHARACTER", targetId: "char-2" },
      { sourceCharacterId: "char-1", targetKind: "LOCATION", targetId: "loc-1" }
    ]);
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(stored);
    mockPrisma.libraryCharacter.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([{ id: "char-2", name: "Bram" }]);
    mockPrisma.libraryCharacter.update.mockResolvedValue(stored);
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/mobile/characters/char-1",
      headers: bearer("token-a"),
      payload: { description: "Still knows @Bram, and still lives at Thornwood." }
    });

    // A location id in the derived set is a 404 for a character nobody
    // mentioned: `mentionedTargets` looks every id up in `LibraryCharacter`.
    expect(response.statusCode).toBe(200);
    expect(mockPrisma.libraryMention.createMany).toHaveBeenCalledWith({
      data: [libraryMentionWrite("char-2", 0)]
    });
    expect(table).toEqual([
      { sourceCharacterId: "char-1", targetKind: "LOCATION", targetId: "loc-1" },
      libraryMentionWrite("char-2", 0)
    ]);
    await app.close();
  });
});
