import { beforeEach, describe, expect, it, vi } from "vitest";
import { MECHANICAL_TEXT_PURPOSES } from "../adapters/modelTiers.js";
import type { ChatMessage } from "../adapters/types.js";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { pageDraftSchema, type CreateProjectInput, type PageDraft } from "../schemas/book.js";
import { GROUNDED_FACTUALITY_RULE, type GeneratePageOptions } from "./pagesShared.js";
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

/** The options the drafting under test handed `runToolLoop`. */
function loopCall(): {
  purpose: string;
  maxModelCalls: number;
  temperature: number;
  messages: ChatMessage[];
  tools: Array<{ name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }>;
} {
  return runToolLoopMock.mock.calls[0]?.[0];
}

/** The tool that loop registered under `name`, or undefined if it registered none. */
function toolFromLoop(name: string) {
  return loopCall().tools.find((tool) => tool.name === name);
}

/** The window the worker loads: the completed pages immediately before this one. */
function recencyWindow(startIndex: number, length = 18) {
  return Array.from({ length }, (_, offset) => ({
    index: startIndex + offset,
    title: `Page ${startIndex + offset}`,
    markdown: `Prose from page ${startIndex + offset}.`,
    summary: `Summary of page ${startIndex + offset}.`
  }));
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

  it("does not skip a page whose window no longer reaches page 1 and can search stored memory", () => {
    expect(
      shouldSkipWriterTools({
        storyState: emptyStoryState(),
        researchNotes: [],
        // Drafting page 200: pages 1-181 are stored and outside the prompt.
        previousPages: recencyWindow(182),
        searchStoredMemory: async () => []
      })
    ).toBe(false);
  });

  it("still skips a late page when the caller injected no memory search", () => {
    expect(
      shouldSkipWriterTools({
        storyState: emptyStoryState(),
        researchNotes: [],
        previousPages: recencyWindow(182)
      })
    ).toBe(true);
  });

  it("still skips while the window reaches page 1, so early pages pay for no tool loop", () => {
    expect(
      shouldSkipWriterTools({
        storyState: emptyStoryState(),
        researchNotes: [],
        // Drafting page 5: pages 1-4 are the window, so a search can only
        // return prose the prompt already carries.
        previousPages: recencyWindow(1, 4),
        searchStoredMemory: async () => []
      })
    ).toBe(true);
  });

  it("gives a late page search_memory even when story state never populated and there was no research", async () => {
    const searchStoredMemory = vi.fn(async () => ["Page 12: the brass key goes under the stairs."]);
    await generatePageDraftWithWriterTools({
      ...draftOptions({
        pageIndex: 200,
        previousPages: recencyWindow(182),
        researchNotes: [],
        searchStoredMemory
      }),
      storyState: emptyStoryState(),
      fallback: async () => {
        throw new Error("fallback should not run");
      }
    });

    expect(loopCall().tools.map((tool) => tool.name)).toContain("search_memory");
  });

  it("falls back on an early page even when a memory search was injected", async () => {
    const searchStoredMemory = vi.fn(async () => ["Page 1: …"]);
    const fallbackDraft = { ...finishedDraft, title: "Fallback" };
    const draft = await generatePageDraftWithWriterTools({
      ...draftOptions({
        pageIndex: 5,
        previousPages: recencyWindow(1, 4),
        researchNotes: [],
        searchStoredMemory
      }),
      storyState: emptyStoryState(),
      fallback: async () => fallbackDraft
    });

    expect(draft.title).toBe("Fallback");
    expect(runToolLoopMock).not.toHaveBeenCalled();
    expect(searchStoredMemory).not.toHaveBeenCalled();
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
    const loop = loopCall();

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
    expect(systemMessage).not.toMatch(/search_memory/);
    expect(userMessage).toBeTruthy();

    const payload = JSON.parse(userMessage) as {
      context?: { system?: string; outline?: string; research?: string };
      characters?: unknown;
      recentPages?: Array<{ excerpt: string }>;
      pageInstruction?: string;
      userContext?: { prompt?: string; styleGuidance?: unknown };
    };

    expect(payload.context?.system).toMatch(/dockside chronicler/i);
    expect(payload.context?.system).toMatch(/Never write 'in this chapter we explore'/i);
    expect(payload.context?.outline).toMatch(/Current chapter/i);
    expect(payload.context?.research).toMatch(/painted black/i);
    expect(payload.userContext?.prompt).toMatch(/Jack The Martyr/i);
    expect(payload.userContext).not.toHaveProperty("styleGuidance");
    expect(payload.characters).toEqual(plan.characters);
    expect(payload).not.toHaveProperty("illustrationPlan");
    expect(payload.recentPages?.[0]?.excerpt).toContain("checkpoint");
    expect(payload.pageInstruction).toMatch(/Write exactly this page/i);
    expect(payload.pageInstruction).not.toContain(GROUNDED_FACTUALITY_RULE);
    expect(
      loop.messages
        .map((message) => message.content)
        .join("\n")
        .split(GROUNDED_FACTUALITY_RULE).length - 1
    ).toBe(1);
  });

  it("feeds compact context into the writer-tool loop's initial messages", async () => {
    await generatePageDraftWithWriterTools({
      ...draftOptions({ pageDraftContextMode: "compact" }),
      storyState,
      fallback: async () => {
        throw new Error("fallback should not run");
      }
    });

    const userMessage = loopCall().messages.find((message) => message.role === "user")?.content ?? "{}";
    const payload = JSON.parse(userMessage) as {
      pageDraftContextMode?: string;
      context?: { memory?: string };
      nearestPriorPage?: { index: number; isDirectHandoff: boolean };
      recentPages?: unknown;
      alreadyCovered?: unknown;
    };

    expect(payload.pageDraftContextMode).toBe("compact");
    expect(payload.context?.memory).toContain("Page 1 — The Checkpoint:");
    expect(payload.nearestPriorPage).toEqual(
      expect.objectContaining({ index: 1, isDirectHandoff: true })
    );
    expect(payload).not.toHaveProperty("recentPages");
    expect(payload).not.toHaveProperty("alreadyCovered");
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

  it("refuses lookup_page for the current page or later without querying storage", async () => {
    const lookupStoredPage = vi.fn(async () => {
      throw new Error("storage should not be queried");
    });
    await generatePageDraftWithWriterTools({
      ...draftOptions({ lookupStoredPage, pageIndex: 10 }),
      storyState,
      fallback: async () => {
        throw new Error("fallback should not run");
      }
    });

    const lookupPage = toolFromLoop("lookup_page");

    await expect(lookupPage?.execute({ pageIndex: 10 })).resolves.toEqual({ error: "No stored page 10." });
    await expect(lookupPage?.execute({ pageIndex: 11 })).resolves.toEqual({ error: "No stored page 11." });
    expect(lookupStoredPage).not.toHaveBeenCalled();
  });

  it("registers search_memory and its instruction only when searchStoredMemory is provided", async () => {
    const searchStoredMemory = vi.fn(async () => ["Page 4: …"]);
    await generatePageDraftWithWriterTools({
      ...draftOptions({ searchStoredMemory }),
      storyState,
      fallback: async () => {
        throw new Error("fallback should not run");
      }
    });

    const loop = loopCall();
    const systemMessage = loop.messages.find((message) => message.role === "system")?.content ?? "";

    expect(loop.tools.map((tool) => tool.name)).toEqual([
      "lookup_page",
      "lookup_entity",
      "search_research",
      "search_memory"
    ]);
    expect(systemMessage).toMatch(
      /Use search_memory to recall an earlier page by meaning or keyword when you need older continuity/
    );
  });

  it("falls back to lookupStoredPage when the requested page is earlier but outside the window", async () => {
    const storedPage = {
      index: 5,
      title: "The Brass Key",
      markdown: "Tomas wrapped the brass key in oilcloth and pocketed it.",
      summary: "Tomas hides the brass key under the stairs."
    };
    const lookupStoredPage = vi.fn(async (pageIndex: number) => (pageIndex === 5 ? storedPage : null));
    await generatePageDraftWithWriterTools({
      ...draftOptions({
        lookupStoredPage,
        pageIndex: 10,
        previousPages: [
          {
            index: 1,
            title: "The Checkpoint",
            markdown: "At the checkpoint, Jack showed the guard the cracked seal.",
            summary: "Jack passes the checkpoint by refusing to hide the seal."
          }
        ]
      }),
      storyState,
      fallback: async () => {
        throw new Error("fallback should not run");
      }
    });

    const lookupPage = toolFromLoop("lookup_page");

    await expect(lookupPage?.execute({ pageIndex: 5 })).resolves.toEqual({
      index: 5,
      title: storedPage.title,
      summary: storedPage.summary,
      excerpt: storedPage.markdown.slice(0, 900)
    });
    expect(lookupStoredPage).toHaveBeenCalledWith(5);
  });

  it("executes search_memory against the injected callback", async () => {
    const searchStoredMemory = vi.fn(async () => ["Page 4: …"]);
    await generatePageDraftWithWriterTools({
      ...draftOptions({ searchStoredMemory }),
      storyState,
      fallback: async () => {
        throw new Error("fallback should not run");
      }
    });

    const searchMemory = toolFromLoop("search_memory");

    await expect(searchMemory?.execute({ query: "brass key" })).resolves.toEqual(["Page 4: …"]);
    expect(searchStoredMemory).toHaveBeenCalledWith("brass key");

    searchStoredMemory.mockResolvedValueOnce([]);
    await expect(searchMemory?.execute({ query: "brass key" })).resolves.toEqual({
      error: "No matching earlier pages."
    });
  });

  it("lets a stopped run out instead of falling back to the ordinary draft path", async () => {
    // The worker's StopRequestedError by shape: packages/core is the leaf of
    // `apps/* -> packages/db -> packages/core` and cannot import the class.
    const stop = Object.assign(new Error("Stopped by user"), { name: "StopRequestedError" });
    runToolLoopMock.mockRejectedValue(stop);
    const fallback = vi.fn(async () => finishedDraft);

    await expect(
      generatePageDraftWithWriterTools({
        ...draftOptions(),
        storyState,
        fallback
      })
    ).rejects.toBe(stop);
    // Falling back would draft the page again and write it against a run the
    // reader already cancelled.
    expect(fallback).not.toHaveBeenCalled();
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
