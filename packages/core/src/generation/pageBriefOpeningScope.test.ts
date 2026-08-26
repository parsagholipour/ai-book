import { describe, expect, it } from "vitest";
import { finalizeProductionPageBeat } from "./pageBriefOpeningScope.js";

const chapter = {
  index: 1,
  title: "The First World War",
  summary: "An industrialized catastrophe.",
  targetPages: 12,
  keyBeats: [
    "July Crisis",
    "Ottoman entry and Middle Eastern fronts",
    "Gallipoli",
    "unrestricted submarine warfare",
    "poison gas",
    "the United States' entry"
  ]
};

describe("finalizeProductionPageBeat overpack", () => {
  it("leaves a non-opening survey untouched", () => {
    const page = {
      pageIndex: 10,
      chapterIndex: 1,
      purpose: "Trace the war's expansion and changing methods while maintaining a clear distinction between fronts.",
      beat: "Survey a limited set of consequential developments: the Ottoman entry and Middle Eastern fronts, Gallipoli, unrestricted submarine warfare, poison gas, and the United States' entry. Explain why each mattered without turning the page into a list.",
      requiredContinuity: ["Use a chronological spine."],
      endingPressure: "Point toward 1917 and 1918."
    };

    const finalized = finalizeProductionPageBeat(page, [], {
      chapter,
      chapterPageStart: 1,
      chapterPageEnd: 12
    });

    expect(finalized).toBe(page);
  });

  it("leaves a comma-heavy opening untouched when it does not enumerate chapter keyBeats", () => {
    const page = {
      pageIndex: 1,
      chapterIndex: 1,
      purpose: "Explain one survey's findings.",
      beat: "Explain how the household survey revealed starvation, forced displacement, epidemic disease, and political mistrust within one community.",
      requiredContinuity: ["Keep the evidence tied to one community."],
      endingPressure: "The findings force one relief decision."
    };

    const finalized = finalizeProductionPageBeat(page, [], {
      chapter,
      chapterPageStart: 1,
      chapterPageEnd: 12
    });

    expect(finalized).toBe(page);
  });

  it("normalizes an opening only when it contains four structured chapter keyBeats", () => {
    const page = {
      pageIndex: 1,
      chapterIndex: 1,
      purpose: "Survey the whole chapter.",
      beat: "Survey July Crisis, Ottoman entry and Middle Eastern fronts, Gallipoli, unrestricted submarine warfare, and poison gas.",
      requiredContinuity: [],
      endingPressure: "Continue the survey."
    };

    const finalized = finalizeProductionPageBeat(page, [], {
      chapter,
      chapterPageStart: 1,
      chapterPageEnd: 12
    });

    expect(finalized.beat).toBe(
      "Open the chapter on July Crisis. Keep this page on that event and its immediate context only."
    );
  });
});
