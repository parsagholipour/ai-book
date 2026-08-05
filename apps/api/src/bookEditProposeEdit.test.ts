import { describe, expect, it } from "vitest";
import { intentFromDecideAction, intentFromProposeEdit } from "./bookEditIntent.js";
import { classifyWithDegradedHeuristics } from "./bookEditHeuristics.js";

/**
 * The router's `propose_edit` decision mapped onto a priced intent kind, and the
 * model-free fallback that has to reach the same answer when the router is
 * unavailable. Split from bookEditIntent.test.ts, which covers the classifier
 * itself and its clarification budget.
 */

const pages = [
  {
    id: "page-1",
    index: 1,
    title: "Opening",
    summary: "Rabbit brags before the race.",
    previewText: "Rabbit hops to the starting line while Turtle smiles."
  },
  {
    id: "page-2",
    index: 2,
    title: "Practice",
    summary: "Turtle keeps moving.",
    previewText: "The old phrase appears in the practice scene."
  }
];

const chapters = [
  { index: 1, title: "The Race Begins", pageIndexes: [1] },
  { index: 2, title: "Steady Wins", pageIndexes: [2] }
];

describe("propose_edit pricing mapping", () => {
  it("maps exact page replacements to local_patch", () => {
    const intent = intentFromProposeEdit(
      {
        action: "propose_edit",
        confidence: 0.9,
        reasoning: "Exact replacement.",
        assistantMessage: "I’ll replace that phrase on page 1.",
        clarification: "none",
        editTarget: "pages",
        editStyle: "exact_replace",
        pageIndexes: [1],
        chapterIndex: null,
        targetLanguage: null
      },
      'On page 1, replace "old" with "new".',
      chapters
    );

    expect(intent.kind).toBe("local_patch");
    expect(intent.scope).toBe("explicit_pages");
    expect(intent.impact).toBe("small_text");
  });

  it("maps whole-book rewrites to page_rewrite", () => {
    const intent = intentFromProposeEdit(
      {
        action: "propose_edit",
        confidence: 0.9,
        reasoning: "Whole-book style.",
        assistantMessage: "I’ll rewrite the whole book warmer.",
        clarification: "none",
        editTarget: "whole_book",
        editStyle: "rewrite",
        pageIndexes: [],
        chapterIndex: null,
        targetLanguage: null
      },
      "Make the whole book warmer.",
      chapters
    );

    expect(intent.kind).toBe("page_rewrite");
    expect(intent.scope).toBe("all_pages");
  });

  it("maps chapter targets to chapter_regenerate", () => {
    const intent = intentFromProposeEdit(
      {
        action: "propose_edit",
        confidence: 0.9,
        reasoning: "Chapter rewrite.",
        assistantMessage: "I’ll rewrite chapter 2.",
        clarification: "none",
        editTarget: "chapter",
        editStyle: "rewrite",
        pageIndexes: [],
        chapterIndex: 2,
        targetLanguage: null
      },
      "Rewrite chapter 2.",
      chapters
    );

    expect(intent.kind).toBe("chapter_regenerate");
    expect(intent.affectedChapterIndex).toBe(2);
    expect(intent.affectedPageIndexes).toEqual([2]);
  });

  it("maps structural and language_copy targets to book_replan", () => {
    const structural = intentFromDecideAction(
      {
        action: "propose_edit",
        confidence: 0.9,
        reasoning: "Identity change.",
        assistantMessage: "I’ll rebuild around a new protagonist.",
        clarification: "none",
        editTarget: "structural",
        editStyle: "rewrite",
        pageIndexes: [],
        chapterIndex: null,
        targetLanguage: null
      },
      "Change the main character.",
      chapters
    );
    expect(structural.kind).toBe("book_replan");

    const language = intentFromDecideAction(
      {
        action: "propose_edit",
        confidence: 0.9,
        reasoning: "Language copy.",
        assistantMessage: "I’ll create an English copy.",
        clarification: "none",
        editTarget: "language_copy",
        editStyle: "rewrite",
        pageIndexes: [],
        chapterIndex: null,
        targetLanguage: "en"
      },
      "Generate the English version",
      chapters
    );
    expect(language.kind).toBe("book_replan");
    expect(language.targetLanguage).toBe("en");
  });

  it("carries the length and image settings a structural request named", () => {
    const intent = intentFromDecideAction(
      {
        action: "propose_edit",
        confidence: 0.8,
        reasoning: "The user wants a shorter book with no pictures.",
        assistantMessage: "I’ll condense the book into 3 pages without illustrations.",
        clarification: "none",
        editTarget: "structural",
        editStyle: "rewrite",
        pageIndexes: [],
        chapterIndex: null,
        targetLanguage: null
      },
      "It's too much talking. I think we should make it 3 pages without illustrations",
      chapters
    );
    // Without these the replan is quoted and planned as the book it replaces:
    // the model wrote three chapters and they were padded back to eight pages.
    expect(intent.replanSettings).toEqual({ fullIllustrations: false, targetPages: 3 });
  });

  it("prefers the router's numbers over the message when it reports them", () => {
    const intent = intentFromDecideAction(
      {
        action: "propose_edit",
        confidence: 0.8,
        reasoning: "Half as long.",
        assistantMessage: "I’ll halve it.",
        clarification: "none",
        editTarget: "structural",
        editStyle: "rewrite",
        newTargetPages: 6,
        illustrationsEnabled: true,
        pageIndexes: [],
        chapterIndex: null,
        targetLanguage: null
      },
      "make it half as long",
      chapters
    );
    expect(intent.replanSettings).toEqual({ fullIllustrations: true, targetPages: 6 });
  });

  it("reads no length from a request that names pages to edit", () => {
    const intent = intentFromDecideAction(
      {
        action: "propose_edit",
        confidence: 0.8,
        reasoning: "Rewrite two pages.",
        assistantMessage: "I’ll rewrite those pages.",
        clarification: "none",
        editTarget: "structural",
        editStyle: "rewrite",
        pageIndexes: [],
        chapterIndex: null,
        targetLanguage: null
      },
      "rewrite pages 3-5 around a new protagonist",
      chapters
    );
    // "pages 3" is a reference, not a length; reading it as one would shrink
    // the whole book to the page someone wanted changed.
    expect(intent.replanSettings).toBeUndefined();
  });

  it("classifies a length or image change as a replan without a router", () => {
    const intent = classifyWithDegradedHeuristics(
      "It's too much talking. I think we should make it 3 pages without illustrations",
      "complete",
      pages,
      undefined,
      chapters
    );
    // No verb in the structural regex matches this, but only a replan can change
    // how many pages a book has.
    expect(intent.kind).toBe("book_replan");
    expect(intent.replanSettings).toEqual({ fullIllustrations: false, targetPages: 3 });
  });
});
