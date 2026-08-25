import { beforeEach, describe, expect, it, vi } from "vitest";

// No app is built here — these run straight on the transaction client — so
// only the two modules this lane's imports actually reach are mocked.
vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());

import {
  rewriteIncomingLibraryMentions,
  unlinkIncomingLibraryMentions
} from "./libraryMentionRewrites.js";
import { replaceLibraryMentions } from "./libraryMentionLinks.js";
import { LibraryMentionError } from "./httpErrors.js";
import { incomingLibraryMentionOrder, libraryMentionInclude } from "@book-maker/db/libraryMentions";
import { CharacterRowMovedError } from "./characterRowClaims.js";
import {
  characterClaimReturns,
  claimedCharacterRows,
  mockPrisma,
  rawStatementsMatching,
  resetCharacterMocks
} from "./testing/mobileApiMocks.js";

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
 * A rename and a delete, from the target's side: who is holding the `@markers`
 * that name it, and what it costs to put every one of them right.
 *
 * Split out of `libraryMentionLinks.test.ts` when that suite reached its size
 * budget, and split where the module did — that file is the write a description
 * makes to its own links, this one is `libraryMentionRewrites.ts`, which
 * touches every row *but* the one the request is about. So the assertions here
 * are the lock, the claim, the re-read under it, and the statement count: none
 * of them is visible in what either function returns.
 */
