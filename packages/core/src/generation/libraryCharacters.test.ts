import { describe, expect, it } from "vitest";
import {
  buildLibraryCharacterPortraitPrompt,
  characterReferenceSeedInstruction,
  foldCharacterName,
  libraryCharacterAppearanceRule,
  libraryCharacterDiskPath,
  libraryCharacterFaceInstruction,
  libraryCharacterFileName,
  libraryCharacterFileToken,
  libraryCharacterPromptBlock,
  libraryCharacterRelativeFile,
  libraryCharactersFromMediaSettings,
  matchLibraryCharacter,
  type LibraryCharacterSnapshot
} from "./libraryCharacters.js";

const snapshot = (overrides: Partial<LibraryCharacterSnapshot> = {}): LibraryCharacterSnapshot => ({
  id: "char-1",
  name: "Luna",
  description: "A brave night-flying rabbit.",
  fields: [{ key: "Age", value: "9" }],
  ...overrides
});

describe("libraryCharactersFromMediaSettings", () => {
  it("reads snapshots out of mediaSettings.mobile.characters", () => {
    const parsed = libraryCharactersFromMediaSettings({
      mobile: {
        characters: [
          { id: "a", name: "Luna", description: "d", fields: [{ key: "Age", value: "9" }], portraitFile: "u1/a-portrait.webp" }
        ]
      }
    });
    expect(parsed).toEqual([
      { id: "a", name: "Luna", description: "d", fields: [{ key: "Age", value: "9" }], portraitFile: "u1/a-portrait.webp" }
    ]);
  });

  it("keeps a recognised portraitSource and drops anything else", () => {
    const characters = [
      { id: "a", name: "A", portraitFile: "u1/a-portrait.webp", portraitSource: "adopted_upload" },
      { id: "b", name: "B", portraitFile: "u1/b-portrait.webp", portraitSource: "handmade" },
      // A source without a file describes nothing, so it is dropped with it.
      { id: "c", name: "C", portraitSource: "adopted_upload" }
    ];
    const parsed = libraryCharactersFromMediaSettings({ mobile: { characters } });
    expect(parsed.map((entry) => entry.portraitSource)).toEqual(["adopted_upload", undefined, undefined]);
  });

  it("returns [] for settings written before the feature existed", () => {
    expect(libraryCharactersFromMediaSettings({})).toEqual([]);
    expect(libraryCharactersFromMediaSettings({ mobile: {} })).toEqual([]);
    expect(libraryCharactersFromMediaSettings(null)).toEqual([]);
    expect(libraryCharactersFromMediaSettings({ mobile: { characters: "nope" } })).toEqual([]);
  });

  it("drops entries missing an id or name and tolerates junk rows", () => {
    const parsed = libraryCharactersFromMediaSettings({
      mobile: {
        characters: [{ id: "a" }, { name: "NoId" }, 42, null, { id: "b", name: "Kept" }]
      }
    });
    expect(parsed.map((entry) => entry.id)).toEqual(["b"]);
    expect(parsed[0]?.fields).toEqual([]);
  });

  it("caps the list and each character's fields", () => {
    const parsed = libraryCharactersFromMediaSettings({
      mobile: {
        characters: Array.from({ length: 14 }, (_, index) => ({
          id: `id-${index}`,
          name: `Name ${index}`,
          fields: Array.from({ length: 20 }, (_, fieldIndex) => ({ key: `k${fieldIndex}`, value: "v" }))
        }))
      }
    });
    expect(parsed).toHaveLength(10);
    expect(parsed[0]?.fields).toHaveLength(12);
  });
});

