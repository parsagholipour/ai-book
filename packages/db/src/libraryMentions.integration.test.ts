import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, prisma } from "./client.ts";
import {
  incomingLibraryMentionOrder,
  libraryMentionCharacterRefs,
  libraryMentionInclude,
  libraryMentionOrder,
  libraryMentionOrderArgs
} from "./libraryMentions.ts";

/**
 * Opt-in integration suite for the one array every read of a character's
 * mentions is ordered by.
 *
 * `libraryMentionOrder` names the terms every read of these rows is ordered by:
 * `libraryMentionInclude` — every `findFirst`/`findMany` in the mobile API, the
 * worker's portrait handler and `expandLibraryCharacterGraph` — and
 * `incomingSourceSelect`'s hand-written `select`. `incomingLibraryMentionOrder`
 * names the terms of the one read on the other axis — the `findMany` over a
 * *target's* incoming rows that produces those sources, whose own order was
 * missing entirely while the select nested inside it had one. Two things about
 * all that are assumptions rather than measurements, and every character suite
 * in the repo mocks `@book-maker/db` or `prisma`, so none of them could tell:
 *
 *  - **That the ordering the array declares is the ordering Postgres returns.**
 *    `libraryMentions.test.ts` asserts the array's *spelling* and nothing else.
 *    That statement never reaches the database.
 *  - **That Prisma hands the args object back as it was given.** The include
 *    splices the declaration itself, so a client that normalized `orderBy` in
 *    place — no `$use` middleware or `$extends` extension exists in this repo,
 *    but nothing in Prisma's contract rules one out — would change what every
 *    later read of these rows sorts by, at once and with nothing raised. The
 *    last two tests are that measurement: the declaration is compared against
 *    its spelling after a burst of every read shape, and a plain args object is
 *    compared against a `structuredClone` of itself, so the day it stops being
 *    true this suite says *what* was written rather than only that something
 *    was.
 *
 * So the fixture below seeds one source whose rows are inserted in an order
 * that is not `(targetKind, sortOrder, targetId)`, and asserts the read order
 * against every term: drop any one of the three, reorder them, or drop the
 * `orderBy` altogether, and a read here comes back in a different sequence.
 * The kinds are CHARACTER, LOCATION and OTHER — a shape no writer produces
 * today (`REPLACED_MENTION_KINDS` is `["CHARACTER"]` alone), which is exactly
 * why the ordering argument is written down before anything falls into it.
 * Three sources name one target for the incoming half, seeded so that the one
 * sorting first is written last.
 *
 * Run against a migrated database:
 *
 *   DB_INTEGRATION=true DATABASE_URL=... \
 *     pnpm -F @book-maker/db exec vitest run src/libraryMentions.integration.test.ts
 *
 * Without that variable `vitest.config.ts` keeps this file out of collection
 * entirely. Skipping the bodies is not enough on its own: the `prisma` import
 * above builds a client and a pg pool the moment the module is evaluated, in a
 * run that is supposed to need no database. The `skipIf` below is the second
 * guard, for a runner that reaches this file under some other config.
 */
const enabled = process.env.DB_INTEGRATION === "true";

/** One prefix for every id, so `targetId` ordering is a property of the fixture. */
const fixture = `mention-order-${randomUUID()}`;
const userId = `${fixture}-user`;
const sourceAId = `${fixture}-source-a`;
const sourceBId = `${fixture}-source-b`;
/**
 * A third source, named so it sorts *first* and seeded last.
 *
 * The incoming read (`incomingMentionSources`, `apps/api/src/mobile/`) selects
 * on `targetCharacterId` and orders by `incomingLibraryMentionOrder`, whose
 * leading term is the source id — so this row is what gives that assertion
 * teeth. Written after both other sources, it is last in insertion order and
 * first in key order, and a read that dropped the `orderBy` would return it
 * last on any plan that walks the target index in heap order.
 */
