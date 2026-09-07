import { describe, expect, it } from "vitest";
import {
  CLASSIFIER_PAGE_SAMPLE_CAP,
  classifierPageSample,
  classifyProjectChatMessage,
  classifyWithHeuristics,
  intentFromDecideAction,
  intentFromProposeEdit,
  continuationRequestFromMessage,
  isBookEditScopeOnlyMessage,
  messageWithScope
} from "./bookEditIntent.js";
import { chapters, manyPages, pages } from "./testing/bookEditIntentFixtures.js";

describe("book edit intent heuristics", () => {
  it("treats generated-book questions as answers", () => {
    const intent = classifyWithHeuristics("How many pages are in the book?", "complete", pages);

    expect(intent.kind).toBe("answer");
    expect(intent.confidence).toBeGreaterThanOrEqual(0.72);
  });

  it("answers plan-stage questions without generated-book edit fallback copy", () => {
    const intent = classifyWithHeuristics("What is this plan about?", "plan_ready", pages);

    expect(intent.kind).toBe("answer");
    expect(intent.assistantMessage).not.toMatch(/book text edits are available after/i);
    expect(intent.assistantMessage).toMatch(/plan/i);
  });

  it("keeps dislike-flavored questions as answers", () => {
    const intent = classifyWithHeuristics("Why is there a public display in chapter 2?", "complete", pages);

    expect(intent.kind).toBe("answer");
  });

  it("does not invent charged edit kinds from English regex trees", () => {
    for (const message of [
      "Make the examples warmer and more practical.",
      "I don't like the dragon battles.",
      "I don't like the main character.",
      "On page 1, replace \"old phrase\" with \"new phrase\".",
      "Add a new chapter about launch strategy.",
      "Now generate the English version",
      "Replace rabbit with fly throughout the whole book.",
      "Make the whole book warmer and simpler.",
      "Rewrite chapter 2 and make it funnier.",
      "I don't want images or covers",
      "Move the ending earlier in the outline."
    ]) {
      const intent = classifyWithHeuristics(message, "complete", pages, undefined, chapters);
      expect(["clarify", "answer", "show_content", "undo_last_edit", "redo_last_edit"]).toContain(intent.kind);
      expect(intent.kind).not.toBe("local_patch");
      expect(intent.kind).not.toBe("page_rewrite");
      expect(intent.kind).not.toBe("book_replan");
      expect(intent.kind).not.toBe("chapter_regenerate");
      expect(intent.kind).not.toBe("plan_revision");
    }
  });

  it("routes read requests to show_content with the right target", () => {
    const outline = classifyWithHeuristics("Show me the outline", "complete", pages, undefined, chapters);
    expect(outline.kind).toBe("show_content");
    expect(outline.contentTarget).toEqual({ type: "outline" });

    const chapter = classifyWithHeuristics("Read chapter 2", "complete", pages, undefined, chapters);
    expect(chapter.kind).toBe("show_content");
    expect(chapter.contentTarget).toEqual({ type: "chapter", index: 2 });

    const page = classifyWithHeuristics("Show me page 1", "complete", pages, undefined, chapters);
    expect(page.kind).toBe("show_content");
    expect(page.contentTarget).toEqual({ type: "page", index: 1 });
    expect(page.affectedPageIndexes).toEqual([1]);
  });

  it("does not treat edit requests that mention chapters as read requests", () => {
    const intent = classifyWithHeuristics("Rewrite chapter 2 and make it funnier.", "complete", pages, undefined, chapters);

    expect(intent.kind).toBe("clarify");
    expect(intent.kind).not.toBe("show_content");
  });

  it("routes undo requests to undo_last_edit", () => {
    for (const message of ["Undo that last change", "Please revert the last edit", "Roll back that edit"]) {
      const intent = classifyWithHeuristics(message, "complete", pages, undefined, chapters);

      expect(intent.kind).toBe("undo_last_edit");
      expect(intent.confidence).toBeGreaterThanOrEqual(0.72);
    }
  });

  it("routes redo requests to redo_last_edit", () => {
    for (const message of ["Redo", "Please redo the last edit", "Reapply that change"]) {
      const intent = classifyWithHeuristics(message, "complete", pages, undefined, chapters);

      expect(intent.kind).toBe("redo_last_edit");
      expect(intent.confidence).toBeGreaterThanOrEqual(0.72);
    }
  });

  it("does not treat regenerating a chapter as redo_last_edit", () => {
    const intent = classifyWithHeuristics("Redo chapter 3", "complete", pages, undefined, chapters);

    expect(intent.kind).not.toBe("redo_last_edit");
  });

  it("does not treat regenerating the plan, outline, or ending as redo_last_edit", () => {
    for (const message of ["Redo the plan", "Redo the outline", "Redo the ending"]) {
      const intent = classifyWithHeuristics(message, "complete", pages, undefined, chapters);

      expect(intent.kind).not.toBe("redo_last_edit");
    }
  });

  it("maps the router redo_last_edit action", () => {
    const intent = intentFromDecideAction(
      {
        action: "redo_last_edit",
        confidence: 0.94,
        reasoning: "They asked to put the last undone edit back.",
        assistantMessage: "I’ll put that edit back.",
        editInstruction: "",
        clarification: "none",
        pageIndexes: [],
        chapterIndex: null,
        targetLanguage: null
      },
      "Redo"
    );

    expect(intent.kind).toBe("redo_last_edit");
    expect(intent.affectedPageIndexes).toEqual([]);
  });

  it("passes small books to the classifier prompt without sampling", () => {
    const sample = classifierPageSample(pages, "Fix the typo on page 2.");

    expect(sample.truncated).toBe(false);
    expect(sample.pages).toEqual(pages);
  });

  it("samples large books under the cap while keeping explicitly mentioned pages", () => {
    const bigBook = manyPages(600);

    const sample = classifierPageSample(bigBook, "Fix a typo on page 412.");

    expect(sample.truncated).toBe(true);
    expect(sample.pages.length).toBeLessThanOrEqual(CLASSIFIER_PAGE_SAMPLE_CAP);
    const indexes = sample.pages.map((page) => page.index);
    expect(indexes).toContain(412);
    expect(indexes).toContain(411);
    expect(indexes).toContain(413);
    expect(indexes).toContain(1);
    expect(indexes).toContain(600);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });

  it("recognizes a scope-only follow-up that can resolve a pending edit", () => {
    expect(isBookEditScopeOnlyMessage("whole book")).toBe(true);
    expect(isBookEditScopeOnlyMessage("I said whole book")).toBe(true);
    expect(messageWithScope("Replace rabbit with fly", "all_pages")).toMatch(/whole book/i);
  });
});

