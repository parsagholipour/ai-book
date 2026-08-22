import { describe, expect, it } from "vitest";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import {
  FIRST_PAGE_ENDING_PRESSURE,
  LAST_PAGE_ENDING_PRESSURE,
  firstPageBriefFieldsForRange,
  pageEndingContract
} from "./pageBriefContract.js";

/**
 * The contract's own vocabulary, asserted without a model in the room. The five
 * producers that state it are covered where they live — the four in
 * pagesPageMap.test.ts, the critic in pageMapCritic.test.ts — and every one of
 * those asserts the sentence that reached a prompt. These pin the thing they all
 * read: which contract a page is written under, and the rules-plus-payload pair
 * that has to travel together.
 */

const input: CreateProjectInput = {
  prompt: "Jack The Martyr, a character-led story about sacrifice and consequence.",
  category: "STORY",
  targetPages: 12,
  complexity: 5,
  temperature: 0.8,
  language: "en",
  mediaSettings: {
    fullIllustrations: false,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral" as const
  }
};

const onePageInput: CreateProjectInput = { ...input, targetPages: 1 };

/**
 * The same book as an imported manuscript. `mediaSettings.mobile.import` is
 * written by the import route and carried through every plan version's input
 * snapshot, so it is the only thing separating these two books — and page 1 of
 * this one is the author's own first sentence.
 */
const importedInput: CreateProjectInput = {
  ...input,
  mediaSettings: {
    ...input.mediaSettings,
    mobile: { bookType: "custom", import: { importId: "imp_1", fileName: "chapel.docx", format: "docx" } }
  }
} as CreateProjectInput;

const openingHook = "Jack is already halfway over the chapel wall when the bell starts ringing for him.";

function scope(bookInput: CreateProjectInput, hook?: string): { input: CreateProjectInput; plan: BookPlan } {
  const plan: BookPlan = hook ? { ...makeFallbackPlan(bookInput), openingHook: hook } : makeFallbackPlan(bookInput);
  return { input: bookInput, plan };
}

describe("pageEndingContract", () => {
  it("ranks the book's ending above the book's opening on a one-page book", () => {
    // The collision the whole module exists to settle: `targetPages` may be 1,
    // so page 1 is the last page too and the two halves contradict each other.
    expect(pageEndingContract(1, 1)).toBe("ending");
  });

  it("reads page 1 of a longer book as the opening", () => {
    expect(pageEndingContract(1, 12)).toBe("opening");
  });

  it("reads the last page of a longer book as the ending", () => {
    expect(pageEndingContract(12, 12)).toBe("ending");
  });

  it("reads every page in between as a hand-off", () => {
    expect(pageEndingContract(2, 12)).toBe("handoff");
    expect(pageEndingContract(11, 12)).toBe("handoff");
  });
});

/**
 * Every case goes through the range form, because it is the module's only
 * entry point: the raw `(openingHook, lastPageIndex)` pair is module-private
 * now that no producer answers those questions for itself, and a producer that
 * could would be one whose provenance gate lives at its call site.
 */
