import { describe, expect, it } from "vitest";
import {
  foldArabicKafYehOntoPersian,
  stripArabicOptionalMarks,
  stripInvisibleMarks,
  stripOptionalSpellingMarks
} from "./orthographyFolds.js";

describe("stripInvisibleMarks", () => {
  it("deletes ZWNJ rather than treating it as a space", () => {
    // Persian sets ZWNJ inside words: «به‌عنوان» is one word and "علی‌رضا" is
    // one name. `\s` does not match U+200C, which is how «به‌عنوان یک مدل زبانی»
    // sailed past a leak pattern written with `\s+`.
    expect(stripInvisibleMarks("به‌عنوان")).toBe("بهعنوان");
    expect(stripInvisibleMarks("علی‌رضا")).toBe("علیرضا");
  });

  it("deletes ZWJ, the bidi controls and the BOM, and nothing visible", () => {
    expect(stripInvisibleMarks("a\u200Db\u200E\u202Ac\u2066d\uFEFF")).toBe("abcd");
    expect(stripInvisibleMarks("Mr. Whiskers — José")).toBe("Mr. Whiskers — José");
  });
});

describe("stripArabicOptionalMarks", () => {
  it("makes both tanween encodings and the bare spelling one string", () => {
    // «نموذجًا» is normally fathatan-then-alef; a pattern assuming
    // alef-then-fathatan ran its `\s+` into a diacritic and matched nothing.
    expect(stripArabicOptionalMarks("نموذجًا")).toBe("نموذجا");
    expect(stripArabicOptionalMarks("نموذجاً")).toBe("نموذجا");
    expect(stripArabicOptionalMarks("نموذجا")).toBe("نموذجا");
  });

  it("drops the tatweel, which is elongation rather than spelling", () => {
    expect(stripArabicOptionalMarks("بصفتـي نمـوذجا")).toBe("بصفتي نموذجا");
  });

  it("leaves the Latin combining marks alone, because it runs on composed prose", () => {
    // Without an NFD pass, U+0300–U+036F appears only where an author typed a
    // decomposed accent — deleting it there would rewrite their prose.
    const decomposed = "José";
    expect(stripArabicOptionalMarks(decomposed)).toBe(decomposed);
  });
});

describe("stripOptionalSpellingMarks", () => {
  it("drops the marks a spelling carries or does not", () => {
    expect(stripOptionalSpellingMarks("José".normalize("NFD"))).toBe("Jose");
    // Arabic harakat, and Hebrew niqqud — Hebrew is written unpointed, so
    // pointing is an annotation rather than a letter.
    expect(stripOptionalSpellingMarks("عَلِيّ".normalize("NFD"))).toBe("علي");
    expect(stripOptionalSpellingMarks("שָׁלוֹם".normalize("NFD"))).toBe("שלום");
  });

  it("is an allowlist and must stay one: a script's vowels are not optional", () => {
    // The scar. This was `\p{M}`, so Devanagari matras went with the harakat:
    // "मीरा" and "मारा" both folded to the bare consonants "मर", and two saved
    // characters became one name to `matchLibraryCharacter`. Thai sara and —
    // after the NFD — the Japanese dakuten were the same collision.
    const fold = (value: string): string => stripOptionalSpellingMarks(value.normalize("NFD"));
    expect(fold("मीरा")).not.toBe(fold("मारा"));
    expect(fold("ผี")).not.toBe(fold("ผา"));
    expect(fold("ガ")).not.toBe(fold("カ"));
  });

  it("covers every mark stripArabicOptionalMarks does", () => {
    // The two used to be hand-copied tables under a comment claiming they
    // mirrored each other. The Arabic ranges are now literally one constant, so
    // this is a check that the wider list never stops containing the narrower.
    const arabicMarks =
      "\u0610\u061A\u064B\u065F\u0670\u06D6\u06DC\u06DF\u06E4\u06E7\u06E8\u06EA\u06ED\u0640";
    expect(stripArabicOptionalMarks(arabicMarks)).toBe("");
    expect(stripOptionalSpellingMarks(arabicMarks)).toBe("");
  });
});

describe("foldArabicKafYehOntoPersian", () => {
  it("folds the letters that render alike and are typed interchangeably", () => {
    expect(foldArabicKafYehOntoPersian("كريم")).toBe("کریم");
    expect(foldArabicKafYehOntoPersian("کریم")).toBe("کریم");
    // Alef maksura is the same glyph undotted.
    expect(foldArabicKafYehOntoPersian("مصطفى")).toBe("مصطفی");
  });

  it("is idempotent and leaves everything else alone", () => {
    const once = foldArabicKafYehOntoPersian("بصفتي نموذجا لغوي, José");
    expect(foldArabicKafYehOntoPersian(once)).toBe(once);
    expect(once).toContain("José");
  });
});
