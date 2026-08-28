import { describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/core", () => ({
  // `characterSlug` calls this only after reducing the value to `[a-z0-9-]`,
  // so the machine-path policy is an identity function on this seam.
  safePathPart: (value: string) => value,
  // The real fold lives in @book-maker/core and is tested there; this stand-in
  // keeps only the two properties the slug leans on — equivalent spellings of
  // one name fold together, and different names do not.
  foldCharacterName: (value: string) =>
    value.replace(/ك/gu, "ک").replace(/[يى]/gu, "ی").replace(/\s+/gu, " ").trim().toLowerCase()
}));

import {
  characterReferenceFileStems,
  characterReferenceNameKey,
  characterSlug
} from "./characterReferenceFileNames.js";

describe("characterReferenceNameKey", () => {
  it("agrees with the trim every stored name already gets on the way out", () => {
    // `characterNameFromAssetMetadata` and `parseCharacterReferenceRefusals` both
    // trim, and the plan side did not, so a padded planner name was a character
    // the settled gate could never find an answer for.
    expect(characterReferenceNameKey("Ada ")).toBe(characterReferenceNameKey("Ada"));
    expect(characterReferenceNameKey(" Ada\n")).toBe("ada");
  });

  it("keeps two names the planner wrote as two people apart", () => {
    // Deliberately weaker than `foldCharacterName`: a cast with one sheet
    // between two characters must stay unsettled, not settle one of them away.
    expect(characterReferenceNameKey("كيوان")).not.toBe(characterReferenceNameKey("کیوان"));
    expect(characterReferenceNameKey("Jose")).not.toBe(characterReferenceNameKey("José"));
  });
});

describe("characterSlug", () => {
  it("leaves an ASCII name's slug exactly as it was", () => {
    // Existing books' files are named from this; churning it would strand them.
    expect(characterSlug("Ada")).toBe("ada");
    expect(characterSlug("  Captain Luna Vega ")).toBe("captain-luna-vega");
    expect(characterSlug("Sam's Mother!")).toBe("sam-s-mother");
  });

  it("gives every non-Latin name in a cast its own file", () => {
    // The confirmed production failure: all three of these emptied out, became
    // the literal "unknown", and shared one `character-reference-unknown.jpg`.
    const persian = ["بهرام", "کیوان", "رهگذر دانا"].map(characterSlug);
    expect(new Set(persian).size).toBe(3);
    expect(persian).not.toContain("unknown");
    for (const slug of persian) {
      expect(slug).toMatch(/^char-[0-9a-f]{10}$/);
    }

    const others = ["Бахрам", "キーワン", "שרה"].map(characterSlug);
    expect(new Set([...persian, ...others]).size).toBe(6);
  });

  it("folds two spellings of one name onto one file", () => {
    // An Arabic kaf and a Persian one render identically and are typed
    // interchangeably; a rerun that spelled the name the other way must not
    // leave the book with two half-populated sheets.
    expect(characterSlug("كيوان")).toBe(characterSlug("کیوان"));
  });
});

describe("characterReferenceFileStems", () => {
  it("separates characters whose slugs collide", () => {
    // A mostly-Persian name still yields an ASCII slug from whatever Latin it
    // holds, so uniqueness cannot be a property of one name on its own.
    expect(characterReferenceFileStems(["Ada بهرام", "Ada کیوان", "Ada"], "r1")).toEqual([
      "character-reference-ada-r1",
      "character-reference-ada-2-r1",
      "character-reference-ada-3-r1"
    ]);
  });

  it("keeps a distinct cast's stems untouched", () => {
    expect(characterReferenceFileStems(["Ada", "Beatrice"], "r1")).toEqual([
      "character-reference-ada-r1",
      "character-reference-beatrice-r1"
    ]);
  });

  it("gives two passes over one cast disjoint stems", () => {
    // The renders left the advisory lock, so two passes over one cast can
    // overlap — an expired lease, or two plan versions of one book. Sharing a
    // stem means the loser's `writeFile` truncates a file the winner has
    // already published an `ImageAsset` row for.
    const first = characterReferenceFileStems(["Ada", "Beatrice"], "r1");
    const second = characterReferenceFileStems(["Ada", "Beatrice"], "r2");
    expect(new Set([...first, ...second]).size).toBe(4);
  });
});
