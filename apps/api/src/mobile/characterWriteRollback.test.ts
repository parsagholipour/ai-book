import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import {
  bearer,
  buildMobileApp,
  mockAccessTokens,
  mockPrisma,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";
import { mockTransactions, rawStatementsMatching, survivingWrites } from "./testing/mobileApiMocks.js";
import { CHARACTER_MENTION_TRANSACTION_OPTIONS } from "./characterWriteConflicts.js";

/**
 * What a refused character write leaves behind.
 *
 * Every one of the three writes in `routes/characters.ts` refuses from *inside*
 * its transaction — the content screen on the prose that actually lands, a
 * `LibraryMentionError` out of `replaceLibraryMentions`, a lost claim out of the
 * delete — and each of those refusals is argued to be cheap because the
 * statements above it unwind with the throw. That argument was untestable:
 * `runMockTransaction` hands the callback the same mock client and undoes
 * nothing, so a `create` issued a statement before the throw stays in the call
 * list and a route that committed the row before screening it would pass every
 * suite here.
 *
 * It still undoes nothing — the mock has no store to undo — but it now
 * *accounts*: `survivingWrites()` is everything issued minus everything a
 * transaction that threw issued, which is the set a database would still be
 * holding. Each test below therefore pairs a claim with the thing that would
 * break it: a write moved out of the transaction, or committed in one of its
 * own ahead of the screen, shows up as a survivor.
 *
 * Its own suite because it is one story told across all three routes, and
 * because `characters.test.ts` and `characterWriteConflicts.test.ts` are both
 * near their size budget.
 */

/**
 * The one statement that rewrites the descriptions naming this character, and
 * how many times it ran.
 *
 * A set update — `UPDATE "LibraryCharacter" … FROM unnest(…)`, one statement for
 * the whole claimed set — so it lands on a raw mock rather than on a model one:
 * `$executeRaw`, this lane's only raw *write*, where the target lock and the row
 * claim are reads on `$queryRaw`. `UPDATE "LibraryCharacter"` is what tells it
 * from those two in a merged list: the lock ends in `FOR UPDATE` and the claim
 * selects `FROM "LibraryCharacter"`, and neither spells the verb in front of
 * the table.
 */
const SIBLING_REWRITE = 'UPDATE "LibraryCharacter"';

/** The raw write, as `survivingWrites()` names it — the client, not a model. */
const SIBLING_REWRITE_WRITE = "prisma.$executeRaw";

const rewriteAttempts = (): number => rawStatementsMatching(SIBLING_REWRITE).length;

/** The `(id, description)` pairs the last such statement carried. */
function rewrittenDescriptions(): Array<{ id: string; description: string }> {
  const [, , ids = [], descriptions = []] = (rawStatementsMatching(SIBLING_REWRITE).at(-1) ?? []) as [
    readonly string[],
    Date,
    string[],
    string[]
  ];
  return ids.map((id, index) => ({ id, description: descriptions[index] ?? "" }));
}

function characterRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "char-1",
    userId: "user-a",
    name: "Nix",
    description: "A brave night-flying rabbit.",
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
    outgoingMentions: [],
    ...overrides
  };
}

/** A source description that mentions Bram, as `unlinkIncomingLibraryMentions` reads it. */
const mentioningSource = () => [
  {
    sourceCharacter: {
      id: "char-1",
      userId: "user-a",
      name: "Mina",
      description: "Friends with @Bram.",
      outgoingMentions: [{ targetKind: "CHARACTER", targetCharacter: { id: "char-2", name: "Bram" } }]
    }
  }
];

/** One stored outgoing link, as `storedMentionLinks` selects it — the join included. */
const storedLinkTo = (target: { id: string; name: string }) => [
  { targetKind: "CHARACTER", targetId: target.id, sortOrder: 0, targetCharacter: target }
];

