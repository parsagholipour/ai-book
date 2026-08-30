import { describe, expect, it, vi } from "vitest";
import type { GenerateWithToolsOptions, TextModelAdapter, ToolCallsResult } from "@book-maker/core";
import { classifyProjectChatMessage } from "./bookEditIntent.js";

/**
 * How image-insertion requests travel through classifyProjectChatMessage: the
 * router's insert_image target is the ONLY classifier (the regex fast path was
 * deliberately removed — extraction is model work), plus the subject
 * clarification budget and the documented degraded-mode behavior. Lives beside
 * bookEditImage.test.ts rather than inside bookEditIntent.test.ts, which is at
 * its size budget.
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

type DecideArgs = Record<string, unknown>;

function routerAdapter(
  generateWithTools: (options: GenerateWithToolsOptions) => Promise<ToolCallsResult>
): TextModelAdapter {
  return {
    generateText: async () => ({ text: "", model: "test-router", provider: "test" }),
    generateJson: async () => {
      throw new Error("generateJson is not used by the tool-calling router");
    },
    generateWithTools: generateWithTools as TextModelAdapter["generateWithTools"],
    async *streamText() {
      yield "";
    }
  };
}

function fakeDecideModel(args: DecideArgs): TextModelAdapter & { generateWithTools: ReturnType<typeof vi.fn> } {
  const completeArgs = {
    ...args,
    ...(args.action === "propose_edit"
      ? { editInstruction: String(args.editInstruction ?? args.assistantMessage ?? "Apply the requested image edit.") }
      : {})
  };
  const generateWithTools = vi.fn(async () => ({
    text: "",
    model: "test-router",
    provider: "test",
    toolCalls: [{ id: "call-decide", name: "decide", arguments: completeArgs }]
  }));
  return Object.assign(routerAdapter(generateWithTools), { generateWithTools });
}

const decideBase: DecideArgs = {
  confidence: 0.93,
  reasoning: "Routing decision.",
  assistantMessage: "ok",
  clarification: "none",
  pageIndexes: [],
  chapterIndex: null,
  targetLanguage: null
};

describe("image insertion routing", () => {
  it("routes every image request through the model, which extracts subject and ordinal placements", async () => {
    const model = fakeDecideModel({
      ...decideBase,
      action: "propose_edit",
      editInstruction: "Add a dragon illustration at the end of the book.",
      assistantMessage: "I’ll add that picture to page 3.",
      pageIndexes: [3],
      editTarget: "insert_image",
      imageSubject: "her signature"
    });

    const intent = await classifyProjectChatMessage({
      message: "Add the photo of her signature on the 3rd page",
      stage: "complete",
      pages,
      chapters,
      textModel: model
    });

    // No regex fast path: the model is the one classifier for image requests.
    expect(model.generateWithTools).toHaveBeenCalledOnce();
    expect(intent.kind).toBe("add_image");
    expect(intent.imageEdit).toEqual({ subject: "her signature", placement: "page", pageIndex: 3 });
    expect(intent.affectedPageIndexes).toEqual([3]);
  });

  it("degrades to the heuristics' clarify when no router model is available", async () => {
    const intent = await classifyProjectChatMessage({
      message: "Add a photo of a dragon at the end of the book",
      stage: "complete",
      pages,
      chapters
    });

    // The accepted cost of removing the regex recognizer: without a model
    // there is no image detection, and the degraded heuristics never invent a
    // charged kind — their catch-all is the one clarifying question.
    expect(intent.kind).toBe("clarify");
  });

  it("degrades the same way when the router throws", async () => {
    const failing = routerAdapter(async () => {
      throw new Error("router unavailable");
    });

    const intent = await classifyProjectChatMessage({
      message: "Add a photo of a dragon at the end of the book",
      stage: "complete",
      pages,
      chapters,
      textModel: failing
    });

    expect(intent.kind).toBe("clarify");
  });

  it("widens to a whole-book rewrite card on the exhausted degraded turn — the accepted outage behavior", async () => {
    const failing = routerAdapter(async () => {
      throw new Error("router unavailable");
    });

    const intent = await classifyProjectChatMessage({
      message: "Add a photo of a dragon\n\nFollow-up from the user: just add it",
      stage: "complete",
      pages,
      chapters,
      textModel: failing,
      clarifyExhausted: true
    });

    // Consciously accepted when the regex recognizer was deleted: with the
    // router down AND the one question already spent, forcedDecision coerces
    // the surviving clarify into a whole-book page_rewrite PROPOSAL — bounded
    // by the card, nothing charged until Apply. If this trade-off is ever
    // revisited, an image-aware fallback belongs in the degraded lane, not in
    // front of the router.
    expect(intent.kind).toBe("page_rewrite");
    expect(intent.scope).toBe("all_pages");
  });

  it("never produces add_image while the book is still at the plan stage", async () => {
    const intent = await classifyProjectChatMessage({
      message: "Add a photo of a dragon at the end of the book",
      stage: "approved_plan",
      pages
    });

    expect(intent.kind).toBe("plan_revision");
  });

  it("maps the router's insert_image target onto add_image", async () => {
    const model = fakeDecideModel({
      ...decideBase,
      action: "propose_edit",
      assistantMessage: "Ich füge das Bild hinzu.",
      editTarget: "insert_image",
      imageSubject: "ein Drache",
      imagePlacement: "end_of_book"
    });

    const intent = await classifyProjectChatMessage({
      message: "Füge am Ende ein Bild von einem Drachen hinzu",
      stage: "complete",
      pages,
      chapters,
      textModel: model
    });

    expect(model.generateWithTools).toHaveBeenCalledOnce();
    expect(intent).toMatchObject({
      kind: "add_image",
      assistantMessage: "Ich füge das Bild hinzu.",
      imageEdit: { subject: "ein Drache", placement: "end_of_book" }
    });
  });

  it("routes a Persian page placement through pageIndexes", async () => {
    const model = fakeDecideModel({
      ...decideBase,
      action: "propose_edit",
      assistantMessage: "این تصویر را اضافه می‌کنم.",
      pageIndexes: [2],
      editTarget: "insert_image",
      imageSubject: "یک اژدها"
    });

    const intent = await classifyProjectChatMessage({
      message: "در صفحه ۲ یک عکس از اژدها اضافه کن",
      stage: "complete",
      pages,
      chapters,
      textModel: model
    });

    expect(intent.kind).toBe("add_image");
    expect(intent.imageEdit).toEqual({ subject: "یک اژدها", placement: "page", pageIndex: 2 });
    expect(intent.affectedPageIndexes).toEqual([2]);
  });

  it("asks the one subject question, then defaults to the generic subject when spent", async () => {
    const subjectless: DecideArgs = {
      ...decideBase,
      action: "propose_edit",
      assistantMessage: "I'll add a picture.",
      editTarget: "insert_image"
    };

    const first = await classifyProjectChatMessage({
      message: "Can you add a picture somewhere?",
      stage: "complete",
      pages,
      textModel: fakeDecideModel(subjectless)
    });
    expect(first.kind).toBe("clarify");
    // "scope" is the tautology that stores the resumable pendingEdit.
    expect(first.clarification).toBe("scope");
    // Any question must state the default it will apply.
    expect(first.assistantMessage).toMatch(/go ahead/i);

    const second = await classifyProjectChatMessage({
      message: "Can you add a picture somewhere?\n\nFollow-up from the user: just add",
      stage: "complete",
      pages,
      textModel: fakeDecideModel(subjectless),
      clarifyExhausted: true
    });
    expect(second.kind).toBe("add_image");
    expect(second.imageEdit?.subject).toBe("a scene from this book");
  });

  it("offers imageSubject and imagePlacement in the decide schema at the complete stage", async () => {
    const model = fakeDecideModel({ ...decideBase, action: "answer" });

    await classifyProjectChatMessage({
      message: "Could you add one small picture near the front",
      stage: "complete",
      pages,
      textModel: model
    });

    const call = vi.mocked(model.generateWithTools).mock.calls[0]![0] as GenerateWithToolsOptions;
    expect(String(call.messages[0]!.content)).toMatch(/insert_image/);
    // Replacement is taught, not implied: without the imageReplace rule the
    // model answers a correction with a second add.
    expect(String(call.messages[0]!.content)).toMatch(/imageReplace/);
    expect(String(call.messages[0]!.content)).toMatch(/built-in illustration/);
    const decideTool = call.tools.find((tool) => tool.name === "decide")!;
    const parsed = decideTool.parameters.safeParse({
      ...decideBase,
      action: "propose_edit",
      editInstruction: "Add a dragon illustration at the end of the book.",
      editTarget: "insert_image",
      imageSubject: "a dragon",
      imagePlacement: "end_of_book",
      imageReplace: true
    });
    expect(parsed.success).toBe(true);
  });

  it("maps remove_image and move_image onto their own kinds", async () => {
    const remove = await classifyProjectChatMessage({
      message: "Remove the picture on page 1",
      stage: "complete",
      pages,
      chapters,
      textModel: fakeDecideModel({
        ...decideBase,
        action: "propose_edit",
        editInstruction: "Move the illustration from page 1 to page 2.",
        editTarget: "remove_image",
        pageIndexes: [1]
      })
    });
    expect(remove.kind).toBe("remove_image");
    expect(remove.imageLayout).toEqual({ action: "remove", pageIndex: 1 });

    const move = await classifyProjectChatMessage({
      message: "Move the picture on page 1 to page 2",
      stage: "complete",
      pages,
      chapters,
      textModel: fakeDecideModel({
        ...decideBase,
        action: "propose_edit",
        editTarget: "move_image",
        pageIndexes: [1],
        imageDestPageIndexes: [2]
      })
    });
    expect(move.kind).toBe("move_image");
    expect(move.imageLayout).toEqual({
      action: "move",
      pageIndex: 1,
      destPlacement: "page",
      destPageIndex: 2
    });
  });

  it("maps imageSelection onto a whole-book or chapter removal", async () => {
    const all = await classifyProjectChatMessage({
      message: "Remove all the pictures",
      stage: "complete",
      pages,
      chapters,
      textModel: fakeDecideModel({
        ...decideBase,
        action: "propose_edit",
        editTarget: "remove_image",
        imageSelection: "all"
      })
    });
    expect(all.imageLayout?.selection).toEqual({ kind: "all" });

    const chapter = await classifyProjectChatMessage({
      message: "Remove the images from chapter 2",
      stage: "complete",
      pages,
      chapters,
      textModel: fakeDecideModel({
        ...decideBase,
        action: "propose_edit",
        editTarget: "remove_image",
        imageSelection: "chapter",
        chapterIndex: 2
      })
    });
    expect(chapter.imageLayout?.selection).toEqual({ kind: "chapter", chapterIndex: 2 });
  });

  // Under-doing is one more sentence away; over-doing needs an undo.
  it("degrades a chapter removal with no usable index to a single picture", async () => {
    const intent = await classifyProjectChatMessage({
      message: "Remove the images from that chapter",
      stage: "complete",
      pages,
      chapters,
      textModel: fakeDecideModel({
        ...decideBase,
        action: "propose_edit",
        editTarget: "remove_image",
        imageSelection: "chapter",
        chapterIndex: null
      })
    });
    expect(intent.kind).toBe("remove_image");
    expect(intent.imageLayout?.selection).toBeUndefined();
  });

  // Without the field, a model that forgets it removes exactly one picture from
  // a "remove all" request — the headline case for the whole feature.
  it("reads a whole-book removal off the message when the router omits the field", async () => {
    const intent = await classifyProjectChatMessage({
      message: "Take all the illustrations out",
      stage: "complete",
      pages,
      chapters,
      textModel: fakeDecideModel({
        ...decideBase,
        action: "propose_edit",
        editTarget: "remove_image"
      })
    });
    expect(intent.imageLayout?.selection).toEqual({ kind: "all" });
  });

  it("treats a place inside a page as a complete destination, with no question", async () => {
    const intent = await classifyProjectChatMessage({
      message: "Move the picture on page 1 to the bottom of the page",
      stage: "complete",
      pages,
      chapters,
      textModel: fakeDecideModel({
        ...decideBase,
        action: "propose_edit",
        editTarget: "move_image",
        pageIndexes: [1],
        imagePosition: "bottom"
      })
    });
    expect(intent.kind).toBe("move_image");
    expect(intent.clarification).toBe("none");
    expect(intent.imageLayout).toEqual({
      action: "move",
      pageIndex: 1,
      destPlacement: "page",
      destPageIndex: 1,
      destPosition: "bottom"
    });
  });

  // "the last page" is an end-of-book phrase, so the position has to be read
  // first or the picture lands on a different page than the reader named.
  it("keeps a position on the named page rather than sending it to the end", async () => {
    const intent = await classifyProjectChatMessage({
      message: "Put the picture at the bottom of the last page",
      stage: "complete",
      pages,
      chapters,
      textModel: fakeDecideModel({
        ...decideBase,
        action: "propose_edit",
        editTarget: "move_image",
        pageIndexes: [2]
      })
    });
    expect(intent.imageLayout?.destPosition).toBe("bottom");
    expect(intent.imageLayout?.destPlacement).toBe("page");
  });

  it("still answers a resize request rather than pricing a rewrite", async () => {
    const intent = await classifyProjectChatMessage({
      message: "Make the picture on page 1 bigger",
      stage: "complete",
      pages,
      chapters,
      textModel: fakeDecideModel({ ...decideBase, action: "answer" })
    });
    expect(intent.kind).toBe("answer");
  });

  it("does not teach move_image or remove_image while the book is still at the plan stage", async () => {
    const model = fakeDecideModel({ ...decideBase, action: "plan_revision" });
    await classifyProjectChatMessage({
      message: "Remove the picture",
      stage: "approved_plan",
      pages,
      textModel: model
    });
    const call = vi.mocked(model.generateWithTools).mock.calls[0]![0] as GenerateWithToolsOptions;
    expect(String(call.messages[0]!.content)).not.toMatch(/remove_image/);
    expect(String(call.messages[0]!.content)).not.toMatch(/move_image/);
  });

  it("asks which page when a move names no destination", async () => {
    const intent = await classifyProjectChatMessage({
      message: "Move the picture on page 1",
      stage: "complete",
      pages,
      chapters,
      textModel: fakeDecideModel({
        ...decideBase,
        action: "propose_edit",
        editTarget: "move_image",
        pageIndexes: [1]
      })
    });
    expect(intent.kind).toBe("clarify");
    expect(intent.clarification).toBe("scope");
    expect(intent.assistantMessage).toMatch(/end of the book/i);
  });

  it("defaults a spent dest question to the end of the book rather than a rewrite", async () => {
    const intent = await classifyProjectChatMessage({
      message: "Move the picture on page 1\n\nFollow-up from the user: just do it",
      stage: "complete",
      pages,
      chapters,
      textModel: fakeDecideModel({
        ...decideBase,
        action: "propose_edit",
        editTarget: "move_image",
        pageIndexes: [1]
      }),
      clarifyExhausted: true
    });
    expect(intent.kind).toBe("move_image");
    expect(intent.imageLayout).toEqual({ action: "move", pageIndex: 1, destPlacement: "end_of_book" });
  });

  it("offers move_image and remove_image in the decide schema at the complete stage", async () => {
    const model = fakeDecideModel({ ...decideBase, action: "answer" });
    await classifyProjectChatMessage({
      message: "Could you move one picture",
      stage: "complete",
      pages,
      textModel: model
    });
    const call = vi.mocked(model.generateWithTools).mock.calls[0]![0] as GenerateWithToolsOptions;
    expect(String(call.messages[0]!.content)).toMatch(/remove_image/);
    expect(String(call.messages[0]!.content)).toMatch(/move_image/);
    expect(String(call.messages[0]!.content)).not.toMatch(/Edit Mode on that page can remove/);
    const decideTool = call.tools.find((tool) => tool.name === "decide")!;
    expect(
      decideTool.parameters.safeParse({
        ...decideBase,
        action: "propose_edit",
        editInstruction: "Move the illustration from page 1 to page 2.",
        editTarget: "move_image",
        pageIndexes: [1],
        imageDestPageIndexes: [2]
      }).success
    ).toBe(true);
  });
});
