import { describe, expect, it } from "vitest";
import type { ManuscriptStyleProfile, ParsedManuscript, SegmentedManuscript } from "@book-maker/core";
import {
  importChapterRows,
  importStats,
  importStyleProfileFromMediaSettings,
  mediaSettingsWithImportStyle,
  normalizeImportedLanguage,
  screenRestoredImportMatter
} from "./importBookSupport.js";

const segmented: SegmentedManuscript = {
  segmentation: "structure",
  pageCount: 3,
  chapters: [
    {
      title: "The Storm",
      summary: "Rain arrives.",
      pages: [
        { title: "The Storm · 1", markdown: "Rain fell.", summary: "Rain fell." },
        { title: "The Storm · 2", markdown: "It kept falling.", summary: "It kept falling." }
      ]
    },
    {
      title: "The Calm",
      summary: "Quiet morning.",
      pages: [{ title: "The Calm", markdown: "Morning came.", summary: "Morning came." }]
    }
  ]
};

const style: ManuscriptStyleProfile = {
  voiceGuide: ["Short sentences."],
  antiAiRules: ["No filler."],
  tone: "quiet",
  pointOfView: "third person",
  tense: "past",
  audience: "Adults",
  writingComplexity: 6,
  premise: "A storm passes.",
  detectedLanguage: "en",
  sampleExcerpts: []
};

describe("importChapterRows", () => {
  it("assigns global sequential page indexes across chapters", () => {
    const rows = importChapterRows(segmented);
    expect(rows.map((row) => row.index)).toEqual([1, 2]);
    expect(rows[0]!.pages.map((page) => page.index)).toEqual([1, 2]);
    expect(rows[1]!.pages.map((page) => page.index)).toEqual([3]);
    expect(rows[0]!.targetPages).toBe(2);
  });
});

describe("importStats", () => {
  it("summarizes parse and segmentation results", () => {
    const parsed = { charCount: 1234, wordCount: 200, sections: [], text: "" } as unknown as ParsedManuscript;
    expect(importStats(parsed, segmented)).toEqual({
      charCount: 1234,
      wordCount: 200,
      chapterCount: 2,
      pageCount: 3,
      segmentation: "structure"
    });
  });
});

describe("mediaSettingsWithImportStyle", () => {
  it("stores the style profile under mobile.import without touching other keys", () => {
    const settings = mediaSettingsWithImportStyle(
      {
        fullIllustrations: false,
        toneProfile: "neutral",
        mobile: { bookType: "custom", import: { importId: "imp_1", format: "docx" } }
      },
      style
    );
    expect(settings.fullIllustrations).toBe(false);
    const mobile = settings.mobile as { bookType: string; import: Record<string, unknown> };
    expect(mobile.bookType).toBe("custom");
    expect(mobile.import.importId).toBe("imp_1");
    expect(mobile.import.styleProfile).toEqual(style);
    expect(importStyleProfileFromMediaSettings(settings)).toEqual(style);
  });

  it("returns null for projects that were never imported", () => {
    expect(importStyleProfileFromMediaSettings({ mobile: { bookType: "custom" } })).toBeNull();
    expect(importStyleProfileFromMediaSettings(null)).toBeNull();
  });

  it("falls back to the profile a Studio book learned, so continuation keeps the author's voice", () => {
    const studioProfile = { voiceGuide: ["Short sentences."], sampleExcerpts: ["It rained."] };
    const studio = { layout: "flow", kind: "story", createdAt: "2026-09-29", styleProfile: studioProfile };
    expect(importStyleProfileFromMediaSettings({ mobile: { studio } })).toEqual(studioProfile);
    expect(
      importStyleProfileFromMediaSettings({ mobile: { studio, import: { styleProfile: { voiceGuide: ["Imported."] } } } })
    ).toEqual({ voiceGuide: ["Imported."] });
    expect(importStyleProfileFromMediaSettings({ mobile: { studio: { layout: "flow" } } })).toBeNull();
  });
});

describe("normalizeImportedLanguage", () => {
  it("prefers a usable detected language and falls back otherwise", () => {
    expect(normalizeImportedLanguage("fa", "en")).toBe("fa");
    expect(normalizeImportedLanguage("Persian", "en")).toBe("Persian");
    expect(normalizeImportedLanguage("x", "en")).toBe("en");
    expect(normalizeImportedLanguage(undefined, "en")).toBe("en");
    expect(normalizeImportedLanguage(`${"x".repeat(50)}`, "en")).toBe("en");
  });
});

describe("screenRestoredImportMatter", () => {
  const refusedText = "This author writes about CSAM.";

  it("drops each refused field alone and keeps every other field", () => {
    const screened = screenRestoredImportMatter({
      authorName: refusedText,
      subtitle: "A Valley Story",
      bookMatter: { dedication: "For my mother", aboutAuthor: refusedText, copyrightYear: "2020", allRightsReserved: true }
    }, false);

    expect(screened.restored).toEqual({
      subtitle: "A Valley Story",
      bookMatter: { dedication: "For my mother", copyrightYear: "2020", allRightsReserved: true }
    });
    expect(screened.refused).toEqual([
      { field: "authorName", reason: "critical_illegal_harm" },
      { field: "aboutAuthor", reason: "critical_illegal_harm" }
    ]);
  });

  it("omits matter that has nothing left, as the import merge does", () => {
    expect(screenRestoredImportMatter({ bookMatter: { dedication: refusedText } }, false)).toEqual({
      restored: {},
      refused: [{ field: "dedication", reason: "critical_illegal_harm" }]
    });
  });

  it("applies the copyright rule only when the operator enabled it, and keeps printed memorial text", () => {
    const restored = {
      bookMatter: {
        aboutAuthor: "Copy the entire copyrighted book without permission.",
        dedication: "To the victims of the terrorist attack, who taught us how to grieve."
      }
    };

    expect(screenRestoredImportMatter(restored, false)).toEqual({ restored, refused: [] });
    expect(screenRestoredImportMatter(restored, true)).toEqual({
      restored: { bookMatter: { dedication: restored.bookMatter.dedication } },
      refused: [{ field: "aboutAuthor", reason: "copyright" }]
    });
  });
});
