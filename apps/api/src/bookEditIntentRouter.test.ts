import { describe, expect, it, vi } from "vitest";
import type { ToolCallsResult } from "@book-maker/core";
import { CLASSIFIER_PAGE_SAMPLE_CAP, classifyProjectChatMessage } from "./bookEditIntent.js";
import { bookPageMapForProject, readerPageNumbering } from "./bookPageNumbering.js";
import {
  chapters,
  decideDecision,
  fakeDecideModel,
  fakeFailingTextModel,
  fakeFlakyDecideModel,
  fakeHangingTextModel,
  manyPages,
  pages,
  scriptedTextModel
} from "./testing/bookEditIntentFixtures.js";

describe("book edit intent AI router", () => {
  it("short-circuits read/undo intents without calling the AI router", async () => {
    const model = fakeDecideModel({
      action: "answer",
      confidence: 0.9,
      reasoning: "Should never be used.",
      assistantMessage: "Model reply",
      clarification: "none",
      pageIndexes: [],
      chapterIndex: null,
      targetLanguage: null
    });

    const intent = await classifyProjectChatMessage({
      message: "Show me the outline",
      stage: "complete",
      pages,
      chapters,
      textModel: model
    });

    expect(model.generateWithTools).not.toHaveBeenCalled();
    expect(intent.kind).toBe("show_content");
  });

  it("keeps a sources-removal request off the priced page-edit path", async () => {
    const model = fakeDecideModel({
      action: "propose_edit",
      confidence: 0.95,
      reasoning: "Should never be used.",
      assistantMessage: "Model reply",
      clarification: "none",
      pageIndexes: [1, 2],
      chapterIndex: null,
      targetLanguage: null,
      editTarget: "whole_book"
    });

    const intent = await classifyProjectChatMessage({
      message: "Remove the sources at the end of the book",
      stage: "complete",
      pages,
      chapters,
      textModel: model
    });

    // The sources list is compiled back matter: rewriting pages would charge
    // for work that cannot remove it.
    expect(model.generateWithTools).not.toHaveBeenCalled();
    expect(intent.kind).toBe("back_matter");
    expect(intent.backMatter).toEqual({ includeSources: false });
    expect(intent.affectedPageIndexes).toEqual([]);
  });

  it("routes the router's back_matter edit target to a free back-matter intent", async () => {
    const model = fakeDecideModel({
      action: "propose_edit",
      confidence: 0.93,
      reasoning: "The reader wants the citation list gone.",
      assistantMessage: "Ich entferne die Quellenliste.",
      clarification: "none",
      pageIndexes: [],
      chapterIndex: null,
      targetLanguage: null,
      editTarget: "back_matter",
      backMatterSources: false
    });

    const intent = await classifyProjectChatMessage({
      message: "Entferne die Quellenliste am Ende des Buches",
      stage: "complete",
      pages,
      chapters,
      textModel: model
    });

    expect(model.generateWithTools).toHaveBeenCalledOnce();
    expect(intent).toMatchObject({
      kind: "back_matter",
      backMatter: { includeSources: false },
      assistantMessage: "Ich entferne die Quellenliste."
    });
  });

  it("uses the AI router for plan revisions via decide", async () => {
    const model = fakeDecideModel({
      action: "plan_revision",
      confidence: 0.97,
      reasoning: "The model handled the routing.",
      assistantMessage: "I’ll revise the plan with that media preference.",
      clarification: "none",
      pageIndexes: [],
      chapterIndex: null,
      targetLanguage: null
    });

    const intent = await classifyProjectChatMessage({
      message: "Make the examples warmer and more practical.",
      stage: "plan_ready",
      pages,
      textModel: model
    });

    expect(model.generateWithTools).toHaveBeenCalledOnce();
    expect(intent).toMatchObject({
      kind: "plan_revision",
      reasoning: "The model handled the routing."
    });
    const call = vi.mocked(model.generateWithTools).mock.calls[0]![0];
    expect(call.tools.map((tool: { name: string }) => tool.name)).toEqual(["read_page", "decide"]);
  });

  it("names an untitled chapter in the prompt instead of handing the router a blank title", async () => {
    const model = fakeDecideModel({
      action: "plan_revision",
      confidence: 0.97,
      reasoning: "The model handled the routing.",
      assistantMessage: "I’ll revise the plan with that media preference.",
      clarification: "none",
      pageIndexes: [],
      chapterIndex: null,
      targetLanguage: null
    });

    await classifyProjectChatMessage({
      message: "Make the examples warmer and more practical.",
      stage: "plan_ready",
      pages,
      // What a continuation whose outline call failed appends: the stored title
      // is empty on purpose, and the router cannot resolve "chapter 2" against
      // a chapter with no name at all.
      chapters: [
        { index: 1, title: "The Race Begins", pageIndexes: [1] },
        { index: 2, title: "", pageIndexes: [2] }
      ],
      textModel: model
    });

    const call = vi.mocked(model.generateWithTools).mock.calls[0]![0];
    const prompt = JSON.parse(call.messages.at(-1)!.content);
    expect(prompt.chapters.map((chapter: { title: string }) => chapter.title)).toEqual([
      "The Race Begins",
      "Chapter 2"
    ]);
  });

  it("names an untitled chapter in the book's language rather than English Chapter N", async () => {
    const model = fakeDecideModel({
      action: "plan_revision",
      confidence: 0.97,
      reasoning: "The model handled the routing.",
      assistantMessage: "I’ll revise the plan with that media preference.",
      clarification: "none",
      pageIndexes: [],
      chapterIndex: null,
      targetLanguage: null
    });

    await classifyProjectChatMessage({
      message: "Make the examples warmer and more practical.",
      stage: "plan_ready",
      pages,
      // Same untitled continuation as the English fallback above: the prompt
      // has to name it the way the printed book does, or a reader saying
      // «فصل 2» is talking about a chapter the router only knows as Chapter 2.
      chapters: [
        { index: 1, title: "The Race Begins", pageIndexes: [1] },
        { index: 2, title: "", pageIndexes: [2] }
      ],
      language: "persian",
      textModel: model
    });

    const call = vi.mocked(model.generateWithTools).mock.calls[0]![0];
    const prompt = JSON.parse(call.messages.at(-1)!.content);
    expect(prompt.chapters.map((chapter: { title: string }) => chapter.title)).toEqual([
      "The Race Begins",
      "فصل 2"
    ]);
  });

  it("falls back to degraded heuristics when the AI router fails", async () => {
    const model = fakeFailingTextModel();

    const intent = await classifyProjectChatMessage({
      message: "I don't want images or covers",
      stage: "plan_ready",
      pages,
      textModel: model
    });

    expect(model.generateWithTools).toHaveBeenCalled();
    expect(intent.kind).toBe("plan_revision");
  });

  it("retries the AI router once on a transient network failure", async () => {
    const model = fakeFlakyDecideModel({
      action: "plan_revision",
      confidence: 0.95,
      reasoning: "Recovered after the connection reset.",
      assistantMessage: "I’ll revise the plan.",
      clarification: "none",
      pageIndexes: [],
      chapterIndex: null,
      targetLanguage: null
    });

    const intent = await classifyProjectChatMessage({
      message: "Make the examples warmer and more practical.",
      stage: "plan_ready",
      pages,
      textModel: model
    });

    expect(model.generateWithTools).toHaveBeenCalledTimes(2);
    expect(intent.reasoning).toBe("Recovered after the connection reset.");
  });

  it("falls back to degraded heuristics without retrying when the AI router exceeds its time budget", async () => {
    vi.useFakeTimers();
    try {
      const model = fakeHangingTextModel();

      const pending = classifyProjectChatMessage({
        message: "I don't want images or covers",
        stage: "plan_ready",
        pages,
        textModel: model
      });
      await vi.advanceTimersByTimeAsync(10_000);
      const intent = await pending;

      expect(model.generateWithTools).toHaveBeenCalledTimes(1);
      expect(intent.kind).toBe("plan_revision");
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells the AI router when the page list was sampled", async () => {
    const model = fakeDecideModel({
      action: "propose_edit",
      confidence: 0.9,
      reasoning: "Targeted page edit.",
      assistantMessage: "I’ll rewrite page 412.",
      clarification: "none",
      editTarget: "pages",
      editStyle: "rewrite",
      pageIndexes: [412],
      chapterIndex: null,
      targetLanguage: null
    });

    await classifyProjectChatMessage({
      message: "Rewrite page 412 in a warmer tone.",
      stage: "complete",
      pages: manyPages(600),
      textModel: model
    });

    const call = vi.mocked(model.generateWithTools).mock.calls[0]![0];
    const prompt = JSON.parse(call.messages.at(-1)!.content);
    expect(prompt.pageContext).toMatchObject({ totalPages: 600, truncated: true });
    expect(prompt.pages.length).toBeLessThanOrEqual(CLASSIFIER_PAGE_SAMPLE_CAP);
    expect(prompt.pages.map((page: { index: number }) => page.index)).toContain(412);
  });

  it("does not tell the router a version-1 cover is unnumbered", async () => {
    const map = {
      version: 2 as 1 | 2,
      totalPdfPages: 10,
      hasCoverPage: true,
      contentsStartPdfPage: 2,
      pages: [
        { index: 1, startPdfPage: 3, endPdfPage: 4 },
        { index: 2, startPdfPage: 4, endPdfPage: 5 }
      ],
      contentRevision: 7
    };
    const classifyWithMap = async (pdfPageMap: typeof map) => {
      const model = fakeDecideModel({
        action: "answer",
        confidence: 0.9,
        reasoning: "Question.",
        assistantMessage: "The ending is on the last page.",
        clarification: "none",
        pageIndexes: [],
        chapterIndex: null,
        targetLanguage: null
      });
      await classifyProjectChatMessage({
        message: "Where does the story end?",
        stage: "complete",
        pages,
        textModel: model,
        pageNumbering: readerPageNumbering(bookPageMapForProject({ pdfPageMap, contentRevision: 7 }))
      });
      const call = vi.mocked(model.generateWithTools).mock.calls[0]![0];
      return JSON.parse(call.messages.at(-1)!.content).readerPageContext as {
        totalPrintedPages: number;
        cover?: boolean;
        contentsStartPage?: number;
      };
    };

    expect(await classifyWithMap(map)).toEqual({
      totalPrintedPages: 9,
      cover: true,
      contentsStartPage: 1
    });
    // Version-1 PDFs still print "Page 1" on the cover; claiming an unnumbered
    // cover plus 10 printed pages told the model the opposite of the footer.
    expect(await classifyWithMap({ ...map, version: 1 })).toEqual({
      totalPrintedPages: 10,
      contentsStartPage: 2
    });
  });

  it("lets the router read page prose before deciding", async () => {
    const loadPageBody = vi.fn(async () => "Full prose of the practice scene where the old phrase appears.");
    const model = scriptedTextModel([
      {
        text: "",
        model: "test-router",
        provider: "test",
        toolCalls: [{ id: "call-read", name: "read_page", arguments: { index: 2 } }]
      },
      decideDecision({
        action: "propose_edit",
        confidence: 0.93,
        reasoning: "The phrase only appears on page 2.",
        assistantMessage: "I’ll rewrite page 2 without that phrase.",
        clarification: "none",
        editTarget: "pages",
        editStyle: "rewrite",
        pageIndexes: [2],
        chapterIndex: null,
        targetLanguage: null
      })
    ]);

    const intent = await classifyProjectChatMessage({
      message: "Get rid of the part with the old phrase.",
      stage: "complete",
      pages,
      textModel: model,
      loadPageBody
    });

    expect(loadPageBody).toHaveBeenCalledWith(2);
    expect(model.generateWithTools).toHaveBeenCalledTimes(2);
    const secondCall = vi.mocked(model.generateWithTools).mock.calls[1]![0];
    const toolResult = secondCall.messages.find(
      (message: { role: string }) => message.role === "tool"
    );
    expect(toolResult?.content).toContain("Full prose of the practice scene");
    expect(intent.kind).toBe("page_rewrite");
    expect(intent.affectedPageIndexes).toEqual([2]);
  });

  it("only offers stage-appropriate decide actions to the model", async () => {
    const model = fakeDecideModel({
      action: "plan_revision",
      confidence: 0.9,
      reasoning: "Plan-stage routing.",
      assistantMessage: "I’ll revise the plan.",
      clarification: "none",
      pageIndexes: [],
      chapterIndex: null,
      targetLanguage: null
    });

    await classifyProjectChatMessage({
      message: "Make the examples warmer.",
      stage: "plan_ready",
      pages,
      textModel: model
    });

    const call = vi.mocked(model.generateWithTools).mock.calls[0]![0];
    const decideTool = call.tools.find((tool: { name: string }) => tool.name === "decide")!;
    const editActionAtPlanStage = decideTool.parameters.safeParse({
      action: "propose_edit",
      confidence: 0.9,
      reasoning: "Not allowed at plan stage.",
      assistantMessage: "x",
      clarification: "none",
      pageIndexes: [],
      chapterIndex: null,
      targetLanguage: null
    });
    expect(editActionAtPlanStage.success).toBe(false);
  });

  it("falls back to degraded heuristics when the router never commits a decision", async () => {
    const textOnly: ToolCallsResult = {
      text: "I think this is a plan change.",
      model: "test-router",
      provider: "test",
      toolCalls: []
    };
    const model = scriptedTextModel([textOnly, textOnly, textOnly, textOnly]);

    const intent = await classifyProjectChatMessage({
      message: "I don't want images or covers",
      stage: "plan_ready",
      pages,
      textModel: model
    });

    expect(intent.kind).toBe("plan_revision");
  });
});
