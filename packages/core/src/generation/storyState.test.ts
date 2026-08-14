import { describe, expect, it } from "vitest";
import { FakeTextModelAdapter, unsupportedGenerateWithTools } from "../adapters/fake.js";
import type { TextModelAdapter } from "../adapters/types.js";
import {
  applyStoryDelta,
  compactStoryStateForExtract,
  emptyStoryState,
  extractStoryState,
  formatStoryStateLines,
  rebuildStoryState,
  seedStoryStateFromPromises,
  STORY_STATE_EXTRACT_FACTS_CAP,
  STORY_STATE_EXTRACT_KNOWS_CAP,
  STORY_STATE_EXTRACT_PAID_PROMISES_CAP,
  STORY_STATE_PERSIST_FACTS_CAP,
  STORY_STATE_PERSIST_KNOWS_CAP,
  unpaidPromiseIssues,
  type StoryDelta,
  type StoryState
} from "./storyState.js";

const openDelta = (text: string): StoryDelta => ({
  promisesOpened: [{ text }],
  promisesPaid: [],
  promisesBroken: [],
  factsAdded: [],
  entities: {},
  unansweredAdded: [],
  unansweredResolved: []
});

const payDelta = (text: string): StoryDelta => ({
  promisesOpened: [],
  promisesPaid: [text],
  promisesBroken: [],
  factsAdded: [],
  entities: {},
  unansweredAdded: [],
  unansweredResolved: []
});

const blankDelta = (overrides: Partial<StoryDelta> = {}): StoryDelta => ({
  promisesOpened: [],
  promisesPaid: [],
  promisesBroken: [],
  factsAdded: [],
  entities: {},
  unansweredAdded: [],
  unansweredResolved: [],
  ...overrides
});

function numberedFacts(count: number, prefix: string): StoryState["facts"] {
  return Array.from({ length: count }, (_, index) => ({
    text: `${prefix}-${index + 1}`,
    pageIndex: index + 1
  }));
}

function capturingExtractModel(): {
  model: TextModelAdapter;
  payload?: Record<string, unknown>;
} {
  const capture: { model: TextModelAdapter; payload?: Record<string, unknown> } = {
    model: {
      async generateText() {
        return { text: "", model: "test-model", provider: "test" };
      },
      async generateJson(options) {
        capture.payload = JSON.parse(options.messages[1]?.content ?? "{}") as Record<string, unknown>;
        return new FakeTextModelAdapter().generateJson(options);
      },
      async *streamText() {
        yield "";
      },
      generateWithTools: unsupportedGenerateWithTools
    }
  };
  return capture;
}