describe("matchLibraryCharacter", () => {
  const snapshots = [snapshot(), snapshot({ id: "char-2", name: "Mr. Whiskers" })];

  it("matches names exactly, ignoring case", () => {
    expect(matchLibraryCharacter("luna", snapshots)?.id).toBe("char-1");
  });

  it("matches a planner-expanded name containing the library name", () => {
    expect(matchLibraryCharacter("Captain Luna Vega", snapshots)?.id).toBe("char-1");
  });

  it("matches a planner-trimmed name contained in the library name", () => {
    expect(matchLibraryCharacter("Whiskers", snapshots)?.id).toBe("char-2");
  });

  it("does not match inside a longer word", () => {
    expect(matchLibraryCharacter("Lunatic", snapshots)).toBeNull();
  });

  it("returns null for blanks and strangers", () => {
    expect(matchLibraryCharacter("  ", snapshots)).toBeNull();
    expect(matchLibraryCharacter("Ada", snapshots)).toBeNull();
  });

  it("does not match a sub-token: a relation or a hyphenated name is someone else", () => {
    // "Sam's Mother" and "Luna-Bear" are the cases that put one reader's saved
    // face on a character they never saved. A missing seed is a character drawn
    // from prose; a wrong seed is a stranger wearing their character's face.
    const sam = [snapshot({ id: "sam", name: "Sam" })];
    expect(matchLibraryCharacter("Sam's Mother", sam)).toBeNull();
    expect(matchLibraryCharacter("Luna-Bear", snapshots)).toBeNull();
  });

  it("folds punctuation and spacing so 'Mr Whiskers' is 'Mr. Whiskers'", () => {
    expect(matchLibraryCharacter("Mr Whiskers", snapshots)?.id).toBe("char-2");
    expect(matchLibraryCharacter("Mr.  Whiskers", snapshots)?.id).toBe("char-2");
    expect(matchLibraryCharacter("Mr. Whiskers", snapshots)?.id).toBe("char-2");
  });

  it("folds Unicode: composed and decomposed names are one name", () => {
    const jose = [snapshot({ id: "jose", name: "José" })];
    expect(matchLibraryCharacter("José", jose)?.id).toBe("jose");
    expect(matchLibraryCharacter("Jose", jose)?.id).toBe("jose");
  });

  it("folds Arabic and Persian spellings of the same Persian name", () => {
    // Arabic kaf/yeh and Persian kaf/yeh render identically and are typed
    // interchangeably; a name saved from one keyboard and echoed by a model
    // trained on the other was two different names.
    const karim = [snapshot({ id: "karim", name: "کریم" })];
    expect(matchLibraryCharacter("كريم", karim)?.id).toBe("karim");
  });

  it("treats a ZWNJ compound as one token, so على does not seed علیرضا", () => {
    // ZWNJ is category Cf, so the old boundary class `[^\p{L}\p{N}]` accepted it
    // as a word break and matched an unrelated character.
    const ali = [snapshot({ id: "ali", name: "علی" })];
    expect(matchLibraryCharacter("علی‌رضا", ali)).toBeNull();
    expect(matchLibraryCharacter("علی", ali)?.id).toBe("ali");
  });

  it("refuses an ambiguous containment rather than guessing", () => {
    const twins = [
      snapshot({ id: "a", name: "Luna" }),
      snapshot({ id: "b", name: "Vega" })
    ];
    expect(matchLibraryCharacter("Luna Vega", twins)).toBeNull();
  });

  it("still prefers an exact match when another name also contains it", () => {
    const both = [
      snapshot({ id: "long", name: "Captain Luna Vega" }),
      snapshot({ id: "short", name: "Luna" })
    ];
    expect(matchLibraryCharacter("Luna", both)?.id).toBe("short");
  });
});

describe("foldCharacterName", () => {
  it("is idempotent and collapses every invisible the pipeline sees", () => {
    const folded = foldCharacterName("  Mr.‌  Whiskers﻿ ");
    expect(folded).toBe("mr. whiskers");
    expect(foldCharacterName(folded)).toBe(folded);
  });

  it("normalizes Arabic-Indic and Persian digits to ASCII", () => {
    expect(foldCharacterName("R2٠۱")).toBe("r201");
  });
});

describe("libraryCharacterDiskPath", () => {
  it("resolves exactly <userId>/<fileName> under the characters tree", () => {
    expect(libraryCharacterDiskPath("/store", "user-1/char-1-portrait.webp")).toBe(
      "/store/characters/user-1/char-1-portrait.webp"
    );
  });

  it("refuses traversal, absolute paths, and extra segments", () => {
    expect(libraryCharacterDiskPath("/store", "../../etc/passwd")).toBeNull();
    expect(libraryCharacterDiskPath("/store", "user-1/../secret")).toBeNull();
    expect(libraryCharacterDiskPath("/store", "/user-1/file.png")).toBeNull();
    expect(libraryCharacterDiskPath("/store", "a/b/c")).toBeNull();
    expect(libraryCharacterDiskPath("/store", "user-1/.hidden")).toBeNull();
    expect(libraryCharacterDiskPath("/store", "user-1")).toBeNull();
  });

  it("round-trips the writer's own naming helpers", () => {
    const file = libraryCharacterFileName("char-9", "photo", "jpg", "abc123def456");
    expect(libraryCharacterDiskPath("/store", libraryCharacterRelativeFile("user-2", file))).toBe(
      "/store/characters/user-2/char-9-photo-abc123def456.jpg"
    );
  });

  it("accepts a real minted token, and a cuid-length id keeps the name well inside the gate", () => {
    const token = libraryCharacterFileToken();
    const file = libraryCharacterFileName("cmspn24hs000uyxmu7pr9m3cw", "portrait", "jpeg", token);
    expect(file.length).toBeLessThan(181);
    expect(
      libraryCharacterDiskPath("/store", libraryCharacterRelativeFile("cmqejjndu000s1nqr1cla39or", file))
    ).not.toBeNull();
  });

  it("gives two writes of the same picture two different names", () => {
    // The whole point: the old deterministic name is what truncated the
    // previous version in place on every redraw.
    const first = libraryCharacterFileName("char-9", "portrait", "jpg", libraryCharacterFileToken());
    const second = libraryCharacterFileName("char-9", "portrait", "jpg", libraryCharacterFileToken());
    expect(first).not.toBe(second);
  });
});