const sourceZeroId = `${fixture}-source-0`;
const alphaId = `${fixture}-target-1-alpha`;
const zetaId = `${fixture}-target-2-zeta`;
const locAlpha = `${fixture}-loc-1-alpha`;
const locMike = `${fixture}-loc-2-mike`;
const locZulu = `${fixture}-loc-3-zulu`;
const otherId = `${fixture}-other-1`;

/** The three columns the read order is allowed to look at, as a row carries them. */
type OrderKey = [kind: string, sortOrder: number, targetId: string];

type SeedRow = {
  targetKind: "CHARACTER" | "LOCATION" | "OTHER";
  sortOrder: number;
  targetId: string;
  targetCharacterId?: string;
  otherType?: string;
};

/**
 * Source A's rows, in the order they are written.
 *
 * Deliberately not the read order, and deliberately not any *subset* of it:
 * the CHARACTER pair is written high-`sortOrder` first, the two LOCATION rows
 * that tie on `(kind, sortOrder)` are written high-`targetId` first, and the
 * OTHER row is written second so a kind-blind order cannot land it last by
 * accident. `expectedOrderA` below is the only sequence all three terms agree
 * on; `it("...")` asserts the difference rather than trusting this comment.
 */
const seedA: readonly SeedRow[] = [
  { targetKind: "CHARACTER", sortOrder: 1, targetId: zetaId, targetCharacterId: zetaId },
  { targetKind: "OTHER", sortOrder: 0, targetId: otherId, otherType: "sword" },
  { targetKind: "LOCATION", sortOrder: 0, targetId: locZulu },
  { targetKind: "CHARACTER", sortOrder: 0, targetId: alphaId, targetCharacterId: alphaId },
  { targetKind: "LOCATION", sortOrder: 0, targetId: locAlpha },
  { targetKind: "LOCATION", sortOrder: 1, targetId: locMike }
];

const seedZero: readonly SeedRow[] = [
  { targetKind: "CHARACTER", sortOrder: 0, targetId: alphaId, targetCharacterId: alphaId }
];

const seedB: readonly SeedRow[] = [
  { targetKind: "LOCATION", sortOrder: 0, targetId: locZulu },
  { targetKind: "CHARACTER", sortOrder: 0, targetId: alphaId, targetCharacterId: alphaId }
];

const expectedOrderA: readonly OrderKey[] = [
  ["CHARACTER", 0, alphaId],
  ["CHARACTER", 1, zetaId],
  ["LOCATION", 0, locAlpha],
  ["LOCATION", 0, locZulu],
  ["LOCATION", 1, locMike],
  ["OTHER", 0, otherId]
];

const expectedOrderB: readonly OrderKey[] = [
  ["CHARACTER", 0, alphaId],
  ["LOCATION", 0, locZulu]
];

const orderKeys = (rows: readonly { targetKind: string; sortOrder: number; targetId: string }[]): OrderKey[] =>
  rows.map((row) => [row.targetKind, row.sortOrder, row.targetId]);

/** The declared terms, restated here so a rewrite of the export is a failure. */
const declaredOrder = [{ targetKind: "asc" }, { sortOrder: "asc" }, { targetId: "asc" }];

/**
 * The `select` the API's rename and delete paths read these rows through.
 *
 * Respelled rather than imported: `incomingSourceSelect` lives in
 * `apps/api/src/mobile/libraryMentionRewrites.ts` and this package must not import
 * from `apps/*`. What is *not* respelled is the thing under test — the
 * `orderBy` is a getter over the exported `libraryMentionOrderArgs()`, which is
 * both the whole point of that function being exported and, term for term and
 * shape for shape, what the real select does. That matters more than it looks:
 * this file exists to measure a real client against the args objects production
 * hands it, so a select here that spelled the terms out again would be
 * measuring a read that exists nowhere. The projection is narrow on
 * purpose, exactly as the real one is: `claimingNames` reads the kind and the
 * joined name and nothing else, so this shape cannot see `sortOrder` or
 * `targetId` at all, which is why the include tests above carry the full
 * three-term assertion and this one asserts the sequence its consumer actually
 * observes.
 */