describe("story state apply / rebuild / undo", () => {
  it("assigns the next numeric promise id from the max suffix, not the array length", () => {
    const sparse: StoryState = {
      promises: [
        { id: "p1", text: "Keep the lantern.", status: "open", openedAtPage: 1 },
        { id: "p3", text: "Find the key.", status: "paid", openedAtPage: 1, paidAtPage: 2 }
      ],
      facts: [],
      entities: {},
      unanswered: []
    };
    const next = applyStoryDelta(sparse, blankDelta({ promisesOpened: [{ text: "Ada will reach the river." }] }), 3);
    expect(next.promises.map((promise) => promise.id)).toEqual(["p1", "p3", "p4"]);
  });

  it("applies an extract delta onto seeded plan promises", () => {
    const seeded = seedStoryStateFromPromises(["The lantern will be lit."]);
    const next = applyStoryDelta(
      seeded,
      {
        promisesOpened: [{ text: "Ada will reach the river." }],
        promisesPaid: ["The lantern will be lit."],
        promisesBroken: [],
        factsAdded: ["The lantern is green."],
        entities: { Ada: { location: "the chapel", knows: ["the lantern is green"] } },
        unansweredAdded: ["Who took the key?"],
        unansweredResolved: []
      },
      2
    );

    expect(next.promises).toEqual([
      expect.objectContaining({ text: "The lantern will be lit.", status: "paid", paidAtPage: 2 }),
      expect.objectContaining({ text: "Ada will reach the river.", status: "open", openedAtPage: 2 })
    ]);
    expect(next.facts).toEqual([{ text: "The lantern is green.", pageIndex: 2 }]);
    expect(next.entities.Ada).toMatchObject({ location: "the chapel", updatedAtPage: 2 });
    expect(next.unanswered).toEqual(["Who took the key?"]);
  });

  it("rebuilds from page deltas in index order", () => {
    const seed = seedStoryStateFromPromises(["Find the key."]);
    const rebuilt = rebuildStoryState(
      [
        { pageIndex: 2, delta: payDelta("Find the key.") },
        { pageIndex: 1, delta: { ...openDelta("Ada is late."), factsAdded: ["It is raining."] } }
      ],
      seed
    );

    expect(rebuilt.promises.find((promise) => promise.text === "Find the key.")?.status).toBe("paid");
    expect(rebuilt.facts[0]).toEqual({ text: "It is raining.", pageIndex: 1 });
  });

  it("undoes a page by rebuilding without that page's delta", () => {
    const seed = emptyStoryState();
    const page1: StoryDelta = {
      promisesOpened: [{ id: "p1", text: "Return the book." }],
      promisesPaid: [],
      promisesBroken: [],
      factsAdded: ["The library is closed."],
      entities: { Ada: { location: "the steps" } },
      unansweredAdded: [],
      unansweredResolved: []
    };
    const page2: StoryDelta = {
      promisesOpened: [],
      promisesPaid: ["Return the book."],
      promisesBroken: [],
      factsAdded: ["Ada has the book."],
      entities: { Ada: { location: "home" } },
      unansweredAdded: [],
      unansweredResolved: []
    };

    const withBoth = rebuildStoryState(
      [
        { pageIndex: 1, delta: page1 },
        { pageIndex: 2, delta: page2 }
      ],
      seed
    );
    expect(withBoth.promises[0]?.status).toBe("paid");
    expect(withBoth.entities.Ada?.location).toBe("home");

    const afterUndo = rebuildStoryState([{ pageIndex: 1, delta: page1 }], seed);
    expect(afterUndo.promises[0]?.status).toBe("open");
    expect(afterUndo.entities.Ada?.location).toBe("the steps");
    expect(afterUndo.facts.map((fact) => fact.text)).toEqual(["The library is closed."]);
  });

  it("caps formatted lines for the context-pack entity slice", () => {
    const state: StoryState = {
      promises: Array.from({ length: 8 }, (_, index) => ({
        id: `p${index + 1}`,
        text: `Promise ${index + 1}`,
        status: "open",
        openedAtPage: 1
      })),
      facts: [{ text: "A fact", pageIndex: 1 }],
      entities: { Ada: { knows: ["the map"], location: "town", updatedAtPage: 1 } },
      unanswered: ["Why?"]
    };
    expect(formatStoryStateLines(state).length).toBeLessThanOrEqual(12);
  });

  it("allows unpaid promises mid-book and fails them on the last page", () => {
    const state = seedStoryStateFromPromises(["The door will open."]);
    expect(unpaidPromiseIssues(state, 3, 10)).toEqual([]);
    expect(unpaidPromiseIssues(state, 10, 10)).toEqual([
      "Unpaid promise on the final page: The door will open."
    ]);
    const paidOnLast = applyStoryDelta(state, payDelta("The door will open."), 10);
    expect(unpaidPromiseIssues(paidOnLast, 10, 10)).toEqual([]);
  });
});

describe("extractStoryState", () => {
  it("returns a valid delta from the fake adapter", async () => {
    const result = await extractStoryState({
      textModel: new FakeTextModelAdapter(),
      pageIndex: 1,
      title: "Opening",
      markdown: "Ada lights the lantern.",
      summary: "Ada lights the lantern.",
      currentState: emptyStoryState()
    });
    expect(result.contradictions).toEqual([]);
    expect(result.storyDelta.promisesOpened).toEqual([]);
  });

  it("sends compacted currentState to the model, not the full fact blob", async () => {
    const capture = capturingExtractModel();
    const bloated: StoryState = {
      promises: [
        { id: "still-open", text: "The door will open.", status: "open", openedAtPage: 1 },
        ...Array.from({ length: 30 }, (_, index) => ({
          id: `paid-${index + 1}`,
          text: `Paid promise ${index + 1}`,
          status: "paid" as const,
          openedAtPage: 1,
          paidAtPage: index + 1
        }))
      ],
      facts: numberedFacts(100, "unique-fact"),
      entities: {
        Ada: {
          knows: Array.from({ length: 20 }, (_, index) => `knows-${index + 1}`),
          updatedAtPage: 100
        },
        OldTown: { knows: ["ancient-secret"], location: "ruins", updatedAtPage: 1 }
      },
      unanswered: []
    };

    await extractStoryState({
      textModel: capture.model,
      pageIndex: 101,
      title: "Later",
      markdown: "Ada walks on.",
      summary: "Ada walks on.",
      currentState: bloated
    });

    const sent = JSON.stringify(capture.payload);
    expect(sent).not.toMatch(/"unique-fact-1"/);
    expect(sent).not.toContain("ancient-secret");
    expect(sent).toContain("unique-fact-100");
    expect(sent).toContain("The door will open.");

    const currentState = capture.payload?.currentState as StoryState;
    expect(currentState.facts).toHaveLength(STORY_STATE_EXTRACT_FACTS_CAP);
    expect(currentState.facts[0]?.text).toBe(`unique-fact-${100 - STORY_STATE_EXTRACT_FACTS_CAP + 1}`);
    expect(currentState.entities.Ada?.knows).toHaveLength(STORY_STATE_EXTRACT_KNOWS_CAP);
    expect(currentState.entities.OldTown).toBeUndefined();
    expect(currentState.promises.filter((promise) => promise.status === "paid")).toHaveLength(
      STORY_STATE_EXTRACT_PAID_PROMISES_CAP
    );
  });
});

