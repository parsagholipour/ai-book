import { describe, expect, it } from "vitest";
import type { CreateProjectInput } from "../schemas/book.js";
import {
  missingStyleLockIndexes,
  pagesForStyleExcerpts,
  pinStyleExcerpts,
  sampleExcerptsFromInput,
  type PriorPageContext
} from "./pagesShared.js";

function page(index: number, voice: string): PriorPageContext {
  return {
    index,
    title: `Page ${index}`,
    markdown: `${voice} ${"prose ".repeat(20)}`,
    summary: `Summary ${index}`
  };
}

describe("pinStyleExcerpts", () => {
  it("excerpts the two lowest-index pages even when they are not first in the array", () => {
    const excerpts = pinStyleExcerpts([
      page(17, "seventeen-window"),
      page(18, "eighteen-window"),
      page(1, "opening-voice"),
      page(2, "second-voice")
    ]);
    expect(excerpts).toHaveLength(2);
    expect(excerpts[0]).toContain("opening-voice");
    expect(excerpts[1]).toContain("second-voice");
    expect(excerpts.join(" ")).not.toMatch(/seventeen-window|eighteen-window/);
  });

  it("cannot invent pages 1 and 2 when only later pages are present", () => {
    const excerpts = pinStyleExcerpts([page(17, "seventeen-window"), page(18, "eighteen-window")]);
    expect(excerpts).toHaveLength(2);
    expect(excerpts[0]).toContain("seventeen-window");
    expect(excerpts[1]).toContain("eighteen-window");
  });
});

describe("sampleExcerptsFromInput", () => {
  const baseInput = {
    prompt: "A story.",
    category: "STORY",
    targetPages: 8,
    complexity: 5,
    temperature: 0.8,
    language: "en",
    mediaSettings: {
      fullIllustrations: false,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "auto",
      finalReview: true,
      toneProfile: "neutral"
    }
  } as CreateProjectInput;

  it("returns mediaSettings.mobile.import.styleProfile.sampleExcerpts", () => {
    const excerpts = sampleExcerptsFromInput({
      ...baseInput,
      mediaSettings: {
        ...baseInput.mediaSettings,
        mobile: {
          import: {
            styleProfile: {
              sampleExcerpts: ["Opening cadence.", "Second voice.", ""]
            }
          }
        }
      }
    } as CreateProjectInput);
    expect(excerpts).toEqual(["Opening cadence.", "Second voice."]);
  });

  it("yields an empty list when mobile is missing", () => {
    expect(sampleExcerptsFromInput(baseInput)).toEqual([]);
  });
});

describe("style lock helpers", () => {
  it("names indexes 1 and 2 as missing from a page-21 recency window", () => {
    const recency = Array.from({ length: 18 }, (_, offset) => ({ index: offset + 3 }));
    expect(missingStyleLockIndexes(recency, 21)).toEqual([1, 2]);
  });

  it("names only index 1 as missing when the window still holds page 2", () => {
    const recency = Array.from({ length: 18 }, (_, offset) => ({ index: offset + 2 }));
    expect(missingStyleLockIndexes(recency, 20)).toEqual([1]);
  });

  it("concatenates loaded pages 1–2 for excerpts without replacing the recency window", () => {
    const recency = [page(17, "seventeen-window"), page(18, "eighteen-window")];
    const lock = [page(1, "opening-voice"), page(2, "second-voice")];
    const merged = pagesForStyleExcerpts(recency, lock);
    expect(merged.map((entry) => entry.index)).toEqual([1, 2, 17, 18]);
    expect(recency.map((entry) => entry.index)).toEqual([17, 18]);
    expect(pinStyleExcerpts(merged)[0]).toContain("opening-voice");
    expect(pinStyleExcerpts(merged)[1]).toContain("second-voice");
  });
});
