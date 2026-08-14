import { beforeEach, describe, expect, it, vi } from "vitest";
import { MECHANICAL_TEXT_PURPOSES } from "../adapters/modelTiers.js";
import type { ChatMessage } from "../adapters/types.js";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { pageDraftSchema, type CreateProjectInput, type PageDraft } from "../schemas/book.js";
import type { GeneratePageOptions } from "./pagesShared.js";
import { emptyStoryState, type StoryState } from "./storyState.js";

const runToolLoopMock = vi.hoisted(() => vi.fn());

vi.mock("../adapters/toolLoop.js", () => ({
  runToolLoop: (...args: unknown[]) => runToolLoopMock(...args)
}));

import { generatePageDraftWithWriterTools, shouldSkipWriterTools } from "./writerTools.js";

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

const plan = {
  ...makeFallbackPlan(input),
  voiceGuide: ["Speak like a dockside chronicler with salt in the syntax."],
  antiAiRules: ["Never write 'in this chapter we explore'."]
};

const storyState: StoryState = {
  promises: [{ id: "p1", text: "Jack will answer the warrant", status: "open", openedAtPage: 1 }],
  facts: [{ text: "The chapel seal is cracked", pageIndex: 1 }],
  entities: {
    Jack: { knows: ["the cracked seal"], location: "Oakhaven", updatedAtPage: 1 }
  },
  unanswered: ["Who moved the latch?"]
};

const finishedDraft: PageDraft = {
  title: "The Latch",
  markdown: "Jack put his palm on the painted door and felt the latch move first.",
  summary: "Jack reaches the chapel door as the latch moves.",
  continuityNotes: []
};

function draftOptions(overrides: Partial<GeneratePageOptions> = {}): GeneratePageOptions {
  return {
    input,
    plan,
    chapter: plan.chapters[0],
    pageIndex: 2,
    previousSummaries: ["Jack already crossed the checkpoint."],
    previousPages: [
      {
        index: 1,
        title: "The Checkpoint",
        markdown: "At the checkpoint, Jack showed the guard the cracked seal.",
        summary: "Jack passes the checkpoint by refusing to hide the seal."
      }
    ],
    continuityNotes: ["The seal is already cracked."],
    researchNotes: ["Chapel doors in Oakhaven were painted black after the fire."],
    entityState: ["Jack: location Oakhaven; knows the cracked seal."],
    textModel: new FakeTextModelAdapter(input),
    ...overrides
  };
}

describe("generatePageDraftWithWriterTools", () => {
  beforeEach(() => {
    runToolLoopMock.mockReset();
    runToolLoopMock.mockResolvedValue({ status: "finished", finish: finishedDraft });
  });

  it("skips the tool loop when story state is empty and there is no research", () => {
    expect(shouldSkipWriterTools({ storyState: emptyStoryState(), researchNotes: [] })).toBe(true);
  });

  it("does not skip when research notes are present", () => {
    expect(shouldSkipWriterTools({ storyState: emptyStoryState(), researchNotes: ["A note."] })).toBe(false);
  });

  it("falls back without calling the tool loop when state and research are empty", async () => {
    const fallbackDraft = { ...finishedDraft, title: "Fallback" };
    const draft = await generatePageDraftWithWriterTools({
      ...draftOptions({ researchNotes: [] }),
      storyState: emptyStoryState(),
      fallback: async () => fallbackDraft
    });

    expect(draft.title).toBe("Fallback");
    expect(runToolLoopMock).not.toHaveBeenCalled();
  });

  it("feeds the ordinary page-draft context pack and system rules into the tool loop", async () => {
    await generatePageDraftWithWriterTools({
      ...draftOptions(),
      storyState,
      fallback: async () => {
        throw new Error("fallback should not run");
      }
    });

    expect(runToolLoopMock).toHaveBeenCalledTimes(1);
    const loop = runToolLoopMock.mock.calls[0]?.[0] as {
      purpose: string;
      maxModelCalls: number;
      temperature: number;
      messages: ChatMessage[];
      tools: Array<{ name: string }>;
    };

    expect(loop.purpose).toBe("write-page-with-tools");
    expect(MECHANICAL_TEXT_PURPOSES.has(loop.purpose)).toBe(false);
    expect(loop.maxModelCalls).toBe(3);
    expect(loop.temperature).toBe(0.8);
    expect(loop.tools.map((tool) => tool.name)).toEqual(["lookup_page", "lookup_entity", "search_research"]);

    const systemMessage = loop.messages.find((message) => message.role === "system")?.content ?? "";
    const userMessage = loop.messages.find((message) => message.role === "user")?.content ?? "";
    expect(systemMessage).toMatch(/Do not mention AI, prompts, plans/i);
    expect(systemMessage).toMatch(/Treat pageBrief purpose, beat, requiredContinuity, and endingPressure as internal assignment notes/i);
    expect(systemMessage).toMatch(/You may look up an earlier page/i);
    expect(userMessage).toBeTruthy();

    const payload = JSON.parse(userMessage) as {
      context?: { system?: string; outline?: string; research?: string };
      characters?: unknown;
      illustrationPlan?: unknown;
      recentPages?: Array<{ excerpt: string }>;
      pageInstruction?: string;
      userContext?: { prompt?: string };
    };

    expect(payload.context?.system).toMatch(/dockside chronicler/i);
    expect(payload.context?.system).toMatch(/Never write 'in this chapter we explore'/i);
    expect(payload.context?.outline).toMatch(/Current chapter/i);
    expect(payload.context?.research).toMatch(/painted black/i);
    expect(payload.userContext?.prompt).toMatch(/Jack The Martyr/i);
    expect(payload.characters).toEqual(plan.characters);
    expect(payload.illustrationPlan).toEqual(plan.illustrationPlan);
    expect(payload.recentPages?.[0]?.excerpt).toContain("checkpoint");
    expect(payload.pageInstruction).toMatch(/Write exactly this page/i);
  });

  it("forwards a raised input temperature into the tool loop", async () => {
    await generatePageDraftWithWriterTools({
      ...draftOptions({ input: { ...input, temperature: 1.1 } }),
      storyState,
      fallback: async () => {
        throw new Error("fallback should not run");
      }
    });

    expect(runToolLoopMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ temperature: 1.1 }));
  });

  it("titles an unscripted writer-tools draft from pageScope.globalPageIndex", async () => {
    const adapter = new FakeTextModelAdapter(input);
    const result = await adapter.generateWithTools({
      purpose: "write-page-with-tools",
      messages: [
        { role: "system", content: "Write the page." },
        { role: "user", content: JSON.stringify({ pageScope: { globalPageIndex: 7 } }) }
      ],
      tools: [
        {
          name: "finish_turn",
          description: "Submit the finished page draft.",
          parameters: pageDraftSchema
        }
      ]
    });

    expect(result.toolCalls?.[0]?.arguments).toMatchObject({
      title: "Dry Run Turn 7",
      summary: expect.stringMatching(/Page 7/)
    });
  });

  it("falls back when the tool loop fails", async () => {
    runToolLoopMock.mockRejectedValue(new Error("tool loop exploded"));
    const fallbackDraft = { ...finishedDraft, title: "Recovered" };

    const draft = await generatePageDraftWithWriterTools({
      ...draftOptions(),
      storyState,
      fallback: async () => fallbackDraft
    });

    expect(draft.title).toBe("Recovered");
  });
});