describe("continuation intent", () => {
  it("detects continuation requests and chapter counts from messages", () => {
    expect(continuationRequestFromMessage("Continue the story")).toEqual({ chapterCount: 1 });
    expect(continuationRequestFromMessage("keep writing my book")).toEqual({ chapterCount: 1 });
    expect(continuationRequestFromMessage("Write the next chapter")).toEqual({ chapterCount: 1 });
    expect(continuationRequestFromMessage("add 3 more chapters")).toEqual({ chapterCount: 3 });
    expect(continuationRequestFromMessage("please write two new chapters")).toEqual({ chapterCount: 2 });
    expect(continuationRequestFromMessage("finish the book")).toEqual({ chapterCount: 1 });
  });

  it("ignores questions and unrelated messages", () => {
    expect(continuationRequestFromMessage("Should I continue the story?")).toBeNull();
    expect(continuationRequestFromMessage("Fix the typo on page 2")).toBeNull();
    expect(continuationRequestFromMessage("What happens in chapter 3?")).toBeNull();
  });

  it("routes continuation to continue_book without a model on completed books", async () => {
    const intent = await classifyProjectChatMessage({
      message: "Continue the story and add 2 more chapters",
      stage: "complete",
      pages
    });
    expect(intent.kind).toBe("continue_book");
    expect(intent.continuation).toEqual({ chapterCount: 2 });
    expect(intent.affectedPageIndexes).toEqual([]);
  });

  it("never proposes continuation while the plan is still under review", async () => {
    const intent = await classifyProjectChatMessage({
      message: "Continue the story",
      stage: "plan_ready",
      pages
    });
    expect(intent.kind).not.toBe("continue_book");
  });

  it("maps the continuation propose_edit target to continue_book", () => {
    const intent = intentFromProposeEdit(
      {
        action: "propose_edit",
        confidence: 0.9,
        reasoning: "Continuation.",
        assistantMessage: "I’ll write the next chapters.",
        clarification: "none",
        editTarget: "continuation",
        editStyle: "rewrite",
        pageIndexes: [],
        chapterIndex: null,
        targetLanguage: null,
        newChapterCount: 4
      },
      "Keep writing the book",
      chapters
    );
    expect(intent.kind).toBe("continue_book");
    expect(intent.continuation).toEqual({ chapterCount: 4 });
    expect(intent.affectedPageIndexes).toEqual([]);
    expect(intent.clarification).toBe("none");
  });

  it("recovers the chapter count from the message when the router omits it", () => {
    const intent = intentFromProposeEdit(
      {
        action: "propose_edit",
        confidence: 0.9,
        reasoning: "Continuation.",
        assistantMessage: "I’ll write the next chapters.",
        clarification: "none",
        editTarget: "continuation",
        editStyle: "rewrite",
        pageIndexes: [],
        chapterIndex: null,
        targetLanguage: null
      },
      "add 3 more chapters",
      chapters
    );
    expect(intent.continuation).toEqual({ chapterCount: 3 });
  });
});

describe("code-scoped edits without a router model", () => {
  const codePages = [
    { id: "p1", index: 1, title: "Why it matters", summary: "The small test hides the cost.", previewText: "", codeBlocks: 0 },
    { id: "p2", index: 2, title: "Lookup", summary: "A lookup routine.", previewText: "", codeBlocks: 1 },
    { id: "p3", index: 3, title: "Structures", summary: "Queues and stacks.", previewText: "", codeBlocks: 0 },
    { id: "p4", index: 4, title: "Halving", summary: "Binary search.", previewText: "", codeBlocks: 2 }
  ];

  it("scopes a code conversion to the pages that carry code", async () => {
    const intent = await classifyProjectChatMessage({
      message: "Use JavaScript in the codes",
      stage: "complete",
      pages: codePages,
      chapters
    });

    expect(intent.kind).toBe("page_rewrite");
    expect(intent.scope).toBe("explicit_pages");
    expect(intent.affectedPageIndexes).toEqual([2, 4]);
  });

  it("keeps a question about the code an answer, and a request to add code off the code pages", async () => {
    const question = await classifyProjectChatMessage({
      message: "Which language do the codes use, JavaScript?",
      stage: "complete",
      pages: codePages,
      chapters
    });
    expect(question.kind).toBe("answer");

    const addition = await classifyProjectChatMessage({
      message: "Add a JavaScript code example to every page",
      stage: "complete",
      pages: codePages,
      chapters
    });
    expect(addition.affectedPageIndexes).not.toEqual([2, 4]);
  });

  it("does not guess pages when nothing is known about their content", async () => {
    const intent = await classifyProjectChatMessage({
      message: "Use JavaScript in the codes",
      stage: "complete",
      pages,
      chapters
    });

    expect(intent.kind).not.toBe("answer");
    expect(intent.affectedPageIndexes).toEqual([]);
  });
});

