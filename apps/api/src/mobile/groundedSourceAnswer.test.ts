import { describe, expect, it, vi } from "vitest";
import { FakeTextModelAdapter, type SourceService } from "@book-maker/core";
import { generateGroundedProjectAnswer } from "./groundedAnswer.js";

vi.mock("@book-maker/db", () => ({ prisma: { bookEditOperation: { findMany: async () => [] } } }));
vi.mock("./projectChat.js", () => ({ loadChatPageBodies: async () => new Map(), loadActiveProjectChatMessages: async () => [] }));

describe("source-grounded book answers", () => {
  it("retrieves evidence before a direct answer so an existing book citation is verified for this turn", async () => {
    const citation = "[source:archive:1:0]";
    const passage = { sourceId: "archive", version: 1, ordinal: 0, name: "Archive", locator: "Final entry", content: "The archive code is CYAN-482." };
    const search = vi.fn(async () => [passage]);
    const service: SourceService = { search, overview: async () => [], read: async () => passage };
    const model = new FakeTextModelAdapter(undefined, [{ text: `The code is CYAN-482. ${citation}` }]);
    const generate = vi.spyOn(model, "generateWithTools");
    const project: Parameters<typeof generateGroundedProjectAnswer>[0] = {
      id: "book", userId: "owner", title: "Archive", prompt: "An archive story", category: "STORY",
      targetPages: 3, complexity: 2, temperature: 0.3, language: "en", mediaSettings: {}, status: "COMPLETE",
      contentRevision: 0, exportInvalidationRevision: null, pdfPageMap: null, storyState: null,
      templateId: null, currentPlanId: null, subcategory: null, subtitle: null, authorName: null, coverTagline: null,
      createdAt: new Date(0), updatedAt: new Date(0), pages: [], chapters: [], research: [], currentPlan: null
    };
    const answer = await generateGroundedProjectAnswer(project, "What is the archive code?", "Unavailable", model, undefined, [], service);
    expect(search).toHaveBeenCalledWith("What is the archive code?", undefined);
    expect(answer).toBe(`The code is CYAN-482. ${citation}`);
    expect(JSON.stringify(generate.mock.calls[0]![0].messages)).toContain(passage.content);
  });
});
