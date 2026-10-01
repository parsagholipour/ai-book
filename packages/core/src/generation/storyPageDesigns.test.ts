import { describe, expect, it } from "vitest";
import {
  allStoryPageDesigns,
  chooseStoryPageDesign,
  requestedStoryPageDesign,
  STORY_PAGE_DESIGN_IDS,
  storyPageDesignField,
  storyPageDesignFor,
  storyPageDesignPreference
} from "./storyPageDesigns.js";
import { STORY_PAGE_PDF_CSS } from "./pdfStoryPages.js";

describe("requestedStoryPageDesign", () => {
  it("reads a design named next to a word about how the pages look", () => {
    expect(requestedStoryPageDesign("make the pages look like the night sky")).toBe("night");
    expect(requestedStoryPageDesign("I want the ocean design")).toBe("ocean");
    expect(requestedStoryPageDesign("use a plain layout please")).toBe("classic");
    expect(requestedStoryPageDesign("a brighter colour scheme")).toBe("rainbow");
    expect(requestedStoryPageDesign("fairy tale style")).toBe("fairytale");
    expect(requestedStoryPageDesign("a space theme!")).toBe("space");
    expect(requestedStoryPageDesign("a garden look")).toBe("meadow");
    expect(requestedStoryPageDesign("back to the pastel design")).toBe("storybook");
  });

  it("takes the design named last", () => {
    expect(requestedStoryPageDesign("not the night one, the ocean design")).toBe("ocean");
  });

  it("does not read a subject, or a design word far from any look-word, as a choice", () => {
    expect(requestedStoryPageDesign("a story about the sea")).toBeUndefined();
    expect(requestedStoryPageDesign("a simple 12 page story about a bunny")).toBeUndefined();
    expect(requestedStoryPageDesign("make it darker")).toBeUndefined();
    expect(requestedStoryPageDesign("rewrite page 3 to be about the sea")).toBeUndefined();
    // A colour is the story's text before it is a look.
    expect(requestedStoryPageDesign("change the colour of Mira's dress to blue")).toBeUndefined();
  });
});

describe("chooseStoryPageDesign", () => {
  it("matches a children's book to the world its words are in", () => {
    expect(chooseStoryPageDesign("Mira and the Nighttime Creak. A bedtime story about a creak in the hall and the moonlight.")).toBe("night");
    expect(chooseStoryPageDesign("Tiko and the Quiet Sea. Tiko longs to see the sea and meets a whale.")).toBe("ocean");
    expect(chooseStoryPageDesign("Benny the Bunny plants a garden in the forest.")).toBe("meadow");
    expect(chooseStoryPageDesign("Luna flies her rocket to Mars.")).toBe("space");
    expect(chooseStoryPageDesign("Princess Ada and the dragon in the castle.")).toBe("fairytale");
    expect(chooseStoryPageDesign("A birthday party with rainbow balloons.")).toBe("rainbow");
  });

  it("reads Persian subjects too", () => {
    expect(chooseStoryPageDesign("داستانی درباره خرگوشی که در جنگل باغ می‌سازد")).toBe("meadow");
    expect(chooseStoryPageDesign("قصه‌ای برای خواب شب")).toBe("night");
  });

  it("falls back to the pastel storybook, and lets a named design outrank the subject", () => {
    expect(chooseStoryPageDesign("Sam learns to tie his shoes.")).toBe("storybook");
    expect(chooseStoryPageDesign("A bedtime story about a whale, with a plain layout.")).toBe("classic");
  });
});

describe("storyPageDesignFor", () => {
  const plan = { title: "Mira and the Nighttime Creak", premise: "A bedtime story about the moon." };

  it("keeps the reader's choice above any match", () => {
    expect(storyPageDesignFor({ mediaSettings: { storyPageDesign: "ocean" }, category: "KIDS", plan })).toBe("ocean");
    expect(storyPageDesignFor({ mediaSettings: { storyPageDesign: "space" }, category: "STORY", plan })).toBe("space");
  });

  it("matches a children's book and leaves every other book plain", () => {
    expect(storyPageDesignFor({ mediaSettings: {}, category: "KIDS", plan })).toBe("night");
    expect(storyPageDesignFor({ mediaSettings: {}, category: "STORY", plan })).toBeUndefined();
  });

  it("ignores a stored value that is not a design", () => {
    expect(storyPageDesignPreference({ storyPageDesign: "neon" })).toBeUndefined();
    expect(storyPageDesignFor({ mediaSettings: { storyPageDesign: "neon" }, category: "KIDS", plan })).toBe("night");
  });

  it("gives a compile that resolved nothing a children's book's pastel default", () => {
    expect(storyPageDesignField({ category: "KIDS" })).toEqual({ storyPageDesign: "storybook" });
    expect(storyPageDesignField({ category: "STORY" })).toEqual({});
    expect(storyPageDesignField({ category: "KIDS", storyPageDesign: "classic" })).toEqual({ storyPageDesign: "classic" });
  });
});

describe("the design catalog", () => {
  it("styles every design in the stylesheet, one rule per sheet colour", () => {
    for (const design of allStoryPageDesigns()) {
      expect(STORY_PAGE_PDF_CSS).toContain(`.pdf-story-scene--design-${design.id} {`);
      for (const [index] of design.sheets.entries()) {
        expect(STORY_PAGE_PDF_CSS).toContain(`.pdf-story-scene--design-${design.id}.pdf-story-scene--sheet-${index}`);
      }
    }
    expect(allStoryPageDesigns().map((design) => design.id)).toEqual([...STORY_PAGE_DESIGN_IDS]);
  });
});
