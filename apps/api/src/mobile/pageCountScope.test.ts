import { describe, expect, it } from "vitest";
import { mobileCreationDraftPayloadSchema } from "../mobileCreationSchemas.js";
import { requestedPageCountScope } from "./pageCountScope.js";

function scopeFor(...requests: string[]) {
  return requestedPageCountScope(mobileCreationDraftPayloadSchema.parse({
    messages: requests.map((content) => ({ role: "user", content }))
  }));
}

describe("page-count scope fallback", () => {
  it("does not manufacture a depth request from a topic", () => {
    expect(scopeFor("A pricing guide for consultants")).toBeNull();
  });

  it.each(["Add more detail", "Make it more detailed", "I want more details", "Explain it step by step"])("recognizes %s", (request) => {
    expect(scopeFor(request)?.depth).toBe("balanced");
  });

  it.each(["Add examples", "Include case studies", "Show worked solutions"])("reserves space for %s", (request) => {
    expect(scopeFor(request)?.depth).toBe("balanced");
  });

  it("combines detail and examples across user turns", () => {
    expect(scopeFor("Explain it step by step", "Include worked examples")?.depth).toBe("expanded");
  });

  it("honors a later request to keep the book short", () => {
    expect(scopeFor("More detail and examples", "Actually, keep it concise")?.depth).toBe("concise");
    expect(scopeFor("Keep it concise", "Actually, add more detail and examples")?.depth).toBe("expanded");
  });

  it("does not mistake the short-story genre for a request to reduce depth", () => {
    expect(scopeFor("I want a short story with detailed scenes and examples")?.depth).toBe("expanded");
  });

  it("does not interpret negated requests as a demand for more pages", () => {
    expect(scopeFor("Don't add more detail", "No examples", "Avoid a comprehensive treatment")).toBeNull();
  });

  it("ignores assistant suggestions, skipped questions, and inactive branches", () => {
    const payload = mobileCreationDraftPayloadSchema.parse({
      // rawIdea can predate a branch change; the active tree is authoritative.
      rawIdea: "Make it comprehensive and detailed with lots of examples",
      messages: [
        { id: "root", parentId: null, role: "user", content: "A pricing guide" },
        { id: "offer", parentId: "root", role: "assistant", content: "Should I add more detail and examples?" },
        { id: "old", parentId: "offer", isActiveChild: false, role: "user", content: "Yes, add more detail and examples" },
        { id: "active", parentId: "offer", isActiveChild: true, role: "user", skippedQuestion: true, content: "Add more detail" }
      ]
    });
    expect(requestedPageCountScope(payload)).toBeNull();
  });

  it("reads initial ideas and explicit structured requirements when there is no chat", () => {
    expect(requestedPageCountScope(mobileCreationDraftPayloadSchema.parse({
      rawIdea: "A detailed guide with worked examples"
    }))?.depth).toBe("expanded");
    expect(requestedPageCountScope(mobileCreationDraftPayloadSchema.parse({
      optionalDetails: { mustInclude: "Detailed explanations and examples" }
    }))?.depth).toBe("expanded");
  });
});
