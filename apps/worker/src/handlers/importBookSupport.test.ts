import { describe, expect, it } from "vitest";
import type { ManuscriptStyleProfile, ParsedManuscript, SegmentedManuscript } from "@book-maker/core";
import {
  importChapterRows,
  importStats,
  importStyleProfileFromMediaSettings,
  mediaSettingsWithImportStyle,
  normalizeImportedLanguage
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
