import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { allBookFontSets, bookFontSetForLanguage } from "./bookFonts.js";
import { codePointsOf, embedFontFaceCss, parseUnicodeRange } from "./fontEmbedding.js";

const require = createRequire(import.meta.url);

describe("bookFontSetForLanguage", () => {
  it("resolves every shape a stored language takes", () => {
    const ids = ["fa", "Farsi", "Persian"].map((value) => bookFontSetForLanguage(value).id);
    expect(new Set(ids)).toEqual(new Set(["arabic-persian"]));
  });

  it("routes Arabic and Urdu to naskh and Persian to Vazirmatn", () => {
    expect(bookFontSetForLanguage("ar").id).toBe("arabic-naskh");
    expect(bookFontSetForLanguage("ur").id).toBe("arabic-naskh");
    expect(bookFontSetForLanguage("fa").body.at(-1)?.package).toContain("vazirmatn");
  });

  it("leaves Cyrillic and Greek on the Latin set", () => {
    // Source Serif and Inter already ship those subsets; they only rendered as
    // tofu because the old loader dropped the unicode-range.
    expect(bookFontSetForLanguage("ru").id).toBe("latin");
    expect(bookFontSetForLanguage("el").id).toBe("latin");
    expect(bookFontSetForLanguage(undefined).id).toBe("latin");
  });

  it("lists the Latin companion first and the script package last", () => {
    // Two faces of one family with overlapping ranges resolve to the later
    // declaration. Vazirmatn's Arabic subset claims ZWNJ, which Persian sets
    // inside words, so it has to be the one that wins — a Latin face taking it
    // would split the shaping run mid-word.
    for (const set of allBookFontSets()) {
      expect(set.body[0]?.package).toContain("source-serif-4");
      expect(set.display[0]?.package).toContain("inter");
      if (set.id === "latin") {
        expect(set.body).toHaveLength(1);
        continue;
      }
      expect(set.body.length).toBe(2);
      expect(set.body.at(-1)?.package).not.toContain("source-serif-4");
      expect(set.display.at(-1)?.package).not.toContain("/inter");
    }
  });
});

describe("font packages on disk", () => {
  // Catches a missing or renamed fontsource dependency at CI time rather than
  // at render time, where it would surface as a book full of tofu.
  it("resolves every CSS file every set names", () => {
    for (const set of allBookFontSets()) {
      for (const pkg of [...set.body, ...set.display]) {
        for (const cssFile of pkg.css) {
          expect(() => require.resolve(`${pkg.package}/${cssFile}`)).not.toThrow();
        }
      }
    }
  });

  // A character every book in that language actually contains. Probing the
  // start of the Unicode block would not do: Thai's block begins at U+0E00,
  // which is unassigned and in no font.
  const SAMPLES: Record<string, string> = {
    fa: "سلام",
    ar: "مرحبا",
    ur: "کتاب",
    he: "שלום",
    hi: "नमस्ते",
    th: "สวัสดี",
    zh: "测试",
    ja: "日本語",
    ko: "한국어",
    ru: "Привет",
    el: "Γειά",
    en: "Hello"
  };

  it("can render a real word in every language it claims", async () => {
    for (const [language, sample] of Object.entries(SAMPLES)) {
      const set = bookFontSetForLanguage(language);
      const codePoints = codePointsOf(sample);
      const css = await embedFontFaceCss([{ family: "Probe", packages: set.body, codePoints }]);
      const covered = [...sample].every((character) => {
        const point = character.codePointAt(0) as number;
        return [...css.matchAll(/unicode-range:\s*([^;]+);/g)].some((match) =>
          parseUnicodeRange(match[1] ?? "").some((entry) => point >= entry.start && point <= entry.end)
        );
      });
      expect(covered, `${language}: no embedded face covers "${sample}"`).toBe(true);
    }
  });
});