describe("buildLibraryCharacterPortraitPrompt", () => {
  it("draws from the sheet alone without a photo", () => {
    const prompt = buildLibraryCharacterPortraitPrompt(snapshot(), { fromPhoto: false });
    expect(prompt).toContain("Luna");
    expect(prompt).toContain("Age: 9");
    expect(prompt).not.toContain("reference photo");
  });

  it("stylizes the attached photo when one exists", () => {
    const prompt = buildLibraryCharacterPortraitPrompt(snapshot(), { fromPhoto: true });
    expect(prompt).toContain("reference photo");
    expect(prompt).toContain("preserve their identity");
  });
});

describe("characterReferenceSeedInstruction", () => {
  it("extends a drawn portrait into the book's style", () => {
    const instruction = characterReferenceSeedInstruction("generated");
    expect(instruction).toContain("attached portrait");
    expect(instruction).toContain("book's art style");
  });

  it("re-poses adopted artwork instead of reinterpreting it", () => {
    // The user's own drawing IS the character, so the sheet may change the
    // pose and nothing else.
    const instruction = characterReferenceSeedInstruction("adopted_upload");
    expect(instruction).toContain("existing, approved artwork");
    expect(instruction).toContain("Do not restyle");
    expect(instruction).not.toContain("book's art style");
  });

  it("reads a snapshot written before adoption existed as a drawn portrait", () => {
    expect(characterReferenceSeedInstruction()).toBe(characterReferenceSeedInstruction("generated"));
  });
});

describe("libraryCharacterFaceInstruction", () => {
  it("says nothing when no saved artwork travels with the render", () => {
    expect(libraryCharacterFaceInstruction([])).toBe("");
  });

  it("names the trailing images as the face authority, not the style authority", () => {
    const one = libraryCharacterFaceInstruction(["Luna"]);
    expect(one).toContain("The last reference image is");
    expect(one).toContain("Luna");
    expect(one).toContain("final authority on their face");
    expect(one).toContain("take pose, outfit and art style from the other references");

    const two = libraryCharacterFaceInstruction(["Luna", "Bram"]);
    expect(two).toContain("The last 2 reference images are");
    expect(two).toContain("Luna and Bram");
  });
});

describe("libraryCharacterPromptBlock", () => {
  it("writes one bounded line per character", () => {
    const block = libraryCharacterPromptBlock([
      snapshot(),
      snapshot({ id: "char-2", name: "Bram", description: "x".repeat(600), fields: [] })
    ]);
    const lines = block.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Luna");
    expect(lines[1]!.length).toBeLessThanOrEqual(230);
    expect(lines[1]).toContain("…");
  });

  it("never exceeds ten characters", () => {
    const block = libraryCharacterPromptBlock(
      Array.from({ length: 15 }, (_, index) => snapshot({ id: `c${index}`, name: `Name${index}` }))
    );
    expect(block.split("\n")).toHaveLength(10);
  });

  it("gives the appearance its own labelled line and its own budget", () => {
    // Truncating a look is not a shorter sentence, it is a licence to invent
    // the rest — so the biography gives way and the appearance does not.
    const block = libraryCharacterPromptBlock([
      snapshot({
        description: "y".repeat(600),
        appearance: "Adult woman in a black hijab and a grey embroidered top."
      })
    ]);
    const lines = block.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("…");
    expect(lines[1]).toContain("Appearance (fixed — use verbatim, do not invent or alter)");
    expect(lines[1]).toContain("black hijab");
    expect(lines[1]).not.toContain("…");
  });

  it("writes no appearance line for a character who has none", () => {
    expect(libraryCharacterPromptBlock([snapshot()]).split("\n")).toHaveLength(1);
  });
});

describe("libraryCharacterAppearanceRule", () => {
  it("says nothing when no library character travels with the plan", () => {
    expect(libraryCharacterAppearanceRule([])).toBe("");
  });

  it("orders a recorded look reused verbatim", () => {
    const rule = libraryCharacterAppearanceRule([snapshot({ appearance: "Black hijab, grey top." })]);
    expect(rule).toContain('"Luna"');
    expect(rule).toContain("word for word");
    expect(rule).toContain("never write a physical detail that contradicts it");
  });

  it("forbids inventing a look for a character whose picture the model cannot see", () => {
    // This is the actual bug: with no appearance in text the planner wrote
    // "a young Brazilian girl with dark hair in a ponytail, wearing a simple
    // dress" for a woman in a hijab, and that text beat the attached portrait.
    const rule = libraryCharacterAppearanceRule([snapshot()]);
    expect(rule).toContain("no appearance is recorded");
    expect(rule).toContain("Leave their visualRules empty");
    expect(rule).toContain("refer to them by name only");
  });

  it("splits a mixed cast into the two honest instructions", () => {
    const rule = libraryCharacterAppearanceRule([
      snapshot({ id: "a", name: "Luna", appearance: "Black hijab." }),
      snapshot({ id: "b", name: "Bram" })
    ]);
    expect(rule).toContain('"Luna", the Appearance line');
    expect(rule).toContain('"Bram", no appearance is recorded');
  });
});