const createCharacter = (app: Awaited<ReturnType<typeof buildMobileApp>>, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/mobile/characters", headers: bearer("token-a"), payload });

describe("what a refused character write leaves behind", () => {
  beforeEach(() => {
    resetMobileHarness();
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.libraryCharacter.count.mockResolvedValue(0);
    mockPrisma.libraryCharacter.updateMany.mockResolvedValue({ count: 1 });
  });
  afterEach(teardownMobileHarness);

  it("keeps a create's row and links once the transaction commits", async () => {
    // The control, and the reason the three tests under it are not vacuous:
    // one commit and one throw apart, this is the create below it. A
    // transaction that returns leaves every write it issued behind, in the
    // order it issued them, so an empty answer down there is a measurement
    // rather than the accounting having nothing to say.
    const bram = characterRecord({ id: "char-2", name: "Bram" });
    const stored = characterRecord({ description: "Knows @Bram." });
    mockPrisma.libraryCharacter.create.mockResolvedValue(stored);
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([bram]);
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(stored);
    const app = await buildMobileApp();

    const created = await createCharacter(app, {
      name: "Nix",
      description: "Knows @Bram.",
      mentionedCharacterIds: ["char-2"]
    });

    expect(created.statusCode).toBe(201);
    expect(mockTransactions()).toHaveLength(1);
    expect(mockTransactions()[0]!.rolledBack).toBe(false);
    expect(survivingWrites()).toEqual([
      "libraryCharacter.create",
      "libraryMention.deleteMany",
      "libraryMention.createMany"
    ]);
    await app.close();
  });

  it("loses the row a create wrote when the link set refuses", async () => {
    // `replaceLibraryMentions` refuses a target whose `@Name` the description
    // does not hold — and it refuses from below the `create`, which is the
    // whole reason that refusal is a throw rather than an early return: the row
    // has already been written, and only the transaction can take it back.
    // Split the create out of this transaction, or settle the refusal with a
    // reply instead of a throw, and the character survives with no links and
    // prose naming somebody it is not linked to.
    const bram = characterRecord({ id: "char-2", name: "Bram" });
    mockPrisma.libraryCharacter.create.mockResolvedValue(characterRecord({ description: "Knows nobody." }));
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([bram]);
    const app = await buildMobileApp();

    const refused = await createCharacter(app, {
      name: "Nix",
      description: "Knows nobody.",
      mentionedCharacterIds: ["char-2"]
    });

    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe("INVALID_CHARACTER_MENTION");
    // The row *was* written — this is not the door refusing before a statement
    // ran — and it was written inside the transaction that threw.
    expect(mockPrisma.libraryCharacter.create).toHaveBeenCalledTimes(1);
    expect(survivingWrites()).toEqual([]);
    const [transaction] = mockTransactions();
    expect(transaction!.rolledBack).toBe(true);
    expect(transaction!.writes.map((write) => `${write.model}.${write.operation}`)).toEqual([
      "libraryCharacter.create"
    ]);
    await app.close();
  });

  it("takes back the claim and the link delete when the stored prose is refused", async () => {
    // The screen inside PATCH's transaction is the only one that reads the
    // prose the save actually stores, and here that prose is not the prose the
    // request typed: dropping the last mention of a character named Bomb takes
    // the `@` out of the description, and what is left reads as a request for
    // something the screen refuses. The body carried no description at all, so
    // the door in front of the transaction had nothing to refuse — by the time
    // the refusal is possible the row is claimed and the link rows are gone.
    const live = characterRecord({
      description: "Nix learns how to build a @Bomb costume.",
      outgoingMentions: [
        {
          sourceCharacterId: "char-1",
          targetKind: "CHARACTER",
          targetId: "char-2",
          targetCharacterId: "char-2",
          otherType: null,
          sortOrder: 0,
          targetCharacter: { id: "char-2", name: "Bomb" }
        }
      ]
    });
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(live);
    mockPrisma.libraryMention.findMany.mockResolvedValue(storedLinkTo({ id: "char-2", name: "Bomb" }));
    const app = await buildMobileApp();

    const refused = await app.inject({
      method: "PATCH",
      url: "/api/mobile/characters/char-1",
      headers: bearer("token-a"),
      payload: { mentionedCharacterIds: [] }
    });

    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.reason).toBe("critical_illegal_harm");
    expect(survivingWrites()).toEqual([]);
    const [transaction] = mockTransactions();
    expect(transaction!.rolledBack).toBe(true);
    // The claim writes the row's own name back and the delete clears the links
    // this save gave up; both are statements the refusal has to unwind, and the
    // description update never runs at all.
    expect(transaction!.writes.map((write) => `${write.model}.${write.operation}`)).toEqual([
      "libraryCharacter.updateMany",
      "libraryMention.deleteMany"
    ]);
    // The window that transaction ran under is part of the same record, so a
    // caller that stopped sizing it would be visible here too. What the numbers
    // mean, and what they shrink to under pool pressure, is
    // `characterWriteConflicts.test.ts`; this only says they were not dropped.
    expect(transaction!.options).toEqual(CHARACTER_MENTION_TRANSACTION_OPTIONS);
    await app.close();
  });

  it("puts every sibling description back when a delete loses its row", async () => {
    // The expensive half of a delete is the unlink: every character whose
    // description names this one is claimed and rewritten before the row goes.
    // Then the `deleteMany` finds nothing — the row went in the window between
    // the claim and here — and the whole attempt is abandoned, twice, since the
    // lane retries once without its portrait guard. Nothing about that is safe
    // unless the sibling rewrites go with it: `@Bram` is stripped out of Mina's
    // prose exactly once, and a rewrite that outlived the abandoned delete would
    // leave her naming a character who is still there, with the marker gone and
    // nothing left to put it back.
    const bram = characterRecord({ id: "char-2", name: "Bram" });
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(bram);
    mockPrisma.libraryMention.findMany.mockResolvedValue(mentioningSource());
    mockPrisma.libraryCharacter.deleteMany.mockResolvedValue({ count: 0 });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "DELETE",
      url: "/api/mobile/characters/char-2",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(404);
    // Mina's description really was rewritten, once per attempt — and the
    // statement that did it is *in the record below*, which is what makes this
    // test about what its name says. The rewrite is one
    // `UPDATE … FROM unnest(…)` on the client rather than a `libraryCharacter
    // .update` per row, and the transaction proxy used to wrap model delegates
    // only: the raw statement was returned untouched, landed on no record, and
    // `survivingWrites()` could not see it either way. So the assertion that
    // reads `[]` here was satisfied by a rewrite that escaped its transaction
    // exactly as well as by one that unwound with it — which is the one escape
    // a mock with no store is supposed to be able to catch.
    expect(rewrittenDescriptions()).toEqual([{ id: "char-1", description: "Friends with Bram." }]);
    expect(rewriteAttempts()).toBe(2);
    expect(survivingWrites()).toEqual([]);
    expect(mockTransactions()).toHaveLength(2);
    for (const transaction of mockTransactions()) {
      expect(transaction.rolledBack).toBe(true);
      expect(transaction.writes.map((write) => `${write.model}.${write.operation}`)).toEqual([
        "libraryCharacter.updateMany",
        SIBLING_REWRITE_WRITE,
        "libraryCharacter.deleteMany"
      ]);
    }
    await app.close();
  });

  it("keeps a rename's sibling rewrite once the transaction commits", async () => {
    // The raw write's own control, and the same argument as the create's above:
    // the `[]` in the delete test is only a measurement if this statement is
    // something `survivingWrites()` can report at all. A rename that commits
    // leaves the claim, the sibling rewrite and the row's own update behind, in
    // that order — and the rewrite is there under the client's name rather than
    // a model's, because that is what it is.
    const bram = characterRecord({ id: "char-2", name: "Bram" });
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(bram);
    mockPrisma.libraryMention.findMany.mockResolvedValue(mentioningSource());
    mockPrisma.libraryCharacter.update.mockResolvedValue(characterRecord({ id: "char-2", name: "Bramwell" }));
    const app = await buildMobileApp();

    const renamed = await app.inject({
      method: "PATCH",
      url: "/api/mobile/characters/char-2",
      headers: bearer("token-a"),
      payload: { name: "Bramwell" }
    });

    expect(renamed.statusCode).toBe(200);
    expect(rewrittenDescriptions()).toEqual([{ id: "char-1", description: "Friends with @Bramwell." }]);
    expect(mockTransactions()[0]!.rolledBack).toBe(false);
    expect(survivingWrites()).toEqual([
      "libraryCharacter.updateMany",
      SIBLING_REWRITE_WRITE,
      "libraryCharacter.update"
    ]);
    await app.close();
  });

  /**
   * The bookkeeping's own reset, which used to be inferred and could be wrong.
   *
   * Every record points into a mock's `mock.calls` by index, so a record that
   * outlives `vi.resetAllMocks()` subtracts the *next* test's writes at the same
   * indexes — reporting a committed write as rolled back, which is an
   * `expect(survivingWrites()).toEqual([])` passing over a write that survived.
   * The log used to notice that by comparing its own length against
   * `$transaction.mock.calls.length`, and those two count different things: the
   * batch form of `$transaction` is counted by vitest and recorded by nothing,
   * because `runMockTransaction` returns early for it. Two batches are enough to
   * put the count back over the stale record and make the guard read "not reset".
   *
   * Written as one test rather than as two that leak into each other, because
   * the reset is a function this can call: what the sequence needs is a
   * rolled-back record, the seam, and then enough uncounted calls to fool the
   * arithmetic that used to be here.
   */
  it("clears the transaction log at the reset, not by counting $transaction calls", async () => {
    await mockPrisma
      .$transaction(async (tx: typeof mockPrisma) => {
        await tx.libraryCharacter.create({ data: {} });
        throw new Error("refused");
      })
      .catch(() => undefined);
    expect(mockTransactions()).toHaveLength(1);
    expect(mockTransactions()[0]!.writes).toEqual([{ model: "libraryCharacter", operation: "create", index: 0 }]);

    // The seam every `beforeEach` in this directory runs, and the only thing
    // that clears the call lists those indexes point into.
    resetMobileHarness();

    // Batch transactions: counted, recorded by nothing. Two of them put the
    // call count above the stale record the reset was supposed to have dropped.
    await mockPrisma.$transaction([Promise.resolve("a")]);
    await mockPrisma.$transaction([Promise.resolve("b")]);
    await mockPrisma.$transaction(async (tx: typeof mockPrisma) => {
      await tx.libraryCharacter.create({ data: {} });
    });

    // One record, one committed write — and `libraryCharacter.create#0` is the
    // index the dropped record also named, which is what made it invisible.
    expect(mockTransactions()).toHaveLength(1);
    expect(mockTransactions()[0]!.rolledBack).toBe(false);
    expect(survivingWrites()).toEqual(["libraryCharacter.create"]);
  });
});