describe("story state caps", () => {
  it("omits old facts beyond the extract prompt cap", () => {
    const compact = compactStoryStateForExtract({
      promises: [],
      facts: numberedFacts(40, "prompt-fact"),
      entities: {},
      unanswered: []
    });
    expect(compact.facts).toHaveLength(STORY_STATE_EXTRACT_FACTS_CAP);
    expect(compact.facts.map((fact) => fact.text)).toEqual(
      numberedFacts(40, "prompt-fact")
        .slice(-STORY_STATE_EXTRACT_FACTS_CAP)
        .map((fact) => fact.text)
    );
    expect(compact.facts.some((fact) => fact.text === "prompt-fact-1")).toBe(false);
  });

  it("keeps only the last persist-cap facts when applyStoryDelta adds 100", () => {
    const next = applyStoryDelta(
      emptyStoryState(),
      blankDelta({
        factsAdded: Array.from({ length: 100 }, (_, index) => `persist-fact-${index + 1}`)
      }),
      1
    );
    expect(next.facts).toHaveLength(STORY_STATE_PERSIST_FACTS_CAP);
    expect(next.facts[0]?.text).toBe(`persist-fact-${100 - STORY_STATE_PERSIST_FACTS_CAP + 1}`);
    expect(next.facts.at(-1)?.text).toBe("persist-fact-100");
  });

  it("never drops unpaid promises when capping facts or paid promises", () => {
    const seeded = seedStoryStateFromPromises(["The door will open."]);
    const persisted = applyStoryDelta(
      seeded,
      blankDelta({
        factsAdded: Array.from({ length: 100 }, (_, index) => `cap-fact-${index + 1}`)
      }),
      4
    );
    expect(persisted.facts).toHaveLength(STORY_STATE_PERSIST_FACTS_CAP);
    expect(persisted.promises).toEqual([
      expect.objectContaining({ text: "The door will open.", status: "open" })
    ]);

    const compact = compactStoryStateForExtract({
      promises: [
        { id: "still-open", text: "The door will open.", status: "open", openedAtPage: 1 },
        ...Array.from({ length: 20 }, (_, index) => ({
          id: `paid-${index + 1}`,
          text: `Paid ${index + 1}`,
          status: "paid" as const,
          openedAtPage: 1,
          paidAtPage: index + 1
        }))
      ],
      facts: numberedFacts(40, "prompt-fact"),
      entities: {},
      unanswered: []
    });
    expect(compact.promises.filter((promise) => promise.status === "open")).toEqual([
      expect.objectContaining({ id: "still-open", text: "The door will open." })
    ]);
    expect(compact.promises.filter((promise) => promise.status === "paid")).toHaveLength(
      STORY_STATE_EXTRACT_PAID_PROMISES_CAP
    );
    expect(compact.promises.some((promise) => promise.id === "paid-1")).toBe(false);
  });

  it("caps persisted knows per entity, including entities the delta did not touch", () => {
    const bloated: StoryState = {
      promises: [],
      facts: [],
      entities: {
        Ada: {
          knows: Array.from({ length: 20 }, (_, index) => `knows-${index + 1}`),
          updatedAtPage: 1
        }
      },
      unanswered: []
    };
    const next = applyStoryDelta(bloated, blankDelta(), 2);
    expect(next.entities.Ada?.knows).toHaveLength(STORY_STATE_PERSIST_KNOWS_CAP);
    expect(next.entities.Ada?.knows[0]).toBe(`knows-${20 - STORY_STATE_PERSIST_KNOWS_CAP + 1}`);
    expect(next.entities.Ada?.updatedAtPage).toBe(1);
  });
});
