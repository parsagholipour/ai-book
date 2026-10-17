import { describe, expect, it } from "vitest";
import {
  applyStoryDelta,
  emptyStoryState,
  formatStoryStateLines,
  rebuildStoryState,
  seedStoryStateFromPromises,
  STORY_STATE_PERSIST_FACTS_CAP,
  STORY_STATE_PERSIST_KNOWS_CAP,
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

});

describe("story state caps", () => {
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
