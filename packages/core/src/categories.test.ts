import { describe, expect, it } from "vitest";
import {
  BOOK_CATEGORIES,
  isBookCategory,
  isDiagramFriendlyBookCategory,
  isSignpostingBookCategory,
  isSourceForwardBookCategory
} from "./categories.js";

/**
 * Every per-category behavior set is pinned by its whole membership rather
 * than by one member: a set of names is exactly the kind of table where a typo
 * or a renamed enum value silently drops a category out, and the symptom of
 * that is a quiet policy change nobody is looking for — a page held to a rule
 * its category was exempt from, a book that stops printing its Sources.
 */
describe("book category behavior sets", () => {
  it("exempts exactly the practical categories from the chapter-scaffold gate", () => {
    expect(BOOK_CATEGORIES.filter((category) => isSignpostingBookCategory(category))).toEqual([
      "EDUCATION",
      "BUSINESS",
      "SELF_HELP",
      "HEALTH"
    ]);
  });

  it("keeps the narrative and scholarly categories gated", () => {
    for (const category of ["KIDS", "STORY", "SCIENCE", "BIOGRAPHY", "HISTORY", "SOCIETY", "ARTS", "CUSTOM"]) {
      expect(isSignpostingBookCategory(category), category).toBe(false);
    }
  });

  it("answers false for a missing category and for anything that is not one", () => {
    expect(isSignpostingBookCategory(undefined)).toBe(false);
    expect(isSignpostingBookCategory("")).toBe(false);
    // The shapes a stringly-typed set used to accept as a near-miss.
    expect(isSignpostingBookCategory("SELFHELP")).toBe(false);
    expect(isSignpostingBookCategory("education")).toBe(false);
    expect(isBookCategory("SELFHELP")).toBe(false);
  });

  it("pins the source-forward and diagram-friendly memberships too", () => {
    expect(BOOK_CATEGORIES.filter((category) => isSourceForwardBookCategory(category))).toEqual([
      "SCIENCE",
      "HEALTH",
      "BIOGRAPHY",
      "HISTORY"
    ]);
    expect(BOOK_CATEGORIES.filter((category) => isDiagramFriendlyBookCategory(category))).toEqual([
      "SCIENCE",
      "EDUCATION",
      "HEALTH"
    ]);
    expect(isSourceForwardBookCategory(undefined)).toBe(false);
    expect(isDiagramFriendlyBookCategory(undefined)).toBe(false);
  });
});
