import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());

import {
  CharacterMentionError,
  replaceCharacterMentions,
  rewriteIncomingCharacterMentions,
  survivingMentionIds,
  unlinkIncomingCharacterMentions
} from "./characterMentions.js";
import { CharacterRowMovedError } from "./characterWriteConflicts.js";
import { mockPrisma, resetCharacterImageMocks } from "./testing/mobileApiMocks.js";

/**
 * The durable side, unit level: these run on the transaction client the routes
 * hand them, and every one of them is a whole-set claim rather than a scan of
 * one name in isolation.
 */
describe("durable mention links", () => {
  const tx = () => mockPrisma as never;

  beforeEach(() => {
    vi.resetAllMocks();
    resetCharacterImageMocks();
  });

  function incoming(description: string, links: Array<{ id: string; name: string }>) {
    return [
      {
        sourceCharacter: {
          id: "char-source",
          userId: "user-a",
          name: "Mina",
          description,
          outgoingMentions: links.map((targetCharacter) => ({ targetCharacter }))
        }
      }
    ];
  }

  function mentioning(description: string, links: Array<{ id: string; name: string }>) {
    const rows = incoming(description, links);
    mockPrisma.libraryCharacterMention.findMany.mockResolvedValue(rows);
    mockPrisma.libraryCharacter.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(rows[0]!.sourceCharacter);
    return rows[0]!.sourceCharacter;
  }

  it("links two names that differ only in case, each to its own token", async () => {
    // Both rows are legal — the [userId, name] unique index is case-sensitive —
    // and canonicalizing them one at a time converted both tokens to "@Bram"
    // and then both back to "@bram", so the save always died on the validation
    // and a create took the whole character down with it.
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([
      { id: "char-upper", name: "Bram" },
      { id: "char-lower", name: "bram" }
    ]);

    const description = await replaceCharacterMentions(tx(), {
      sourceCharacterId: "char-1",
      userId: "user-a",
      description: "@Bram met @bram.",
      mentionedCharacterIds: ["char-upper", "char-lower"]
    });

    expect(description).toBe("@Bram met @bram.");
    expect(mockPrisma.libraryCharacterMention.createMany).toHaveBeenCalledWith({
      data: [
        { sourceCharacterId: "char-1", targetCharacterId: "char-upper", sortOrder: 0 },
        { sourceCharacterId: "char-1", targetCharacterId: "char-lower", sortOrder: 1 }
      ]
    });
  });

  it("keeps a nested name out of the longer name's token", async () => {
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([
      { id: "char-luna", name: "Luna" },
      { id: "char-vega", name: "Luna Vega" }
    ]);

    const description = await replaceCharacterMentions(tx(), {
      sourceCharacterId: "char-1",
      userId: "user-a",
      description: "@Luna and @Luna Vega",
      mentionedCharacterIds: ["char-vega", "char-luna"]
    });

    expect(description).toBe("@Luna and @Luna Vega");
    // Stored order is first-token order, and the tokens are two distinct spans.
    expect(mockPrisma.libraryCharacterMention.createMany).toHaveBeenCalledWith({
      data: [
        { sourceCharacterId: "char-1", targetCharacterId: "char-luna", sortOrder: 0 },
        { sourceCharacterId: "char-1", targetCharacterId: "char-vega", sortOrder: 1 }
      ]
    });
  });

  it("lets an old client save prose that drops a nested link", async () => {
    // No mentionedCharacterIds in the PATCH: the surviving set is derived, and
    // a short link that "survived" on its occurrence inside a longer linked
    // name came back as an id the write then refused — an ordinary prose edit
    // that could not be saved at all.
    const links = [
      { id: "char-luna", name: "Luna" },
      { id: "char-vega", name: "Luna Vega" }
    ];
    const edited = "Only @Luna Vega appears now.";
    const surviving = survivingMentionIds(edited, links);
    expect(surviving).toEqual(["char-vega"]);

    mockPrisma.libraryCharacter.findMany.mockResolvedValue([{ id: "char-vega", name: "Luna Vega" }]);
    await expect(
      replaceCharacterMentions(tx(), {
        sourceCharacterId: "char-1",
        userId: "user-a",
        description: edited,
        mentionedCharacterIds: surviving
      })
    ).resolves.toBe(edited);
  });

  it("renames and unlinks only the spans the target itself claims", async () => {
    mentioning("@Luna and @Luna Vega", [
      { id: "char-luna", name: "Luna" },
      { id: "char-vega", name: "Luna Vega" }
    ]);

    await rewriteIncomingCharacterMentions(tx(), "char-luna", "Luna", "Nova");
    expect(mockPrisma.libraryCharacter.update).toHaveBeenLastCalledWith({
      where: { id: "char-source" },
      data: { description: "@Nova and @Luna Vega" }
    });

    await unlinkIncomingCharacterMentions(tx(), "char-luna", "Luna");
    expect(mockPrisma.libraryCharacter.update).toHaveBeenLastCalledWith({
      where: { id: "char-source" },
      data: { description: "Luna and @Luna Vega" }
    });
  });

  it("never rewrites the case-variant sibling's token", async () => {
    mentioning("@Bram met @bram.", [
      { id: "char-upper", name: "Bram" },
      { id: "char-lower", name: "bram" }
    ]);

    await rewriteIncomingCharacterMentions(tx(), "char-upper", "Bram", "Brom");

    expect(mockPrisma.libraryCharacter.update).toHaveBeenLastCalledWith({
      where: { id: "char-source" },
      data: { description: "@Brom met @bram." }
    });
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

    await rewriteIncomingCharacterMentions(tx(), "char-ali", ali, "\u0646\u0648\u0627");
    await unlinkIncomingCharacterMentions(tx(), "char-ali", ali);

    // The short name is a sub-token of the longer one, so it claims nothing
    // and nothing is written.
    expect(mockPrisma.libraryCharacter.update).not.toHaveBeenCalled();
  });

  it("names the character whose description blocks a rename", async () => {
    mentioning(`${"x".repeat(1_990)} @Bram`, [{ id: "char-bram", name: "Bram" }]);

    const failure = await rewriteIncomingCharacterMentions(
      tx(),
      "char-bram",
      "Bram",
      "B".repeat(80)
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CharacterMentionError);
    const error = failure as CharacterMentionError;
    expect(error.code).toBe("CHARACTER_MENTION_TOO_LONG");
    // The blocker is somebody else's description; a cuid tells the reader
    // nothing about which character to go and shorten.
    expect(error.message).toContain("Mina");
    expect(error.message).not.toContain("char-source");
    expect(mockPrisma.libraryCharacter.update).not.toHaveBeenCalled();
  });

  it("rewrites the description the source claim found, not the mention-list snapshot", async () => {
    // A concurrent PATCH of Mina can commit while this rename waits on her
    // row. Stripping the snapshot taken before the lock would overwrite
    // "She loves tea." with a rewrite of the older sentence.
    const snapshot = mentioning("Friends with @Bram.", [{ id: "char-bram", name: "Bram" }]);
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue({
      ...snapshot,
      description: "Friends with @Bram. She loves tea."
    });

    await rewriteIncomingCharacterMentions(tx(), "char-bram", "Bram", "Bramwell");
    expect(mockPrisma.libraryCharacter.update).toHaveBeenCalledWith({
      where: { id: "char-source" },
      data: { description: "Friends with @Bramwell. She loves tea." }
    });

    mockPrisma.libraryCharacter.update.mockClear();
    await unlinkIncomingCharacterMentions(tx(), "char-bram", "Bram");
    expect(mockPrisma.libraryCharacter.update).toHaveBeenCalledWith({
      where: { id: "char-source" },
      data: { description: "Friends with Bram. She loves tea." }
    });
  });

  it("refuses to rewrite a mentioning character whose row moved", async () => {
    mentioning("Friends with @Bram.", [{ id: "char-bram", name: "Bram" }]);
    mockPrisma.libraryCharacter.updateMany.mockResolvedValue({ count: 0 });

    await expect(rewriteIncomingCharacterMentions(tx(), "char-bram", "Bram", "Bramwell")).rejects.toBeInstanceOf(
      CharacterRowMovedError
    );
    await expect(unlinkIncomingCharacterMentions(tx(), "char-bram", "Bram")).rejects.toBeInstanceOf(
      CharacterRowMovedError
    );
    expect(mockPrisma.libraryCharacter.update).not.toHaveBeenCalled();
  });
});
