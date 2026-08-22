import { describe, expect, it } from "vitest";
import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import type { TextModelAdapter } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import { generatePageDraft } from "./pages.js";
import type { PriorPageContext } from "./pagesShared.js";

const input: CreateProjectInput = {
  prompt: "Jack The Martyr, a character-led story about sacrifice and consequence.",
  category: "STORY",
  targetPages: 10,
  complexity: 5,
  temperature: 0.8,
  language: "en",
  mediaSettings: {
    fullIllustrations: true,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral" as const
  }
};

const plan = makeFallbackPlan(input);

function goodMarkdown(): string {
  return [
    "The chapel wall was slick with the night's rain, and Jack was already halfway over it when the bell began to ring. He froze with one boot wedged in the ivy and listened to the count: three strokes, then silence, then three more.",
    "",
    '"They ring it for the dead," Mara had told him once. "Or for the caught."',
    "",
    "He dropped into the courtyard anyway. The warrant in his coat pressed against his ribs with every step, and the red wax seal had cracked where his thumb kept worrying it. Someone dragged a chair across stone inside the chapel, and that small sound decided him: he crossed to the black door and lifted the latch."
  ].join("\n");
}

type CapturedDraftCall = {
  model: TextModelAdapter;
  payload?: Record<string, any>;
  system?: string;
};

function capturingJsonModel(rawData: unknown): CapturedDraftCall {
  const capture: CapturedDraftCall = {
    model: {
      async generateText() {
        return { text: "", model: "test-model", provider: "test" };
      },
      async generateJson(options) {
        capture.system = String(options.messages[0]?.content ?? "");
        capture.payload = JSON.parse(options.messages[1]?.content ?? "{}") as Record<string, any>;
        return {
          data: options.schema.parse(rawData),
          text: JSON.stringify(rawData),
          model: "test-model",
          provider: "test"
        };
      },
      async *streamText() {
        yield "";
      },
      generateWithTools: unsupportedGenerateWithTools
    }
  };
  return capture;
}

/**
 * The first-page half of the draft prompt: page 1 is drafted against an empty
 * context window (no recentPages, no memory), so `buildPageInstruction` is the
 * only thing standing between the reader's first impression and generic
 * throat-clearing. The final-page twin of these assertions lives in
 * pages.test.ts.
 */
describe("first-page draft instruction", () => {
  it("includes first-page hook guidance and the plan's openingHook only on page 1", async () => {
    const capture = capturingJsonModel({
      title: "The Wall Bell",
      markdown: goodMarkdown(),
      summary: "Jack is caught mid-climb when the chapel bell starts.",
      continuityNotes: []
    });
    const hookPlan = {
      ...plan,
      openingHook: "Jack is already halfway over the chapel wall when the bell starts ringing for him."
    };

    await generatePageDraft({
      input,
      plan: hookPlan,
      chapter: hookPlan.chapters[0],
      pageIndex: 1,
      previousSummaries: [],
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: capture.model
    });

    expect(capture.payload?.pageInstruction).toMatch(/first page/i);
    expect(capture.payload?.pageInstruction).toMatch(/hook the reader/i);
    expect(capture.payload?.pageInstruction).toMatch(/scene already in motion/i);
    expect(capture.payload?.pageInstruction).toMatch(/openingHook/);
    expect(capture.payload?.openingHook).toBe(hookPlan.openingHook);

    await generatePageDraft({
      input,
      plan: hookPlan,
      chapter: hookPlan.chapters[0],
      pageIndex: 2,
      previousSummaries: ["Jack is caught mid-climb when the chapel bell starts."],
      previousPages: [
        {
          index: 1,
          title: "The Wall Bell",
          markdown: goodMarkdown(),
          summary: "Jack is caught mid-climb when the chapel bell starts."
        }
      ],
      continuityNotes: [],
      researchNotes: [],
      textModel: capture.model
    });

    expect(capture.payload?.pageInstruction).not.toMatch(/first page/i);
    expect(capture.payload?.openingHook).toBeUndefined();
  });

  it("shapes the first-page opening rule by category", async () => {
    const capture = capturingJsonModel({
      title: "The Kitchen Tap",
      markdown: goodMarkdown(),
      summary: "The reader tests their own tap water against a real case.",
      continuityNotes: []
    });
    const eduInput = { ...input, category: "EDUCATION" as const };
    const eduPlan = makeFallbackPlan(eduInput);

    await generatePageDraft({
      input: eduInput,
      plan: eduPlan,
      chapter: eduPlan.chapters[0],
      pageIndex: 1,
      previousSummaries: [],
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: capture.model
    });

    expect(capture.payload?.pageInstruction).toMatch(/concrete claim, surprising specific/i);
    expect(capture.payload?.pageInstruction).not.toMatch(/scene already in motion/i);
    expect(capture.payload?.openingHook).toBeUndefined();
  });
});

/**
 * A book written front to back never needs to look forward, which is why this
 * context has only ever looked back. A page inserted into a *finished* book
 * does: it has to hand off to prose the reader already has.
 */
describe("forward context for an inserted page", () => {
  const following = [
    { index: 5, title: "The Warning", markdown: "Inside, the seal was already cracked.", summary: "Jack finds the seal." }
  ];

  async function draftInsertedPage(capture: CapturedDraftCall, nextPages?: PriorPageContext[]): Promise<void> {
    await generatePageDraft({
      input,
      plan,
      chapter: plan.chapters[0],
      pageIndex: 4,
      previousSummaries: ["Jack reaches the chapel."],
      previousPages: [
        { index: 3, title: "The Chapel", markdown: "Jack reached the chapel door.", summary: "Jack arrives." }
      ],
      ...(nextPages ? { nextPages } : {}),
      continuityNotes: [],
      researchNotes: [],
      textModel: capture.model
    });
  }

  function draftCapture(): CapturedDraftCall {
    return capturingJsonModel({
      title: "The Black Door",
      markdown: goodMarkdown(),
      summary: "Jack lifts the latch.",
      continuityNotes: []
    });
  }

  it("adds nothing at all when no page follows", async () => {
    const capture = draftCapture();

    await draftInsertedPage(capture);

    expect(capture.payload).not.toHaveProperty("followingPages");
    expect(capture.system).not.toContain("followingPages");
  });

  it("names the prose the page must land into, and says not to repeat it", async () => {
    const capture = draftCapture();

    await draftInsertedPage(capture, following);

    expect(capture.payload?.followingPages).toEqual([
      expect.objectContaining({ index: 5, excerpt: "Inside, the seal was already cracked." })
    ]);
    expect(capture.system).toContain("followingPages");
    expect(capture.system).toContain("reads on naturally");
  });

  it("keeps the forward window tighter than the backward one", async () => {
    // Two pages, not five: the hand-off is settled by the opening of the next
    // page, and a wide forward window invites the draft to write its beats.
    const many = [5, 6, 7, 8].map((index) => ({
      index,
      title: `Page ${index}`,
      markdown: `Body ${index}.`,
      summary: `Summary ${index}.`
    }));
    const capture = draftCapture();

    await draftInsertedPage(capture, many);

    const followingPages = capture.payload?.followingPages as { index: number }[] | undefined;
    // Taken from the *front*: the nearest following page is the one the draft
    // has to land into, so a tail slice would keep exactly the wrong two.
    expect(followingPages?.map((page) => page.index)).toEqual([5, 6]);
  });
});
