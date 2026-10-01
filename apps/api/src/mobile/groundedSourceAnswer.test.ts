import { describe, expect, it, vi } from "vitest";
import { FakeTextModelAdapter, type SourceService } from "@book-maker/core";
import { CHAT_REPLY_MARKDOWN_PROMPT } from "../chatReplyMarkdownPrompt.js";
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
    const messages = JSON.stringify(generate.mock.calls[0]![0].messages);
    expect(messages).toContain(passage.content);
    expect(messages).toContain(CHAT_REPLY_MARKDOWN_PROMPT);
  });
});

describe("grounded book answers", () => {
  const page = (index: number, title: string, summary: string) =>
    ({ index, title, summary, chapter: { index: index < 5 ? 1 : 2 } }) as never;
  const project = (pages: never[]): Parameters<typeof generateGroundedProjectAnswer>[0] => ({
    id: "book", userId: "owner", title: "Balcony Garden", prompt: "A balcony guide", category: "CUSTOM",
    targetPages: 3, complexity: 2, temperature: 0.3, language: "en", mediaSettings: {}, status: "COMPLETE",
    contentRevision: 0, exportInvalidationRevision: null, pdfPageMap: null, storyState: null,
    templateId: null, currentPlanId: null, subcategory: null, subtitle: null, authorName: null, coverTagline: null,
    createdAt: new Date(0), updatedAt: new Date(0), pages, research: [], currentPlan: null,
    chapters: [
      { id: "c1", index: 1, title: "Set Up the Balcony", summary: "" },
      { id: "c2", index: 2, title: "Pick Easy Crops", summary: "" }
    ]
  });

  it("keeps the reply's line breaks, which are its markdown", async () => {
    const reply = "The book starts beginners on:\n\n- **Lettuce**\n- **Radishes**\n\nBoth suit a first try.";
    const model = new FakeTextModelAdapter();
    vi.spyOn(model, "generateText").mockResolvedValue({ text: `${reply}  \n`, model: "fake-model", provider: "fake" });
    const answer = await generateGroundedProjectAnswer(project([]), "Which vegetables?", "Unavailable", model, undefined, []);
    expect(answer).toBe(reply);
  });

  it("shows every page's title and summary and the router's draft, by printed page", async () => {
    const model = new FakeTextModelAdapter();
    const generate = vi.spyOn(model, "generateText");
    await generateGroundedProjectAnswer(
      project([
        page(1, "Map Your Balcony", "Check sun and wind for the beginner."),
        page(2, "Pots for the beginner", "Choose containers with drainage for a beginner."),
        page(3, "Mix for the beginner", "Use an airy mix as a beginner."),
        page(4, "Water for the beginner", "Check moisture as a beginner."),
        page(5, "Choose Crops for a First Planting", "Greens, radishes and herbs suit a first planting.")
      ]),
      "Which vegetables suit a beginner?",
      "The crops chapter points to greens.",
      model,
      undefined,
      []
    );
    const payload = JSON.parse(generate.mock.calls[0]![0].messages.at(-1)!.content as string);
    expect(payload.pages.map((entry: { title: string }) => entry.title)).not.toContain("Choose Crops for a First Planting");
    expect(payload.bookOutline.map((entry: { title: string }) => entry.title)).toContain("Choose Crops for a First Planting");
    expect(payload.bookOutline.at(-1).readerPages).toBe("5");
    // Page titles are never printed; the chapter heading is what a reader can find.
    expect(payload.bookOutline.at(-1).chapter).toBe("Pick Easy Crops");
    expect(generate.mock.calls[0]![0].messages[0]!.content).toContain("never cite it");
    expect(payload.draftAnswer).toBe("The crops chapter points to greens.");
    expect(JSON.stringify(payload.pages)).not.toContain('"index"');
  });
});
