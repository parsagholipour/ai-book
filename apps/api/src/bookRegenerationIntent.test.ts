import { describe, expect, it } from "vitest";
import { classifyProjectChatMessage } from "./bookEditIntent.js";
import { fakeDecideModel, pages } from "./testing/bookEditIntentFixtures.js";
import { bookRegenerationIntent } from "./bookRegenerationIntent.js";

describe("completed-book regeneration requests", () => {
  it.each(["Regenerate", "Regenerate again", "Please generate again!", "Regenerate the whole book", "Rebuild this book please"])("recognizes %s", (message) => {
    expect(bookRegenerationIntent(message)?.kind).toBe("book_replan");
  });

  it.each([
    "Can you generate again?", "Don't generate again", "Generate page 2 again",
    "Regenerate the cover", "Regenerate the book in French", "Regenerate the book without images"
  ])("leaves %s to contextual routing", (message) => {
    expect(bookRegenerationIntent(message)).toBeNull();
  });

  it("keeps contextual fragments with the router and explicit whole-book requests scoped to the book", () => {
    expect(bookRegenerationIntent("Generate again", true)).toBeNull();
    expect(bookRegenerationIntent("Regenerate the whole book", true)?.kind).toBe("book_replan");
  });

  it("does not propose full-book regeneration during plan review", async () => {
    const intent = await classifyProjectChatMessage({ message: "Generate again", stage: "plan_ready", pages: [] });
    expect(intent.kind).not.toBe("book_replan");
  });

  it.each(["available", "unavailable"])("proposes Generate again with the router %s", async (availability) => {
    const textModel = fakeDecideModel({
      action: "answer",
      confidence: 0.85,
      reasoning: "Generate again is ambiguous and does not identify a specific change.",
      assistantMessage: "I'm not sure what you'd like me to regenerate.",
      clarification: "none",
      pageIndexes: [],
      chapterIndex: null,
      targetLanguage: null
    });
    const intent = await classifyProjectChatMessage({
      message: "Generate again",
      stage: "complete",
      pages,
      ...(availability === "available" ? { textModel } : {})
    });

    expect(intent.kind).toBe("book_replan");
    expect(intent.scope).toBe("all_pages");
    expect(intent.editInstruction).toMatch(/regenerate/i);
  });
});
