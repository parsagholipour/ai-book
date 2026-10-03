import { describe, expect, it } from "vitest";
import { bookTitleFromMessage, sanitizeBookTitle } from "./bookEditBookTitle.js";
import { intentFromDecideAction } from "./bookEditDecision.js";
import { classifyWithDegradedHeuristics } from "./bookEditHeuristics.js";
import { classifyProjectChatMessage } from "./bookEditIntent.js";
import type { DecideActionPayload } from "./bookEditRouterPrompt.js";
import { coverKindFromMetadata } from "./mobile/bookTitleEdits.js";

/**
 * "Change the book title to Dinner Made Simple" was quoted as a 550-credit
 * whole-book rebuild (2026-10-02). The title is printed from the book's
 * details, so a title the reader spelled out is read without a model.
 */
describe("reading a new book title out of a message", () => {
  it.each([
    ["change the book title to Dinner Made Simple", "Dinner Made Simple"],
    ["Change the title to “Dinner, Done.”", "Dinner, Done."],
    ["can you change the title of the book to Weeknight Wins please", "Weeknight Wins"],
    ["rename the book to The One-Hour Plan", "The One-Hour Plan"],
    ["retitle my book Supper Club", "Supper Club"],
    ["call the book 'Five Dinners, One Hour'", "Five Dinners, One Hour"],
    ["The new title should be: Table for Four", "Table for Four"],
    ["new title: Dinner Week", "Dinner Week"],
    ["set the book's title to Why Not Pasta?", "Why Not Pasta?"],
    ["Can you change the title to Supper Club?", "Supper Club"]
  ])("reads %s", (message, title) => {
    expect(bookTitleFromMessage(message)).toBe(title);
  });

  it.each([
    "what is the title of the book?",
    "change the title to something catchier",
    "make the title shorter",
    "change the title of chapter 3 to The Market",
    "change the chapter title to The Market",
    "change the title to Supper Club and make page 3 funnier",
    "change the title to \"Supper Club\" and rewrite page 3",
    "rename the main character to Sam"
  ])("leaves %s to the router", (message) => {
    expect(bookTitleFromMessage(message)).toBeNull();
  });

  it("refuses a title with nothing printable in it, or a paragraph", () => {
    expect(sanitizeBookTitle("  “ ” ")).toBeUndefined();
    expect(sanitizeBookTitle("x".repeat(161))).toBeUndefined();
    expect(sanitizeBookTitle("  Dinner   Made Simple. ")).toBe("Dinner Made Simple");
  });

  it("answers a finished book without a model, and never as a replan", async () => {
    const intent = await classifyProjectChatMessage({
      message: "change the book title to Dinner Made Simple",
      stage: "complete",
      pages: []
    });
    expect(intent).toMatchObject({ kind: "book_title", bookTitle: "Dinner Made Simple" });
  });
});

describe("a title the router routed", () => {
  const decide = (bookTitle: string | null) =>
    intentFromDecideAction(
      {
        action: "propose_edit",
        confidence: 0.9,
        reasoning: "A new title.",
        assistantMessage: "",
        editInstruction: "Retitle the book.",
        editTarget: "book_title",
        bookTitle
      } as unknown as DecideActionPayload,
      "make the title catchier"
    );

  it("carries the title the router wrote", () => {
    expect(decide("Dinner, Sorted")).toMatchObject({ kind: "book_title", bookTitle: "Dinner, Sorted" });
  });

  it("asks for the title when the router named none", () => {
    expect(decide(null)).toMatchObject({ kind: "clarify", assistantMessage: "What should the new title be?" });
  });
});

describe("a title change with no model to route it", () => {
  it("asks for the title rather than quoting a rebuild", () => {
    for (const message of ["make the title catchier", "change the book's title, it's too long"]) {
      expect(classifyWithDegradedHeuristics(message, "complete", []), message).toMatchObject({
        kind: "clarify",
        assistantMessage: "What should the new title be?"
      });
    }
    // A chapter's title is a page edit, and the rebuild rules still see an ending.
    expect(classifyWithDegradedHeuristics("change the chapter title on page 3", "complete", []).assistantMessage).not.toBe(
      "What should the new title be?"
    );
    expect(classifyWithDegradedHeuristics("change the ending", "complete", []).kind).toBe("book_replan");
  });
});

describe("what a cover is, for the price of a title change", () => {
  it("prices only a picture a model drew", () => {
    expect(coverKindFromMetadata(undefined)).toBe("none");
    expect(coverKindFromMetadata({ coverArtSource: "design", coverDesignId: "night-sky" })).toBe("design");
    expect(coverKindFromMetadata({ coverDesignId: "night-sky" })).toBe("design");
    expect(coverKindFromMetadata({ source: "upload" })).toBe("upload");
    expect(coverKindFromMetadata({ coverArtSource: "ai", model: "imagen" })).toBe("ai");
    // A cover from before the source was recorded was drawn by an image model;
    // read as a design it would be replaced by a fresh pick, for free.
    expect(coverKindFromMetadata({ model: "gpt-image-1", revisedPrompt: "A lighthouse" })).toBe("ai");
  });
});
