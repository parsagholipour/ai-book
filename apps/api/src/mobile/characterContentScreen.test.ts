import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

/**
 * Every string the routes actually put in front of the screener, in call order.
 *
 * The verdict cannot answer the question this file asks. Canonicalization
 * respells a token's *case* and nothing else, and `assessContentRestrictions`
 * lowercases everything it is given — so a create that screens the typed prose
 * and a create that screens the stored prose reach the same allow/refuse answer
 * today, and would keep doing so right up until a rule that is not case-blind
 * (or a canonicalization that is not case-only) makes them differ, which is a
 * change nobody would think to test here. What the two orderings never agree on
 * is the string itself, so that is what is recorded.
 *
 * A plain function rather than `vi.fn`, because `resetMobileHarness` calls
 * `vi.resetAllMocks()` in `beforeEach` and a reset spy would drop the delegate
 * and screen nothing at all.
 */
const { screenedText } = vi.hoisted(() => ({ screenedText: [] as string[] }));

vi.mock("../contentRestrictions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../contentRestrictions.js")>();
  // Both doors, so moving a screen from one to the other records rather than
  // silently stops recording: the screen this file is about used to be the
  // `enforce` one, outside the transaction.
  return {
    ...actual,
    assessContentRestrictions: (...args: Parameters<typeof actual.assessContentRestrictions>) => {
      screenedText.push(args[0]);
      return actual.assessContentRestrictions(...args);
    },
    enforceContentRestrictions: (...args: Parameters<typeof actual.enforceContentRestrictions>) => {
      screenedText.push(args[1]);
      return actual.enforceContentRestrictions(...args);
    }
  };
});