describe("firstPageBriefFieldsForRange", () => {
  it("always states page 1's identity", () => {
    expect(firstPageBriefFieldsForRange(scope(input), 1, 12).rules[0]).toMatch(
      /Global page 1 is the book's first page/
    );
    expect(firstPageBriefFieldsForRange(scope(onePageInput, openingHook), 1, 1).rules[0]).toMatch(
      /Global page 1 is the book's first page/
    );
  });

  it("asks a multi-page book's page 1 to leave the second page something to answer", () => {
    const rules = firstPageBriefFieldsForRange(scope(input), 1, 12).rules.join(" ");

    expect(rules).toMatch(/endingPressure must leave a specific tension/);
    expect(rules).not.toContain(LAST_PAGE_ENDING_PRESSURE);
  });

  it("asks a one-page book's page 1 to close the book, quoting the last-page pressure verbatim", () => {
    const rules = firstPageBriefFieldsForRange(scope(onePageInput), 1, 1).rules.join(" ");

    expect(rules).toMatch(/also this book's last page/);
    expect(rules).toContain(LAST_PAGE_ENDING_PRESSURE);
    expect(rules).not.toMatch(/endingPressure must leave a specific tension/);
  });

  it("sends the openingHook key with the sentence that names it", () => {
    const fields = firstPageBriefFieldsForRange(scope(input, openingHook), 1, 12);

    expect(fields.rules.join(" ")).toMatch(/openingHook is the plan's commitment/);
    expect(fields.payload).toEqual({ openingHook });
  });

  it("states no hook rule and sends no hook key when the plan committed to none", () => {
    const fields = firstPageBriefFieldsForRange(scope(input), 1, 12);

    expect(fields.rules.join(" ")).not.toContain("openingHook");
    expect(Object.keys(fields.payload)).toEqual([]);
  });

  it("states nothing for a range that does not cover global page 1", () => {
    const fields = firstPageBriefFieldsForRange(scope(input, openingHook), 4, 9);

    expect(fields.rules).toEqual([]);
    expect(Object.keys(fields.payload)).toEqual([]);
  });

  it("states the contract for a chapter range that opens the book", () => {
    const fields = firstPageBriefFieldsForRange(scope(input, openingHook), 1, 4);

    expect(fields.rules.join(" ")).toMatch(/Global page 1 is the book's first page/);
    expect(fields.rules.join(" ")).toMatch(/endingPressure must leave a specific tension/);
    expect(fields.payload).toEqual({ openingHook });
  });

  it("states the contract for a one-page range that is global page 1", () => {
    // A repair asks the degenerate one-page form of the range question.
    const fields = firstPageBriefFieldsForRange(scope(input, openingHook), 1, 1);

    expect(fields.rules.join(" ")).toMatch(/endingPressure must leave a specific tension/);
    expect(fields.payload).toEqual({ openingHook });
  });

  it("assigns no hook on an imported manuscript, whatever its plan now says", () => {
    // The hole this closes. A fresh import has no `openingHook` at all; one
    // appears only when its plan is later revised, from a premise field, by a
    // model that never read page 1 — so page 1 here is the author's own first
    // sentence and the brief would be commissioning a rewrite of it. The writer
    // prompts are gated on the same fact, so the assignment would also arrive
    // with no `openingHook` key anywhere in the prompt that drafts the page.
    const fields = firstPageBriefFieldsForRange(scope(importedInput, openingHook), 1, 12);

    expect(fields.rules.join(" ")).not.toContain("openingHook");
    expect(fields.rules.join(" ")).not.toContain(openingHook);
    expect(Object.keys(fields.payload)).toEqual([]);
    // Only the hook half moves. The ban is a production rule for prose about to
    // be generated, so it still reaches an import's regenerated page 1.
    expect(fields.rules[0]).toMatch(/Global page 1 is the book's first page/);
    expect(fields.rules.join(" ")).toMatch(/endingPressure must leave a specific tension/);
  });

  it("takes the last page from the book, not from the range it was handed", () => {
    // The range says which call briefs page 1; `input.targetPages` says whether
    // page 1 is also the last page. A chapter range of 1..1 inside a twelve-page
    // book is not a one-page book.
    const chapterOfOne = firstPageBriefFieldsForRange(scope(input), 1, 1);
    const wholeOnePageBook = firstPageBriefFieldsForRange(scope(onePageInput), 1, 1);

    expect(chapterOfOne.rules.join(" ")).not.toContain(LAST_PAGE_ENDING_PRESSURE);
    expect(wholeOnePageBook.rules.join(" ")).toContain(LAST_PAGE_ENDING_PRESSURE);
  });
});

describe("the two ending pressures", () => {
  it("say opposite things about the same field", () => {
    expect(FIRST_PAGE_ENDING_PRESSURE).toMatch(/open question the second page must answer/);
    expect(LAST_PAGE_ENDING_PRESSURE).toMatch(/Resolve the book's central promise/);
    expect(FIRST_PAGE_ENDING_PRESSURE).not.toBe(LAST_PAGE_ENDING_PRESSURE);
  });
});
