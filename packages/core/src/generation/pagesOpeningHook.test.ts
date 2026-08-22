import { describe, expect, it } from "vitest";
import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import type { TextModelAdapter } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import { generateBatchDraft, generateChapterDraft, generateWholeBookDraft } from "./pages.js";

/**
 * The multi-page writers' half of one invariant: a prompt that talks about the
 * plan's `openingHook` has to send the key too.
 *
 * The single-page prompts pin their own half — the draft in
 * pageDraftMessages.test.ts, the polish in pages.test.ts, the reviewer and the
 * reviser in pagesReview.test.ts — and they ask "am I page 1". These three ask
 * the range form of the same question, which is the one that used to be missing
 * entirely: a page map whose page-1 brief assigns the hook was handed to a
 * payload that carried no hook to assign.
 */

const input = {
  prompt: "A story about a bell that rings for one boy.",
  category: "STORY",
  targetPages: 2,
  complexity: 5,
  temperature: 0.8,
  language: "en",
  mediaSettings: {
    fullIllustrations: false,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral"
  }
} as CreateProjectInput;

const hooklessPlan = makeFallbackPlan(input);
const openingHook = "Jack is already halfway over the chapel wall when the bell starts ringing for him.";
const hookPlan: BookPlan = { ...hooklessPlan, openingHook };

const markdown =
  "The chapel door had been painted black so many times that the grain underneath looked bruised. Jack pressed two fingers to the iron latch and felt it tremble.";

function draftPage(index: number) {
  return { index, title: `Page ${index}`, markdown, summary: `Jack moves, page ${index}.`, continuityNotes: [] };
}

function capturingModel(pages: ReturnType<typeof draftPage>[]) {
  const capture: { payload?: Record<string, unknown>; system?: string; model: TextModelAdapter } = {
    model: {
      async generateText() {
        return { text: "", model: "test-model", provider: "test" };
      },
      async generateJson(options) {
        capture.system = options.messages[0]?.content ?? "";
        capture.payload = JSON.parse(options.messages[1]?.content ?? "{}") as Record<string, unknown>;
        return { data: options.schema.parse({ pages }), text: "{}", model: "test-model", provider: "test" };
      },
      async *streamText() {
        yield "";
      },
      generateWithTools: unsupportedGenerateWithTools
    }
  };
  return capture;
}

describe("whole-book draft opening hook", () => {
  it("hands the one-pass writer the hook and the rule that names it", async () => {
    const capture = capturingModel([draftPage(1), draftPage(2)]);

    await generateWholeBookDraft({ input, plan: hookPlan, researchNotes: [], textModel: capture.model });

    expect(capture.payload?.openingHook).toBe(openingHook);
    expect(capture.system).toMatch(/openingHook is the plan's commitment to how it opens/i);
  });

  it("names no hook when the plan committed to none", async () => {
    const capture = capturingModel([draftPage(1), draftPage(2)]);

    await generateWholeBookDraft({ input, plan: hooklessPlan, researchNotes: [], textModel: capture.model });

    expect(capture.payload).not.toHaveProperty("openingHook");
    expect(capture.system).not.toMatch(/openingHook/);
  });
});

describe("chapter and batch draft opening hook", () => {
  it("gives a chapter draft the hook only when its page range covers page 1", async () => {
    const opener = capturingModel([draftPage(1), draftPage(2)]);
    await generateChapterDraft({
      input,
      plan: hookPlan,
      chapter: hookPlan.chapters[0]!,
      chapterPageStart: 1,
      chapterPageEnd: 2,
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: opener.model
    });
    expect(opener.payload?.openingHook).toBe(openingHook);
    expect(opener.system).toMatch(/openingHook/);

    const later = capturingModel([draftPage(3), draftPage(4)]);
    await generateChapterDraft({
      input,
      plan: hookPlan,
      chapter: hookPlan.chapters[0]!,
      chapterPageStart: 3,
      chapterPageEnd: 4,
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: later.model
    });
    expect(later.payload).not.toHaveProperty("openingHook");
    expect(later.system).not.toMatch(/openingHook/);
  });

  it("gives a batch draft the hook only when its page range covers page 1", async () => {
    const opener = capturingModel([draftPage(1), draftPage(2)]);
    await generateBatchDraft({
      input,
      plan: hookPlan,
      chapterBriefs: [],
      pageStart: 1,
      pageEnd: 2,
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: opener.model
    });
    expect(opener.payload?.openingHook).toBe(openingHook);
    expect(opener.system).toMatch(/openingHook/);

    const later = capturingModel([draftPage(5), draftPage(6)]);
    await generateBatchDraft({
      input,
      plan: hookPlan,
      chapterBriefs: [],
      pageStart: 5,
      pageEnd: 6,
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: later.model
    });
    expect(later.payload).not.toHaveProperty("openingHook");
    expect(later.system).not.toMatch(/openingHook/);
  });
});