describe("durable mention links", () => {
  const tx = () => mockPrisma as never;

  beforeEach(() => {
    vi.resetAllMocks();
    resetCharacterMocks();
  });

  type MentionLink = { id: string; name: string; kind?: "CHARACTER" | "LOCATION" };

  function incoming(description: string, links: MentionLink[], name = "Mina") {
    return [
      {
        sourceCharacter: {
          id: "char-source",
          userId: "user-a",
          name,
          description,
          outgoingMentions: links.map(({ kind, ...targetCharacter }) => ({
            targetKind: kind ?? "CHARACTER",
            targetCharacter
          }))
        }
      }
    ];
  }

  function mentioning(description: string, links: MentionLink[], name = "Mina") {
    const rows = incoming(description, links, name);
    mockPrisma.libraryMention.findMany.mockResolvedValue(rows);
    mockPrisma.libraryCharacter.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(rows[0]!.sourceCharacter);
    return rows[0]!.sourceCharacter;
  }

  /**
   * The one statement every moved description is written by, and the pairs it
   * carried.
   *
   * There is no `libraryCharacter.update` holding these arguments any more: the
   * ids and the new prose travel as two parallel bound arrays on `$executeRaw`,
   * positionally after the `updatedAt` stamp. So every assertion about *which
   * row got which sentence* reads them back off the statement rather than off a
   * model mock — which is also the only way to say that the descriptions are
   * bound values and not text spliced into SQL.
   *
   * `UPDATE "LibraryCharacter"` is what separates it from this lane's other two
   * raw statements: the target lock ends in `FOR UPDATE` and the claim selects
   * `FROM "LibraryCharacter"`, and neither spells the verb in front of the
   * table. `rawStatementsMatching` merges both raw call lists in invocation
   * order, so that clause is still the whole test; which mock carried it is
   * asserted on its own below.
   */
  const SET_UPDATE = 'UPDATE "LibraryCharacter"';

  function rewrittenBy(statement: unknown[]): Array<{ id: string; description: string }> {
    const [, , ids = [], descriptions = []] = statement as [readonly string[], Date, string[], string[]];
    return ids.map((id, index) => ({ id, description: descriptions[index] ?? "" }));
  }

  /** The pairs the most recent set update wrote — `[]` when none ever ran. */
  function lastRewrite(): Array<{ id: string; description: string }> {
    const last = rawStatementsMatching(SET_UPDATE).at(-1);
    return last ? rewrittenBy(last) : [];
  }

  it("renames and unlinks only the spans the target itself claims", async () => {
    mentioning("@Luna and @Luna Vega", [
      { id: "char-luna", name: "Luna" },
      { id: "char-vega", name: "Luna Vega" }
    ]);

    await rewriteIncomingLibraryMentions(tx(), "char-luna", "Luna", "Nova");
    expect(lastRewrite()).toEqual([{ id: "char-source", description: "@Nova and @Luna Vega" }]);

    await unlinkIncomingLibraryMentions(tx(), "char-luna", "Luna");
    expect(lastRewrite()).toEqual([{ id: "char-source", description: "Luna and @Luna Vega" }]);
  });

  it("rewrites the span nested in the source's own name, because the save bound it", async () => {
    // One candidate set, or the two sides bind different tokens. The editor
    // resolves a description against the library *minus* the character being
    // edited (`excludeCharacterId`), and the save writes what that resolution
    // produced: in "Luna Vega"'s own description both of these tokens are
    // Luna's. Letting the source's own longer name claim the first one on the
    // rename and delete paths only left an "@Luna Vega" naming a character
    // that had been renamed away, sitting in text nothing scans again.
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([{ id: "char-luna", name: "Luna" }]);
    const description = "@Luna Vega is my hero and @Luna is my friend.";

    await replaceLibraryMentions(tx(), {
      sourceCharacterId: "char-1",
      userId: "user-a",
      description,
      mentionedCharacterIds: ["char-luna"]
    });
    expect(mockPrisma.libraryMention.createMany).toHaveBeenCalledWith({
      data: [libraryMentionWrite("char-luna", 0)]
    });

    mentioning(description, [{ id: "char-luna", name: "Luna" }], "Luna Vega");

    await rewriteIncomingLibraryMentions(tx(), "char-luna", "Luna", "Nova");
    expect(lastRewrite()).toEqual([
      { id: "char-source", description: "@Nova Vega is my hero and @Nova is my friend." }
    ]);

    await unlinkIncomingLibraryMentions(tx(), "char-luna", "Luna");
    expect(lastRewrite()).toEqual([
      { id: "char-source", description: "Luna Vega is my hero and Luna is my friend." }
    ]);
  });

  it("keeps a location row out of the claim set, and reads the kind to do it", async () => {
    // Location and Other share this table, and `targetCharacterId` is a column
    // on the row rather than a property of the kind — so a location filled in
    // with one would otherwise put its name into the scan and hold the span
    // against the character who actually owns it.
    mentioning("@Luna Vega is here.", [
      { id: "char-luna", name: "Luna" },
      { id: "loc-1", name: "Luna Vega", kind: "LOCATION" }
    ]);

    await rewriteIncomingLibraryMentions(tx(), "char-luna", "Luna", "Nova");

    expect(lastRewrite()).toEqual([{ id: "char-source", description: "@Nova Vega is here." }]);
    // The filter only means something if the column is read, and the select is
    // the only place that decides whether it is.
    const [query] = mockPrisma.libraryMention.findMany.mock.calls.at(-1)!;
    expect(query.include.sourceCharacter.select.outgoingMentions.select).toMatchObject({
      targetKind: true
    });
  });

  it("scans each source's rows in the include's order, which its own select bypasses", async () => {
    // A hand-written `select` inherits none of the include's arrangement, and
    // this one asked for no order at all — so the candidate list `claimingNames`
    // hands the whole-set scan came back in whatever order the plan produced,
    // past the one place that order is argued about. Today `claimAt` reads the
    // whole set and is indifferent to its sequence; nothing said so, and the
    // rule that a source's rows must never come back tied lives in the include
    // this select does not go through. Compared against that value rather than
    // respelled here: two spellings of an ordering are how the include's
    // argument comes to be true of one read of these rows and not the other.
    mentioning("@Luna is here.", [{ id: "char-luna", name: "Luna" }]);

    await rewriteIncomingLibraryMentions(tx(), "char-luna", "Luna", "Nova");

    const [query] = mockPrisma.libraryMention.findMany.mock.calls.at(-1)!;
    expect(query.include.sourceCharacter.select.outgoingMentions.orderBy).toEqual(
      libraryMentionInclude.outgoingMentions.orderBy
    );
    // And the read *around* it, which had no order at all: an ordered list of
    // mentions inside a list of characters the plan sequenced. It decides no
    // write order — the rewrite below moves every changed row in one statement —
    // but it does decide which sibling the refusal names where a rename is too
    // long for more than one of them.
    expect(query.orderBy).toBe(incomingLibraryMentionOrder);
  });

  it("hands that order over as a disposable copy, because this select is a module constant", async () => {
    // Nothing is frozen: `libraryMentionInclude` splices the declaration
    // itself, `@book-maker/db`'s one deliberate holder of it. A second holder
    // here would not be, because this select is one object every rename and
    // delete read shares — an appending normaliser would grow it a term per
    // query and a rewriting one would re-sort every later read, and the
    // damage would outlive the request. `orderBy` is therefore a getter over
    // `libraryMentionOrderArgs()`, the export that survives for this select.
    mentioning("@Luna is here.", [{ id: "char-luna", name: "Luna" }]);

    await rewriteIncomingLibraryMentions(tx(), "char-luna", "Luna", "Nova");

    const [query] = mockPrisma.libraryMention.findMany.mock.calls.at(-1)!;
    const mentions = query.include.sourceCharacter.select.outgoingMentions;
    const first = mentions.orderBy;
    const second = mentions.orderBy;
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    // Unfrozen at both levels, which is what makes the write below a real
    // write: a frozen term throws under this module's strict mode instead of
    // landing, and the containment check after it would measure nothing.
    expect(Object.isFrozen(first)).toBe(false);
    expect(first.every((term: unknown) => !Object.isFrozen(term))).toBe(true);
    first[0].targetKind = "desc";
    expect(mentions.orderBy).toEqual(libraryMentionInclude.outgoingMentions.orderBy);
  });

  it("never rewrites the case-variant sibling's token", async () => {
    mentioning("@Bram met @bram.", [
      { id: "char-upper", name: "Bram" },
      { id: "char-lower", name: "bram" }
    ]);

    await rewriteIncomingLibraryMentions(tx(), "char-upper", "Bram", "Brom");

    expect(lastRewrite()).toEqual([{ id: "char-source", description: "@Brom met @bram." }]);
  });

  it("leaves a ZWNJ-joined Persian name whole on rename and on delete", async () => {
    // Written with escapes: the joiner is invisible, and it is the whole point.
    const ali = "\u0639\u0644\u06cc";
    const alireza = `${ali}\u200c\u0631\u0636\u0627`;
    const description = `\u0647\u0645\u0631\u0627\u0647 @${alireza}`;
    mentioning(description, [
      { id: "char-ali", name: ali },
      { id: "char-alireza", name: alireza }
    ]);

    await rewriteIncomingLibraryMentions(tx(), "char-ali", ali, "\u0646\u0648\u0627");
    await unlinkIncomingLibraryMentions(tx(), "char-ali", ali);

    // The short name is a sub-token of the longer one, so it claims nothing
    // and nothing is written.
    expect(rawStatementsMatching(SET_UPDATE)).toEqual([]);
  });

  it("names the character whose description blocks a rename", async () => {
    mentioning(`${"x".repeat(1_990)} @Bram`, [{ id: "char-bram", name: "Bram" }]);

    const failure = await rewriteIncomingLibraryMentions(
      tx(),
      "char-bram",
      "Bram",
      "B".repeat(80)
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LibraryMentionError);
    const error = failure as LibraryMentionError;
    // The wire code app builds already installed received; the noun is stale on
    // purpose, because renaming it is a client that stops recognising it.
    expect(error.code).toBe("CHARACTER_MENTION_TOO_LONG");
    // The blocker is somebody else's description; a cuid tells the reader
    // nothing about which character to go and shorten.
    expect(error.message).toContain("Mina");
    expect(error.message).not.toContain("char-source");
    expect(rawStatementsMatching(SET_UPDATE)).toEqual([]);
  });

  it("rewrites the description the source claim found, not the mention-list snapshot", async () => {
    // A concurrent PATCH of Mina can commit while this rename waits on her
    // row. Stripping the snapshot taken before the lock would overwrite
    // "She loves tea." with a rewrite of the older sentence.
    const snapshot = mentioning("Friends with @Bram.", [{ id: "char-bram", name: "Bram" }]);
    const live = { ...snapshot, description: "Friends with @Bram. She loves tea." };
    // The re-read is the same query as the pre-claim read, taken again once the
    // row locks are held, so the live prose arrives on the even call. Note
    // `mentioning` left the stale row on `findFirst`: a per-source read would
    // still hand back the sentence Mina no longer has.
    let read = 0;
    mockPrisma.libraryMention.findMany.mockImplementation(async () =>
      read++ % 2 === 0 ? [{ sourceCharacter: snapshot }] : [{ sourceCharacter: live }]
    );

    await rewriteIncomingLibraryMentions(tx(), "char-bram", "Bram", "Bramwell");
    expect(lastRewrite()).toEqual([
      { id: "char-source", description: "Friends with @Bramwell. She loves tea." }
    ]);

    await unlinkIncomingLibraryMentions(tx(), "char-bram", "Bram");
    expect(lastRewrite()).toEqual([
      { id: "char-source", description: "Friends with Bram. She loves tea." }
    ]);
  });

  it("refuses to rewrite a mentioning character whose row moved", async () => {
    mentioning("Friends with @Bram.", [{ id: "char-bram", name: "Bram" }]);
    characterClaimReturns(0);

    await expect(rewriteIncomingLibraryMentions(tx(), "char-bram", "Bram", "Bramwell")).rejects.toBeInstanceOf(
      CharacterRowMovedError
    );
    await expect(unlinkIncomingLibraryMentions(tx(), "char-bram", "Bram")).rejects.toBeInstanceOf(
      CharacterRowMovedError
    );
    expect(rawStatementsMatching(SET_UPDATE)).toEqual([]);
  });

  /**
   * The window the empty answer used to be read out of.
   *
   * A source set of none returns having claimed nothing, so the delete rests
   * entirely on nobody being able to *become* a source afterwards — and the row
   * claim does not hold them, for the reason `lockMentionTarget` gives. Pinned
   * on the empty case especially: it is the one that returns before any other
   * statement could stand in for the lock.
   */
  it("locks the target before asking who mentions it, and does so when nobody does", async () => {
    for (const lane of [
      () => unlinkIncomingLibraryMentions(tx(), "char-bram", "Bram"),
      () => rewriteIncomingLibraryMentions(tx(), "char-bram", "Bram", "Bramwell")
    ]) {
      vi.resetAllMocks();
      resetCharacterMocks();
      // Nobody mentions the target — as far as a read nothing is holding still
      // can tell.
      mockPrisma.libraryMention.findMany.mockResolvedValue([]);

      await lane();

      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
      const [sql, bound] = mockPrisma.$queryRaw.mock.calls[0] as [readonly string[], string];
      expect(sql.join("?")).toMatch(/"LibraryCharacter"[\s\S]*FOR UPDATE/);
      // Bound, not interpolated: this is the one raw statement in the group.
      expect(bound).toBe("char-bram");
      expect(mockPrisma.$queryRaw.mock.invocationCallOrder[0]!).toBeLessThan(
        mockPrisma.libraryMention.findMany.mock.invocationCallOrder[0]!
      );
      // And the early return is otherwise untouched: an empty set still claims
      // nothing, re-reads nothing and writes nothing.
      expect(roundTrips()).toEqual({
        targetLocks: 1,
        mentionReads: 1,
        claims: 0,
        sourceReads: 0,
        writes: 0,
        modelWrites: 0
      });
    }
  });

  /**
   * One rename, many mentioning characters, and the statements it takes.
   *
   * Nothing about the result of these two functions says how many round trips
   * they cost, so the count is asserted directly. `LIBRARY_CHARACTER_LIMIT_PER_USER`
   * is 100, so a loop that claims, re-reads and writes one source at a time is
   * ~300 statements inside one interactive transaction — every one of them
   * holding a row lock on somebody else's character until it commits. Claiming
   * the set in one statement took that to ~102; the write is the last of the
   * three that grew with the library, and a set update takes it to **five,
   * whatever the library holds**.
   */
  function mentioningMany(count: number, description: (index: number) => string) {
    const rows = Array.from({ length: count }, (_, index) => ({
      sourceCharacter: {
        id: `char-source-${index}`,
        userId: "user-a",
        name: `Mina ${index}`,
        description: description(index),
        outgoingMentions: [
          { targetKind: "CHARACTER", targetCharacter: { id: "char-bram", name: "Bram" } }
        ]
      }
    }));
    mockPrisma.libraryMention.findMany.mockResolvedValue(rows);
    mockPrisma.libraryCharacter.findFirst.mockImplementation(async ({ where }: { where: { id?: string } }) => {
      return rows.find((row) => row.sourceCharacter.id === where.id)?.sourceCharacter ?? null;
    });
    return rows;
  }

  const roundTrips = () => ({
    targetLocks: rawStatementsMatching("FOR UPDATE").length,
    mentionReads: mockPrisma.libraryMention.findMany.mock.calls.length,
    claims: rawStatementsMatching("FOR NO KEY UPDATE").length,
    sourceReads: mockPrisma.libraryCharacter.findFirst.mock.calls.length,
    // The write is a statement of this lane's own now, not a model call, so it
    // is counted where the lock and the claim are — on `$executeRaw` rather
    // than `$queryRaw`, which the helper merges. A `libraryCharacter.update`
    // reappearing here would be counted by neither, which is why the model mock
    // is asserted silent beside it.
    writes: rawStatementsMatching(SET_UPDATE).length,
    modelWrites: mockPrisma.libraryCharacter.update.mock.calls.length
  });

  it("costs one claim, one read and one write however many characters mention the target", async () => {
    // 99 is the real ceiling — `LIBRARY_CHARACTER_LIMIT_PER_USER` minus the
    // character being renamed — so it is the number the count is pinned at,
    // beside the one and the thirty that show the statement count not moving
    // with it.
    for (const sources of [1, 30, 99]) {
      vi.resetAllMocks();
      resetCharacterMocks();
      // Two thirds of them still say `@Bram`; the rest hold a link whose token
      // an earlier edit already took out of the prose, and those rows have
      // nothing to write.
      const changing = Math.ceil((sources * 2) / 3);
      mentioningMany(sources, (index) => (index < changing ? "Friends with @Bram." : "Keeps to herself."));

      await rewriteIncomingLibraryMentions(tx(), "char-bram", "Bram", "Bramwell");

      // Lock the target, read the set, claim the set, read it again under the
      // claim, write the set: five statements whatever the library holds. The
      // write used to be `changing` of them, awaited one after another while
      // every one of those rows was locked.
      expect(roundTrips()).toEqual({
        targetLocks: 1,
        mentionReads: 2,
        claims: 1,
        sourceReads: 0,
        writes: 1,
        modelWrites: 0
      });
      // And the one write carries exactly the rows whose prose moved, each with
      // its own sentence — the property a set update has to buy back from the
      // loop it replaced, since one statement giving every row one value is the
      // other way this could have gone.
      expect(lastRewrite()).toEqual(
        Array.from({ length: changing }, (_, index) => ({
          id: `char-source-${index}`,
          description: "Friends with @Bramwell."
        }))
      );
      // And the one claim asserts exactly what the per-row claims did — every
      // source, by id and owner, still carrying the name the read found.
      expect(claimedCharacterRows()).toEqual(
        Array.from({ length: sources }, (_, index) => ({
          id: `char-source-${index}`,
          userId: "user-a",
          name: `Mina ${index}`
        }))
      );
    }
  });

  it("gives each row its own sentence, and binds every one of them", async () => {
    // The failure a set update can have that a loop cannot: one value landing
    // on every row. Three siblings, three different rewrites — the token sits
    // in a different place in each, so a statement that broadcast one
    // description would be visible as prose belonging to somebody else.
    const descriptions = [
      "@Bram is my brother.",
      "I have never met @Bram, and I do not care to.",
      "Ask @Bram about the {braces}, the \"quotes\", the back\\slash\nand the newline."
    ];
    mentioningMany(3, (index) => descriptions[index]!);

    await unlinkIncomingLibraryMentions(tx(), "char-bram", "Bram");

    expect(lastRewrite()).toEqual([
      { id: "char-source-0", description: "Bram is my brother." },
      { id: "char-source-1", description: "I have never met Bram, and I do not care to." },
      {
        id: "char-source-2",
        description: 'Ask Bram about the {braces}, the "quotes", the back\\slash\nand the newline.'
      }
    ]);
    // Bound, never spliced: the prose is in the statement's *values*, and the
    // SQL either side of it is the same string whatever anybody's description
    // holds. The braces, quotes and backslash above are the characters a
    // Postgres array literal is built out of, so a description that reached the
    // text of the query would be visible here — and would be an injection
    // rather than a formatting bug.
    const [sql] = rawStatementsMatching(SET_UPDATE).at(-1) as [readonly string[]];
    expect(sql.join("?")).not.toContain("Bram");
    expect(sql.join("?")).toMatch(/unnest\(\?::text\[\], \?::text\[\]\)/);
  });

  it("stamps updatedAt in the same statement, because Prisma is no longer doing it", async () => {
    // `libraryCharacter.update` stamped `@updatedAt` on every row it wrote, and
    // the column is not bookkeeping: `character_avatar.dart` spends it as the
    // portrait URL's `v=` cache-buster, so a sibling whose prose moved and
    // whose stamp did not is a device holding the old description until
    // something else edits that row. A raw statement stamps nothing on its own.
    mentioningMany(2, () => "Friends with @Bram.");
    const before = Date.now();

    await rewriteIncomingLibraryMentions(tx(), "char-bram", "Bram", "Bramwell");

    const [sql, stamped] = rawStatementsMatching(SET_UPDATE).at(-1) as [readonly string[], Date];
    expect(sql.join("?")).toContain('"updatedAt" = ?');
    // Bound from this process's clock rather than written as
    // `CURRENT_TIMESTAMP`, which is the *transaction's* start time — taken
    // before the target lock, the two reads and the wait for the claim, and so
    // capable of landing behind a sibling PATCH that committed in that window.
    expect(stamped).toBeInstanceOf(Date);
    expect(stamped.getTime()).toBeGreaterThanOrEqual(before);
    expect(stamped.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("writes through $executeRaw, and leaves the lock and the claim on $queryRaw", async () => {
    // `$queryRaw` is specified for statements that *return rows*, and this one
    // returns none — it worked only because `@prisma/adapter-pg` happens to
    // answer a `RETURNING`-less command with an empty result set, so an adapter
    // that started checking the statement kind would have failed every rename
    // and every delete of a mentioned character at runtime with nothing in the
    // type system or in this suite to have said so. The split is not
    // bookkeeping either way: `$executeRaw` is what hands back the row count the
    // statement is the only place to learn, and the two row-locking reads above
    // it would lose their answers on the same move in the other direction.
    mentioning("Friends with @Bram.", [{ id: "char-bram", name: "Bram" }]);

    await rewriteIncomingLibraryMentions(tx(), "char-bram", "Bram", "Bramwell");

    const sqlOf = (calls: unknown[]) =>
      (calls as unknown[][]).map((call) => (call[0] as readonly string[]).join("?"));
    const executed = sqlOf(mockPrisma.$executeRaw.mock.calls);
    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain(SET_UPDATE);
    const queried = sqlOf(mockPrisma.$queryRaw.mock.calls);
    expect(queried.filter((sql) => sql.includes(SET_UPDATE))).toEqual([]);
    expect(queried.filter((sql) => sql.includes("FOR UPDATE"))).toHaveLength(1);
    expect(queried.filter((sql) => sql.includes("FOR NO KEY UPDATE"))).toHaveLength(1);
  });

  it("refuses a set update that moved fewer rows than the claim is holding", async () => {
    // Every id in the statement came out of the re-read taken under
    // `claimCharacterRows`' `FOR NO KEY UPDATE`, so this transaction holds all
    // of them and nothing can take one away: a short count is the set not being
    // what the claim proved — a duplicate id, a lost binding, an `unnest` that
    // stopped meaning what it means. Committing it leaves the rows it missed
    // holding an `@Bram` for a character that has been renamed, in prose no
    // later scan reaches. The count was thrown away while the statement was a
    // `$queryRaw`, so nothing could have noticed.
    mentioningMany(3, () => "Friends with @Bram.");
    mockPrisma.$executeRaw.mockResolvedValue(2);

    await expect(rewriteIncomingLibraryMentions(tx(), "char-bram", "Bram", "Bramwell")).rejects.toBeInstanceOf(
      CharacterRowMovedError
    );
  });

  it("never issues the statement for a set of none, so nothing to write is not a short update", async () => {
    // The legitimately-zero case, and it is legitimate: a source can hold a
    // link whose `@token` an earlier edit already took out of its prose, so a
    // rewrite over a whole claimed set routinely produces nothing to write. It
    // returns above the statement rather than running one and reading `0` back,
    // which is what keeps the check above from refusing a rename nobody had a
    // reason to refuse — the mock is told to answer `0` here to make the point
    // that it is never asked.
    mockPrisma.$executeRaw.mockResolvedValue(0);
    mentioningMany(3, () => "Keeps to herself.");

    await expect(rewriteIncomingLibraryMentions(tx(), "char-bram", "Bram", "Bramwell")).resolves.toBeUndefined();
    await expect(unlinkIncomingLibraryMentions(tx(), "char-bram", "Bram")).resolves.toBeUndefined();
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  it("refuses the whole batch when the claim comes back one row short", async () => {
    // Somebody renamed one of the thirty while this rename was building its
    // claim. The batch cannot say which, and does not have to: a short count is
    // the answer the per-row claim gave, on the same retryable error, before
    // anybody's description is touched.
    mentioningMany(30, () => "Friends with @Bram.");
    characterClaimReturns(29);

    await expect(rewriteIncomingLibraryMentions(tx(), "char-bram", "Bram", "Bramwell")).rejects.toBeInstanceOf(
      CharacterRowMovedError
    );
    await expect(unlinkIncomingLibraryMentions(tx(), "char-bram", "Bram")).rejects.toBeInstanceOf(
      CharacterRowMovedError
    );
    expect(rawStatementsMatching(SET_UPDATE)).toEqual([]);
  });
});
