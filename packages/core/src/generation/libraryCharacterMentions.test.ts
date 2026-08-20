import { describe, expect, it } from "vitest";
import {
  canonicalizeLibraryCharacterMentions,
  isLibraryCharacterNameCharacterAt,
  libraryCharacterMentionRanges,
  rewriteLibraryCharacterMention,
  stripLibraryCharacterMentionMarkers
} from "./libraryCharacterMentions.js";

describe("library character mention text", () => {
  const luna = { id: "luna", name: "Luna" };
  const vega = { id: "vega", name: "Luna Vega" };

  it("finds repeated whole tokens without matching a longer word", () => {
    expect(libraryCharacterMentionRanges("@Luna met @Luna-Bear and @Luna.", [luna])).toEqual([
      { ...luna, start: 0, end: 5 },
      { ...luna, start: 25, end: 30 }
    ]);
  });

  it("lets the longest selected name claim an overlapping span", () => {
    expect(libraryCharacterMentionRanges("Ask @Luna Vega.", [luna, vega])).toEqual([
      { ...vega, start: 4, end: 14 }
    ]);
  });

  it("rewrites case-insensitive legacy spelling to the canonical new name", () => {
    expect(rewriteLibraryCharacterMention("Friends with @luna.", luna, "Luna Vega")).toBe(
      "Friends with @Luna Vega."
    );
  });

  it("strips only linked markers for generation-facing prose", () => {
    expect(stripLibraryCharacterMentionMarkers("Knows @Luna and @Ghost.", [luna])).toBe(
      "Knows Luna and @Ghost."
    );
  });

  it("recognizes punctuation boundaries without splitting astral letters", () => {
    expect(libraryCharacterMentionRanges("(@Luna)", [luna])).toHaveLength(1);
    expect(libraryCharacterMentionRanges("𐐀@Luna", [luna])).toEqual([]);
    // The unit before `@` is the trailing surrogate of 𐐀; backing up is what
    // stops that half from reading as "not a letter" and opening a mention.
    expect(isLibraryCharacterNameCharacterAt("𐐀@Luna", 1)).toBe(true);
  });

  it("keeps a possessive inside the mention, straight quote or curly", () => {
    // The composer prunes a tapped pick whose token it can no longer find, so
    // a possessive that ends the token is a message shipped with no character
    // ids at all — the model then invents the look this feature exists to pin.
    expect(libraryCharacterMentionRanges("@Luna's hat", [luna])).toEqual([
      { ...luna, start: 0, end: 5 }
    ]);
    expect(libraryCharacterMentionRanges("@Luna’s hat", [luna])).toEqual([
      { ...luna, start: 0, end: 5 }
    ]);
  });

  it("refuses a hyphen that joins the next word and allows one that does not", () => {
    expect(libraryCharacterMentionRanges("@Luna-Bear", [luna])).toEqual([]);
    expect(libraryCharacterMentionRanges("@Luna-", [luna])).toEqual([{ ...luna, start: 0, end: 5 }]);
    expect(libraryCharacterMentionRanges("@Luna - the rabbit", [luna])).toEqual([
      { ...luna, start: 0, end: 5 }
    ]);
    // The whole known name may contain the hyphen; longest-first is what makes
    // that work without letting the shorter name claim its first half.
    const bear = { id: "bear", name: "Luna-Bear" };
    expect(libraryCharacterMentionRanges("@Luna-Bear", [luna, bear])).toEqual([
      { ...bear, start: 0, end: 10 }
    ]);
  });

  it("leaves a sibling's token alone when a nested name is renamed or deleted", () => {
    const description = "@Luna and @Luna Vega";
    expect(rewriteLibraryCharacterMention(description, luna, "Nova", [vega])).toBe(
      "@Nova and @Luna Vega"
    );
    expect(stripLibraryCharacterMentionMarkers(description, [luna], [vega])).toBe(
      "Luna and @Luna Vega"
    );
  });

  it("keeps two names that differ only in case apart", () => {
    const upper = { id: "upper", name: "Bram" };
    const lower = { id: "lower", name: "bram" };
    expect(libraryCharacterMentionRanges("@Bram met @bram.", [upper, lower])).toEqual([
      { ...upper, start: 0, end: 5 },
      { ...lower, start: 10, end: 15 }
    ]);
    expect(rewriteLibraryCharacterMention("@Bram met @bram.", upper, "Brom", [lower])).toBe(
      "@Brom met @bram."
    );
    // Neither is spelled the way the prose spells it, so nobody claims it: a
    // wrong owner is the unrecoverable half.
    expect(libraryCharacterMentionRanges("@BRAM", [upper, lower])).toEqual([]);
  });

  it("treats a ZWNJ as part of the Persian word it joins", () => {
    // «علی‌رضا» is one name written with a zero-width non-joiner, so the saved
    // «علی» inside it is a sub-token and not a mention. ZWNJ is category `Cf`:
    // a boundary class that stops at letters alone reads the joiner as a word
    // break and hands one reader's saved face to another character.
    const ali = { id: "ali", name: "\u0639\u0644\u06cc" };
    const alireza = { id: "alireza", name: "\u0639\u0644\u06cc\u200c\u0631\u0636\u0627" };
    const description = `\u0647\u0645\u0631\u0627\u0647 @${alireza.name} \u0627\u0633\u062a`;

    expect(libraryCharacterMentionRanges(description, [ali])).toEqual([]);
    expect(libraryCharacterMentionRanges(description, [ali, alireza])).toEqual([
      { ...alireza, start: 6, end: 14 }
    ]);
    expect(rewriteLibraryCharacterMention(description, ali, "\u0646\u0648\u0627", [alireza])).toBe(
      description
    );
    expect(stripLibraryCharacterMentionMarkers(description, [ali], [alireza])).toBe(description);
  });

  it("canonicalizes every claimed span in one pass, case variants included", () => {
    const upper = { id: "upper", name: "Bram" };
    const lower = { id: "lower", name: "bram" };
    const claims = canonicalizeLibraryCharacterMentions("@Bram met @bram.", [upper, lower]);

    expect(claims.description).toBe("@Bram met @bram.");
    expect(claims.ranges.map((range) => [range.id, range.start])).toEqual([
      ["upper", 0],
      ["lower", 10]
    ]);
  });

  it("respells a legacy token without moving the spans around it", () => {
    const claims = canonicalizeLibraryCharacterMentions("@luna met @Luna Vega", [luna, vega]);

    expect(claims.description).toBe("@Luna met @Luna Vega");
    expect(claims.ranges.map((range) => range.id)).toEqual(["luna", "vega"]);
  });
});