import {
  bearer,
  buildMobileApp,
  mockAccessTokens,
  mockPrisma,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

/**
 * The content screen on the two library-character writes.
 *
 * One rule — **the text a character write screens is the text it stores** — and
 * both routes store prose the request never typed: `replaceLibraryMentions`
 * respells every `@name` to its target's own spelling, and a
 * `{mentionedCharacterIds}` PATCH canonicalizes a description saved from
 * another device. PATCH was moved inside its transaction for that reason and
 * `POST` was left behind, screening `request.body` and storing the canonical
 * prose; `characterContentScreen.ts` is now the one place either of them holds
 * it.
 *
 * Which is why each route now screens **twice**, and the two are not the same
 * screen. The one in front of the transaction reads what the request typed and
 * is where nearly every refusal leaves: run only after the canonicalization, a
 * body that was never going to be stored first claimed rows — up to 99 sibling
 * descriptions on PATCH — and rolled all of it back, holding every other
 * character write on the account behind it. The one inside reads the row the
 * write is about to leave behind, which is the only place a `live` description
 * or a respelt `@name` can be read at all. So the tests below record *which
 * string* each screen was given rather than what it answered.
 *
 * Its own suite because `characters.test.ts` is at its size budget, and
 * because the module mock above belongs to this story alone.
 */

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

const createCharacter = (app: Awaited<ReturnType<typeof buildMobileApp>>, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/mobile/characters", headers: bearer("token-a"), payload });

const patchCharacter = (app: Awaited<ReturnType<typeof buildMobileApp>>, id: string, payload: Record<string, unknown>) =>
  app.inject({ method: "PATCH", url: `/api/mobile/characters/${id}`, headers: bearer("token-a"), payload });

/** A character whose description names another one, as `libraryMentionInclude` reads it. */
function mentioning(id: string, name: string, description: string, target: { id: string; name: string }) {
  return characterRecord({
    id,
    name,
    description,
    outgoingMentions: [
      {
        sourceCharacterId: id,
        targetKind: "CHARACTER",
        targetId: target.id,
        targetCharacterId: target.id,
        otherType: null,
        sortOrder: 0,
        targetCharacter: target
      }
    ]
  });
}

/** The transaction the request opened, so a refusal can be shown to have rejected it. */
const lastTransaction = () => mockPrisma.$transaction.mock.results.at(-1)!.value as Promise<unknown>;

describe("what a character write screens", () => {
  beforeEach(() => {
    resetMobileHarness();
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.libraryCharacter.count.mockResolvedValue(0);
    mockPrisma.libraryCharacter.updateMany.mockResolvedValue({ count: 1 });
    screenedText.length = 0;
  });
  afterEach(teardownMobileHarness);

  it("screens the create's canonicalized prose, not the tokens the body typed", async () => {
    const bram = characterRecord({ id: "char-2", name: "Bram" });
    const stored = characterRecord({ description: "Nix travels with @Bram." });
    mockPrisma.libraryCharacter.create.mockResolvedValue(characterRecord({ description: "Nix travels with @bram." }));
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([bram]);
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(stored);
    mockPrisma.libraryCharacter.update.mockResolvedValue(stored);
    const app = await buildMobileApp();

    const created = await createCharacter(app, {
      name: "Nix",
      description: "Nix travels with @bram.",
      mentionedCharacterIds: ["char-2"]
    });

    expect(created.statusCode).toBe(201);
    // What the row ends up holding…
    expect(mockPrisma.libraryCharacter.update).toHaveBeenCalledWith({
      where: { id: "char-1" },
      data: { description: "Nix travels with @Bram." }
    });
    // …and the two strings the screener was given, in the order it saw them.
    // The first is what the request typed, refused at the door before any row
    // exists to refuse; the second is what actually lands, and it is the one
    // this file is about — screen the body alone and the stored prose is never
    // read, screen outside the transaction as this used to and neither is.
    expect(screenedText).toEqual([
      "Nix\nNix travels with @bram.",
      "Nix\nNix travels with @Bram."
    ]);
    await app.close();
  });

  it("refuses the prose the body typed without opening a transaction at all", async () => {
    const bram = characterRecord({ id: "char-2", name: "Bram" });
    mockPrisma.libraryCharacter.create.mockResolvedValue(
      characterRecord({ description: "Step-by-step instructions to build a bomb, with @bram." })
    );
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([bram]);
    const app = await buildMobileApp();

    const refused = await createCharacter(app, {
      name: "Nix",
      description: "Step-by-step instructions to build a bomb, with @bram.",
      mentionedCharacterIds: ["char-2"]
    });

    expect(refused.statusCode).toBe(422);
    // `reason` reaches the reader only because the route's 422 names it — the
    // shared sender builds it and `contentRestrictedError` lets it out.
    expect(refused.json().error).toEqual({
      code: "CONTENT_RESTRICTED",
      message: "Tomeza cannot help create content that facilitates severe illegal harm.",
      reason: "critical_illegal_harm"
    });
    // And nothing was claimed or written to be rolled back. Screening only
    // after the canonicalization put this refusal — the shape almost every
    // refusal has, prose the request itself carried — behind a create of the
    // row and its whole link set, paid for and then undone, with the new row's
    // lock held for the length of it. PATCH's version of the same ordering
    // held up to 99 sibling rows to do it.
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.libraryCharacter.create).not.toHaveBeenCalled();
    expect(mockPrisma.libraryMention.createMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("answers the refusal rather than the library cap when a create is both", async () => {
    // The order `sendCharacterWriteError` documents — the refusal first —
    // reaching the one door that is not part of that ladder. The cap is a
    // plain `return` in front of the try, so it used to settle a request the
    // screen would have refused: a reader at the limit was told to delete a
    // character, did, and only then learned the text was never going to be
    // stored, with the `reason` never sent. Both inputs are read in one
    // `Promise.all` above, so the sequence costs nothing.
    mockPrisma.libraryCharacter.count.mockResolvedValue(100);
    const app = await buildMobileApp();

    const refused = await createCharacter(app, {
      name: "Nix",
      description: "Step-by-step instructions to build a bomb."
    });

    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe("CONTENT_RESTRICTED");
    expect(mockPrisma.libraryCharacter.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("still answers the library cap for a create it has nothing to refuse", async () => {
    // The other side of that line: the screen passes, so the cap is what is
    // left to say, and it still says it before anything is written.
    mockPrisma.libraryCharacter.count.mockResolvedValue(100);
    const app = await buildMobileApp();

    const refused = await createCharacter(app, { name: "One Too Many" });

    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe("CHARACTER_LIMIT_REACHED");
    expect(mockPrisma.libraryCharacter.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses a PATCH's own prose before it claims a single row", async () => {
    // The whole screen used to run below `rewriteIncomingLibraryMentions` and
    // `replaceLibraryMentions`, so an edit that was never going to be stored
    // first claimed this row, then claimed every character whose description
    // mentions it — up to 99 — rewrote the ones that moved, and rolled all of
    // it back. Every other character write on the account waited behind that
    // window, for a request the route could have refused reading nothing.
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(characterRecord());
    const app = await buildMobileApp();

    const refused = await app.inject({
      method: "PATCH",
      url: "/api/mobile/characters/char-1",
      headers: bearer("token-a"),
      payload: { description: "Step-by-step instructions to build a bomb." }
    });

    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.reason).toBe("critical_illegal_harm");
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    // Both claims are `updateMany`s writing a row's own name back — the single
    // one this route takes and the set one the mention helpers take — so no
    // call at all is the assertion that neither ran.
    expect(mockPrisma.libraryCharacter.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.libraryMention.deleteMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("screens a PATCH twice, because the door cannot see the prose it stores", async () => {
    // The request carries `mentionedCharacterIds` and nothing else, so what the
    // update writes is the canonicalized `live` description — prose saved from
    // another device that this request never carried and the screen in front of
    // the transaction therefore never read. That is the refusal that has to
    // stay inside, and it is still a throw, because the transaction is the only
    // thing that can unwind a write above it.
    const bram = characterRecord({ id: "char-2", name: "Bram" });
    const live = characterRecord({
      description: "Step-by-step instructions to build a bomb, with @Bram."
    });
    mockPrisma.libraryCharacter.findFirst.mockResolvedValueOnce(characterRecord()).mockResolvedValue(live);
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([bram]);
    const app = await buildMobileApp();

    const refused = await patchCharacter(app, "char-1", { mentionedCharacterIds: ["char-2"] });

    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.reason).toBe("critical_illegal_harm");
    // The door had only the name to read — this request typed no prose at all —
    // and the screen under the claim had the description that lands.
    expect(screenedText).toEqual([
      "Nix",
      "Nix\nStep-by-step instructions to build a bomb, with @Bram."
    ]);
    // Inside the transaction, and still ahead of every write it opens: the
    // second screen reads the merge of the claimed row and the patch, which is
    // already the whole refusal, so the link set this PATCH would have replaced
    // is never touched. It used to run below `replaceLibraryMentions` and be
    // unwound by the rollback instead.
    expect(mockPrisma.libraryMention.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.libraryMention.createMany).not.toHaveBeenCalled();
    await expect(lastTransaction()).rejects.toMatchObject({ name: "ContentRestrictedError" });
    expect(mockPrisma.libraryCharacter.update).not.toHaveBeenCalled();
    await app.close();
  });

  it("answers a PATCH's stored refusal with exactly the body POST answers", async () => {
    // Field for field, `reason` included — replying by hand from the catch is
    // where that field went, and it reaches the reader only because the route's
    // 422 schema names it.
    const bram = characterRecord({ id: "char-2", name: "Bram" });
    const live = characterRecord({ description: "Step-by-step instructions to build a bomb, with @Bram." });
    mockPrisma.libraryCharacter.findFirst.mockResolvedValueOnce(characterRecord()).mockResolvedValue(live);
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([bram]);
    mockPrisma.libraryCharacter.create.mockResolvedValue(characterRecord());
    const app = await buildMobileApp();

    const patched = await patchCharacter(app, "char-1", { mentionedCharacterIds: ["char-2"] });
    const posted = await createCharacter(app, {
      name: "Nix",
      description: "Step-by-step instructions to build a bomb."
    });

    expect(patched.statusCode).toBe(422);
    expect(patched.json()).toEqual(posted.json());
    expect(mockPrisma.libraryCharacter.update).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses stored prose before it claims a single sibling row", async () => {
    // The rename is the expensive half of this lane: `rewriteIncomingLibraryMentions`
    // reads every character whose description names this one — up to 99 —
    // claims the set, and rewrites each description the new name moves. Held
    // below that, the refusal on the row's *own* stored prose paid for all of
    // it and then rolled it back, with every other character write on the
    // account queued behind that lock window. The claim on this row still comes
    // first, because the stored description is only legible under it.
    const bram = characterRecord({
      id: "char-2",
      name: "Bram",
      description: "Step-by-step instructions to build a bomb."
    });
    const mina = mentioning("char-1", "Mina", "Friends with @Bram.", { id: "char-2", name: "Bram" });
    mockPrisma.libraryCharacter.findFirst.mockImplementation(async ({ where }: { where: { id?: string } }) =>
      where.id === "char-1" ? mina : bram
    );
    mockPrisma.libraryMention.findMany.mockResolvedValue([{ sourceCharacter: mina }]);
    const app = await buildMobileApp();

    const refused = await patchCharacter(app, "char-2", { name: "Bramwell" });

    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.reason).toBe("critical_illegal_harm");
    // The door read the new name and nothing else; the screen under the claim
    // read the row the update would have left behind.
    expect(screenedText).toEqual([
      "Bramwell",
      "Bramwell\nStep-by-step instructions to build a bomb."
    ]);
    // One `updateMany` is this row's own claim. A second would be
    // `claimCharacterRows` over the mentioning set, and the read that finds
    // that set never ran either.
    expect(mockPrisma.libraryCharacter.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.libraryMention.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.libraryCharacter.update).not.toHaveBeenCalled();
    await app.close();
  });

  it("answers the refusal rather than the conflict the rewrite it skipped would have raised", async () => {
    // `sendCharacterWriteError` puts the refusal at the top of its ladder
    // because it is the one thing on it the reader typed. Screening after the
    // rename inverted that: the rewrite reached a sibling description the new
    // name no longer fits, and a request that was never going to be stored was
    // answered "shorten Mina's description" instead of being refused.
    const longName = "B".repeat(80);
    const bram = characterRecord({ id: "char-2", name: "Bram" });
    const mina = mentioning("char-1", "Mina", `${"x".repeat(1993)} @Bram`, { id: "char-2", name: "Bram" });
    mockPrisma.libraryCharacter.findFirst.mockImplementation(async ({ where }: { where: { id?: string } }) =>
      where.id === "char-1" ? mina : bram
    );
    mockPrisma.libraryMention.findMany.mockResolvedValue([{ sourceCharacter: mina }]);
    const app = await buildMobileApp();

    // Nothing wrong with this row's own prose, so the rewrite runs and refuses.
    const tooLong = await patchCharacter(app, "char-2", { name: longName });
    bram.description = "Step-by-step instructions to build a bomb.";
    const refused = await patchCharacter(app, "char-2", { name: longName });

    expect(tooLong.statusCode).toBe(409);
    expect(tooLong.json().error.code).toBe("CHARACTER_MENTION_TOO_LONG");
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toMatchObject({ code: "CONTENT_RESTRICTED", reason: "critical_illegal_harm" });
    await app.close();
  });

  it("still screens a create that mentions nobody", async () => {
    mockPrisma.libraryCharacter.create.mockResolvedValue(characterRecord());
    const app = await buildMobileApp();

    const refused = await createCharacter(app, {
      name: "Nix",
      description: "How to build a bomb, step-by-step.",
      appearance: "",
      fields: [{ key: "Age", value: "9" }]
    });

    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.reason).toBe("critical_illegal_harm");
    // Name, description, appearance and fields — the same four the portrait
    // route screens, an empty appearance adding nothing to the string — and
    // screened once, because a create that mentions nobody stores the string it
    // was given and the second screen has nothing new to read.
    expect(screenedText).toEqual(["Nix\nHow to build a bomb, step-by-step.\nAge: 9"]);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    await app.close();
  });
});