const mentionSourceSelect = {
  id: true,
  userId: true,
  name: true,
  description: true,
  outgoingMentions: {
    get orderBy(): Prisma.LibraryMentionOrderByWithRelationInput[] {
      return libraryMentionOrderArgs();
    },
    select: { targetKind: true, targetCharacter: { select: { id: true, name: true } } }
  }
} as const;

async function seedMentions(sourceCharacterId: string, rows: readonly SeedRow[]): Promise<void> {
  await prisma.libraryMention.createMany({
    data: rows.map((row) => ({
      sourceCharacterId,
      targetKind: row.targetKind,
      targetId: row.targetId,
      sortOrder: row.sortOrder,
      ...(row.targetCharacterId ? { targetCharacterId: row.targetCharacterId } : {}),
      ...(row.otherType ? { otherType: row.otherType } : {})
    }))
  });
}

describe.skipIf(!enabled)("libraryMentionOrder against a real client (opt-in integration)", () => {
  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid` } });
    await prisma.libraryCharacter.createMany({
      data: [
        { id: sourceAId, userId, name: `${fixture} Source A`, description: "Travels with @Alpha and @Zeta.", fields: [] },
        { id: sourceBId, userId, name: `${fixture} Source B`, description: "Writes to @Alpha.", fields: [] },
        { id: sourceZeroId, userId, name: `${fixture} Source Zero`, description: "Also writes to @Alpha.", fields: [] },
        { id: alphaId, userId, name: `${fixture} Alpha`, description: "The one everyone mentions.", fields: [] },
        { id: zetaId, userId, name: `${fixture} Zeta`, description: "Mentioned second.", fields: [] }
      ]
    });
    await seedMentions(sourceAId, seedA);
    await seedMentions(sourceBId, seedB);
    // Last, so insertion order and key order disagree — see `sourceZeroId`.
    await seedMentions(sourceZeroId, seedZero);
  });

  afterAll(async () => {
    // Explicit child-first deletes rather than trusting every FK in an
    // arbitrary DATABASE_URL target to cascade.
    await prisma.libraryMention.deleteMany({
      where: { sourceCharacterId: { in: [sourceAId, sourceBId, sourceZeroId] } }
    });
    await prisma.libraryCharacter.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  /**
   * The fixture's own teeth. Every assertion below compares a read against
   * `expectedOrderA`; if the rows were written in that order, dropping the
   * `orderBy` entirely would still pass on any plan that returns them in heap
   * order. This is the statement that keeps the rest of the suite honest when
   * somebody edits the seed.
   */
  it("is seeded in an order no term of the read order produces", () => {
    expect(orderKeys(seedA)).not.toEqual(expectedOrderA);
    // And it is not merely the *whole* order that differs: each term is
    // load-bearing, so the sequence each pair of terms would produce on its own
    // is also different from the declared one.
    const sorted = (by: (row: SeedRow) => readonly (string | number)[]): OrderKey[] =>
      orderKeys([...seedA].sort((left, right) => (by(left) < by(right) ? -1 : by(left) > by(right) ? 1 : 0)));
    expect(sorted((row) => [row.sortOrder, row.targetKind, row.targetId])).not.toEqual(expectedOrderA);
    expect(sorted((row) => [row.targetKind, row.targetId])).not.toEqual(expectedOrderA);
    expect(sorted((row) => [row.sortOrder, row.targetId])).not.toEqual(expectedOrderA);
    // With all three, and only with all three, it is the declared order.
    expect(sorted((row) => [row.targetKind, row.sortOrder, row.targetId])).toEqual(expectedOrderA);
  });

  it("orders a findFirst through libraryMentionInclude by kind, then position, then key", async () => {
    const source = await prisma.libraryCharacter.findFirst({
      where: { id: sourceAId },
      include: libraryMentionInclude
    });

    expect(orderKeys(source?.outgoingMentions ?? [])).toEqual(expectedOrderA);
  });

  it("orders every source of a findMany, not merely the first", async () => {
    const sources = await prisma.libraryCharacter.findMany({
      where: { id: { in: [sourceAId, sourceBId] } },
      include: libraryMentionInclude,
      orderBy: { id: "asc" }
    });

    expect(sources.map((source) => source.id)).toEqual([sourceAId, sourceBId]);
    expect(orderKeys(sources[0]?.outgoingMentions ?? [])).toEqual(expectedOrderA);
    expect(orderKeys(sources[1]?.outgoingMentions ?? [])).toEqual(expectedOrderB);
  });

  it("orders the read taken inside an interactive transaction", async () => {
    // The PATCH re-read and both mention-rewriting transactions read through a
    // `tx` client rather than this one, which is its own args path.
    const source = await prisma.$transaction((tx) =>
      tx.libraryCharacter.findUnique({ where: { id: sourceAId }, include: libraryMentionInclude })
    );

    expect(orderKeys(source?.outgoingMentions ?? [])).toEqual(expectedOrderA);
  });

  /**
   * The cast, which is what the order is *for*: `expandLibraryCharacterGraph`
   * spends a bounded budget walking this list, so its sequence decides which
   * linked character reaches the planner when the cap bites.
   */
  it("hands the cast back in that order, ids and names joined", async () => {
    const source = await prisma.libraryCharacter.findFirst({
      where: { id: sourceAId },
      include: libraryMentionInclude
    });

    expect(source && libraryMentionCharacterRefs(source)).toEqual([
      { id: alphaId, name: `${fixture} Alpha` },
      { id: zetaId, name: `${fixture} Zeta` }
    ]);
  });

  it("orders the hand-written select the rename and delete paths read", async () => {
    const incoming = await prisma.libraryMention.findMany({
      where: { targetCharacterId: alphaId },
      orderBy: incomingLibraryMentionOrder,
      include: { sourceCharacter: { select: mentionSourceSelect } }
    });
    const sourceA = incoming.find((row) => row.sourceCharacterId === sourceAId)?.sourceCharacter;

    // Kind and joined name is everything this projection carries — see
    // `mentionSourceSelect` — so this is the sequence `claimingNames` sees.
    expect(
      sourceA?.outgoingMentions.map((mention) => [mention.targetKind, mention.targetCharacter?.id ?? null])
    ).toEqual([
      ["CHARACTER", alphaId],
      ["CHARACTER", zetaId],
      ["LOCATION", null],
      ["LOCATION", null],
      ["LOCATION", null],
      ["OTHER", null]
    ]);
    expect(sourceA && libraryMentionCharacterRefs(sourceA)).toEqual([
      { id: alphaId, name: `${fixture} Alpha` },
      { id: zetaId, name: `${fixture} Zeta` }
    ]);
  });

  /**
   * The outer half of that same read, which had no order at all.
   *
   * `incomingSourceSelect` has taken `libraryMentionOrderArgs()` on its nested
   * rows since `claimingNames` was found scanning them in plan order, but the
   * `findMany` that produces the sources carried nothing — an ordered list of
   * mentions inside an unordered list of characters. What the sequence decides
   * is which sibling a `CHARACTER_MENTION_TOO_LONG` refusal names when a rename
   * is too long for more than one description, and which of a source's
   * duplicate rows survives the dedupe below — not the order of any write:
   * `rewriteMentioningDescriptions` moves the whole set in one statement. The
   * fixture is what makes this a measurement: `sourceZeroId` is written last
   * and sorts first.
   */
  it("orders the incoming read by source, ahead of insertion order", async () => {
    const incoming = await prisma.libraryMention.findMany({
      where: { targetCharacterId: alphaId },
      orderBy: incomingLibraryMentionOrder,
      include: { sourceCharacter: { select: mentionSourceSelect } }
    });

    expect(incoming.map((row) => row.sourceCharacterId)).toEqual([sourceZeroId, sourceAId, sourceBId]);
    // And the sources the API dedupes out of those rows come back in the same
    // sequence, which is what the rewrite loop walks.
    const sources = [...new Map(incoming.map((row) => [row.sourceCharacter.id, row.sourceCharacter])).values()];
    expect(sources.map((source) => source.id)).toEqual([sourceZeroId, sourceAId, sourceBId]);
  });

  /**
   * Every read shape at once, against the one declaration all of them carry.
   *
   * The include splices `libraryMentionOrder` itself, so this is where a client
   * that wrote into the args it was handed would show: four concurrent reads
   * through three query shapes, and then the declaration compared against its
   * own spelling. A layer that appended a term, rewrote one, or reordered them
   * would change what every later read of these rows sorts by — the API list
   * route, the PATCH re-read, `expandLibraryCharacterGraph` and the worker's
   * portrait prompt at once — and nothing else in the repo could tell, since
   * every character suite mocks `@book-maker/db` or `prisma`.
   */
  it("leaves the declaration exactly as it was after every read shape at once", async () => {
    expect(libraryMentionInclude.outgoingMentions.orderBy).toBe(libraryMentionOrder);
    // The hand-written select is the one read that holds terms of its own.
    expect(mentionSourceSelect.outgoingMentions.orderBy).not.toBe(libraryMentionOrder);
    expect(mentionSourceSelect.outgoingMentions.orderBy).not.toBe(
      mentionSourceSelect.outgoingMentions.orderBy
    );

    await Promise.all([
      prisma.libraryCharacter.findFirst({ where: { id: sourceAId }, include: libraryMentionInclude }),
      prisma.libraryCharacter.findMany({ where: { userId }, include: libraryMentionInclude }),
      prisma.libraryCharacter.findUnique({ where: { id: sourceBId }, include: libraryMentionInclude }),
      prisma.libraryMention.findMany({
        where: { targetCharacterId: alphaId },
        include: { sourceCharacter: { select: mentionSourceSelect } }
      })
    ]);

    expect(libraryMentionOrder).toEqual(declaredOrder);
    expect(libraryMentionInclude.outgoingMentions.orderBy).toEqual(declaredOrder);
    expect(mentionSourceSelect.outgoingMentions.orderBy).toEqual(declaredOrder);
  });

  /**
   * The same statement made against an args object this test owns outright, so
   * the day Prisma starts normalizing args in place the diff names the field.
   *
   * The test above notices such a write by what it left in the declaration;
   * this one notices it whole, including a client that rewrites args it has
   * already cloned — a mutation the shared declaration would never see, and one
   * that would silently reorder these rows.
   */
  it("gets a plain args object back exactly as it was handed over", async () => {
    const mutableOrder: Prisma.LibraryMentionOrderByWithRelationInput[] = [
      { targetKind: "asc" },
      { sortOrder: "asc" },
      { targetId: "asc" }
    ];
    const args = {
      where: { id: sourceAId },
      include: {
        outgoingMentions: {
          orderBy: mutableOrder,
          include: { targetCharacter: { select: { id: true, name: true } } }
        }
      }
    };
    const before = structuredClone(args);

    const source = await prisma.libraryCharacter.findFirst(args);

    expect(args).toEqual(before);
    expect(args.include.outgoingMentions.orderBy).toBe(mutableOrder);
    // And this array read the same rows the declaration does, so the two halves
    // of this suite are talking about one query.
    expect(orderKeys(source?.outgoingMentions ?? [])).toEqual(expectedOrderA);
  });
});
