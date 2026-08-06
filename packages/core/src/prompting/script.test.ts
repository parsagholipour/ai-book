import { describe, expect, it } from "vitest";
import { isRtlLanguage, scriptProfileForLanguage } from "./script.js";

type Expected = { script: string; direction: "ltr" | "rtl"; code: string };

// `Project.language` is written as a code by the creation chat, as an English
// label by the REST route, and as whatever the client sent by the mobile create
// route — which is how a book ended up stored as "Farsi". All three shapes have
// to land on the same profile.
const CASES: ReadonlyArray<[string | null | undefined, Expected]> = [
  ["fa", { script: "arabic", direction: "rtl", code: "fa" }],
  ["Farsi", { script: "arabic", direction: "rtl", code: "fa" }],
  ["Persian", { script: "arabic", direction: "rtl", code: "fa" }],
  ["FA", { script: "arabic", direction: "rtl", code: "fa" }],
  ["  persian  ", { script: "arabic", direction: "rtl", code: "fa" }],
  ["ar", { script: "arabic", direction: "rtl", code: "ar" }],
  ["Arabic", { script: "arabic", direction: "rtl", code: "ar" }],
  ["ur", { script: "arabic", direction: "rtl", code: "ur" }],
  ["he", { script: "hebrew", direction: "rtl", code: "he" }],
  ["Hebrew", { script: "hebrew", direction: "rtl", code: "he" }],
  ["hi", { script: "devanagari", direction: "ltr", code: "hi" }],
  ["th", { script: "thai", direction: "ltr", code: "th" }],
  ["zh", { script: "han-simplified", direction: "ltr", code: "zh" }],
  ["zh-CN", { script: "han-simplified", direction: "ltr", code: "zh" }],
  ["ja", { script: "japanese", direction: "ltr", code: "ja" }],
  ["ko", { script: "korean", direction: "ltr", code: "ko" }],
  ["ru", { script: "cyrillic", direction: "ltr", code: "ru" }],
  ["el", { script: "greek", direction: "ltr", code: "el" }],
  ["vi", { script: "latin", direction: "ltr", code: "vi" }],
  ["es", { script: "latin", direction: "ltr", code: "es" }],
  ["en", { script: "latin", direction: "ltr", code: "en" }],
  ["English", { script: "latin", direction: "ltr", code: "en" }],
  ["en-GB", { script: "latin", direction: "ltr", code: "en" }],
  ["", { script: "latin", direction: "ltr", code: "en" }],
  ["   ", { script: "latin", direction: "ltr", code: "en" }],
  [undefined, { script: "latin", direction: "ltr", code: "en" }],
  [null, { script: "latin", direction: "ltr", code: "en" }],
  // Unmapped: Latin fonts, but a code we can still put in `lang` when it has one.
  ["Klingon", { script: "latin", direction: "ltr", code: "en" }],
  ["am", { script: "latin", direction: "ltr", code: "am" }]
];

describe("scriptProfileForLanguage", () => {
  for (const [language, expected] of CASES) {
    it(`resolves ${JSON.stringify(language)}`, () => {
      const profile = scriptProfileForLanguage(language);
      expect({ script: profile.script, direction: profile.direction, code: profile.code }).toEqual(expected);
    });
  }

  it("marks only joining scripts cursive", () => {
    expect(scriptProfileForLanguage("fa").cursive).toBe(true);
    expect(scriptProfileForLanguage("hi").cursive).toBe(true);
    // Hebrew letters do not join, so tracking is safe there.
    expect(scriptProfileForLanguage("he").cursive).toBe(false);
    expect(scriptProfileForLanguage("zh").cursive).toBe(false);
    expect(scriptProfileForLanguage("en").cursive).toBe(false);
  });

  it("claims an italic face only where one exists", () => {
    expect(scriptProfileForLanguage("en").hasItalic).toBe(true);
    expect(scriptProfileForLanguage("ru").hasItalic).toBe(true);
    expect(scriptProfileForLanguage("fa").hasItalic).toBe(false);
    expect(scriptProfileForLanguage("ja").hasItalic).toBe(false);
  });

  it("never widens a cover line budget beyond the Latin calibration", () => {
    for (const [language] of CASES) {
      expect(scriptProfileForLanguage(language).charWidthScale).toBeLessThanOrEqual(1);
    }
  });
});

describe("isRtlLanguage", () => {
  // The two agree by construction; this guards the move out of `audiobook/`,
  // where the narration timeline still reads the direction from it.
  it("agrees with the profile's direction", () => {
    for (const [language] of CASES) {
      expect(isRtlLanguage(language)).toBe(scriptProfileForLanguage(language).direction === "rtl");
    }
  });

  it("still reads region subtags and bare names", () => {
    expect(isRtlLanguage("ar-EG")).toBe(true);
    expect(isRtlLanguage("Persian")).toBe(true);
    expect(isRtlLanguage("French")).toBe(false);
  });
});
