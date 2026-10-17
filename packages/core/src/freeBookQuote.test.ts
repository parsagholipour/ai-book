import { describe, expect, it } from "vitest";
import {
  creditCostForOperation,
  estimateBookReplanCreditCost,
  estimateFullBookCreditCost,
  estimateInteriorImageCount
} from "./billing.js";
import { DEFAULT_CREDIT_COSTS, normalizeCreditPricing } from "./creditPricing.js";
import { pictureBookIllustrationCap } from "./generation/illustrationSlots.js";
import { createProjectSchema } from "./schemas/book.js";

/**
 * A book is one charge, taken at plan approval, and its finished file downloads
 * free — there is no per-book export unlock any more, for a free reader or a
 * paid one (2026-10-15). Totals are spelled out rather than derived from the
 * price table, because the app's `estimateProjectCredits` mirrors them with no
 * server quote route behind it.
 */
const kidsBook = (targetPages: number, coverArtSource: "ai" | "design" = "ai") =>
  createProjectSchema.parse({
    prompt: "A bedtime story about a rabbit who is afraid of the dark.",
    category: "KIDS",
    targetPages,
    mediaSettings: {
      fullIllustrations: true,
      illustrationCadence: "template-driven",
      coverArtSource,
      modelTier: "balanced",
      mobile: { bookType: "short_story", bookTypeChoice: "children_story" }
    }
  });

const story = (targetPages: number, illustrated: boolean) =>
  createProjectSchema.parse({
    prompt: "A quiet story about a lighthouse keeper and the last ship.",
    category: "STORY",
    targetPages,
    mediaSettings: {
      fullIllustrations: illustrated,
      illustrationCadence: "template-driven",
      coverArtSource: illustrated ? "ai" : "design",
      modelTier: "balanced",
      mobile: { bookType: "short_story", bookTypeChoice: "short_story" }
    }
  });

describe("a book's quote", () => {
  it("has no export line, and its lines add up to its total", () => {
    const quote = estimateFullBookCreditCost(kidsBook(12), DEFAULT_CREDIT_COSTS);

    expect(quote.lineItems.map((line) => line.code)).toEqual([
      "FULL_BOOK_GENERATION",
      "IMAGE_GENERATION",
      "IMAGE_GENERATION",
      "PREMIUM_REVIEW"
    ]);
    expect(quote.assumptions).not.toHaveProperty("includesExportUnlock");
    expect(quote.lineItems.reduce((total, line) => total + line.credits, 0)).toBe(quote.totalCredits);
  });

  it.each([
    // pages, pictures, total (Balanced, drawn cover)
    [5, 2, 350 + 5 * 8 + 2 * 45 + 45],
    [10, 4, 350 + 10 * 8 + 4 * 45 + 45],
    [12, 5, 350 + 12 * 8 + 5 * 45 + 45],
    [16, 6, 350 + 16 * 8 + 6 * 45 + 45],
    [24, 10, 350 + 24 * 8 + 10 * 45 + 45],
    [30, 12, 350 + 30 * 8 + 12 * 45 + 45]
  ])("quotes a %i-page illustrated picture book with %i pictures", (pages, pictures, total) => {
    const input = kidsBook(pages);
    expect(estimateInteriorImageCount(input)).toBe(pictures);
    expect(estimateFullBookCreditCost(input, DEFAULT_CREDIT_COSTS).totalCredits).toBe(total);
  });

  it("quotes a 30-page story the same way", () => {
    // Text only, designed cover: base + pages and nothing else.
    expect(estimateFullBookCreditCost(story(30, false), DEFAULT_CREDIT_COSTS).totalCredits).toBe(350 + 30 * 8);
    // Illustrated: pages 1, 8, 16 and 24, and a drawn cover.
    expect(estimateFullBookCreditCost(story(30, true), DEFAULT_CREDIT_COSTS).totalCredits).toBe(
      350 + 30 * 8 + 4 * 45 + 45
    );
  });

  it("quotes a rebuild as its fee plus the same book", () => {
    const input = kidsBook(16);
    const rebuild = estimateBookReplanCreditCost(input, DEFAULT_CREDIT_COSTS);
    expect(rebuild.totalCredits).toBe(120 + estimateFullBookCreditCost(input, DEFAULT_CREDIT_COSTS).totalCredits);
    expect(rebuild.lineItems.some((line) => line.code === "EXPORT_UNLOCK")).toBe(false);
  });

  it("prices the retired unlock at nothing, even from a price list that stored 150", () => {
    const stored = normalizeCreditPricing({ ...DEFAULT_CREDIT_COSTS, exportUnlock: 150 });
    expect(stored.exportUnlock).toBe(0);
    expect(creditCostForOperation("EXPORT_UNLOCK", stored)).toBe(0);
    expect(estimateFullBookCreditCost(kidsBook(12), stored).totalCredits).toBe(350 + 12 * 8 + 5 * 45 + 45);
  });
});

describe("the picture book's picture budget", () => {
  // Two pictures for every five pages, rounded to the nearest, at least one and
  // at most twelve (2026-10-17; it was min(pages, 12)). The app's
  // `pictureBookIllustrationCount` spells the same table.
  it.each([
    [1, 1], [2, 1], [3, 1], [4, 2], [5, 2], [8, 3], [9, 4], [10, 4], [11, 4], [12, 5], [13, 5], [16, 6],
    [20, 8], [24, 10], [28, 11], [29, 12], [30, 12], [40, 12]
  ])("draws %i pages with %i pictures", (pages, pictures) => {
    expect(pictureBookIllustrationCap(pages)).toBe(pictures);
    expect(estimateInteriorImageCount(kidsBook(pages))).toBe(pictures);
  });

  it("draws nothing for no pages", () => {
    expect(pictureBookIllustrationCap(0)).toBe(0);
  });

  it("never draws fewer pictures for a longer book", () => {
    // A picture a page to twelve, then one per two pages, drew 12 at twelve
    // pages and 7 at thirteen.
    for (let pages = 1; pages <= 600; pages++) {
      expect(pictureBookIllustrationCap(pages), `${pages} pages`).toBeGreaterThanOrEqual(pictureBookIllustrationCap(pages - 1));
    }
  });
});
