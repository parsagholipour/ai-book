import { describe, expect, it } from "vitest";
import type { AuthorStance } from "../schemas/plan.js";
import { planEpisodes } from "./episodes.js";
import { developmentInput, originalDevelopmentPlan, scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

const stance: AuthorStance = {
  thesis: "A verdict is a decision an office made, and the office kept the paper.",
  positions: ["The clerk's fee decided which appeals were heard.", "A jury was paid for its day."],
  refusals: ["No paragraph ends by balancing two sides."],
  voiceSample: "The clerk wrote the fee in the margin before he wrote the verdict."
};

const plan = originalDevelopmentPlan();

/**
 * A valid contribution the old shape rule blanked: it says "rather than" and
 * it is careful about its evidence, and it is a claim about the material.
 */
const CAUTIOUS_CONTRIBUTION =
  "The reader will know that the marshals' refusal to march on Paris forced the abdication rather than the Allied armies alone, and that the only evidence for the Fontainebleau conversation is Caulaincourt's memoir, written years later.";

function episode(title: string, fields: { person?: string; place?: string; date?: string } = {}) {
  return { title, kind: "document", person: fields.person ?? "", place: fields.place ?? "", date: fields.date ?? "", document: "", why: "", searchQueries: [] };
}

/** One person in two chapters, ten years apart: two cases, not one case told twice. */
const CORONATION = episode("Napoleon Bonaparte's coronation", { person: "Napoleon Bonaparte", place: "Notre-Dame, Paris", date: "2 December 1804" });
const ABDICATION = episode("Napoleon Bonaparte's first abdication", { person: "Napoleon Bonaparte", place: "Fontainebleau", date: "6 April 1814" });

function answer() {
  return {
    chapters: [
      { index: 1, episodes: [CORONATION], focus: { question: "How did the first jury reach its verdict?", investigation: ["the sequence of decisions", "the fees paid"], contribution: "The reader will know who paid the jury and when." } },
      {
        index: 2,
        episodes: [episode("A Suffolk assize roll")],
        focus: {
          question: "How was an appeal filed in 1783?",
          investigation: ["the clerk's fee schedule", "the calendar of sittings"],
          contribution: CAUTIOUS_CONTRIBUTION
        }
      },
      {
        index: 3,
        episodes: [ABDICATION, episode("A Norfolk quarter-sessions book")],
        focus: { question: "What did the second trial change?", investigation: ["the second jury's composition", "the damages awarded"], contribution: "The reader will know what the retrial altered." }
      }
    ]
  };
}

function userPayload(call: { messages: Array<{ role: string; content: string }> }) {
  return JSON.parse(call.messages.find((message) => message.role === "user")!.content) as {
    feedback?: string[];
    outputContract?: { chapters?: Array<Record<string, unknown>> };
  };
}

function systemPrompt(call: { messages: Array<{ role: string; content: string }> }) {
  return call.messages.find((message) => message.role === "system")!.content;
}

describe("planEpisodes keeps a valid first answer", () => {
  // The old plan contract re-asked the paid model when two chapters named the
  // same person and when a contribution said "rather than", then dropped the
  // later chapter's episode and blanked the contribution. The coronation and
  // the abdication are two cases; the cautious contribution is a claim.
  it("retains both Napoleon episodes and the cautious contribution, in one call", async () => {
    const { model, calls } = scriptedDevelopmentModel([answer()]);
    const result = await planEpisodes({ input: developmentInput, plan, stance, textModel: model });
    expect(calls).toHaveLength(1);
    expect(userPayload(calls[0]!).feedback).toBeUndefined();
    expect(result.failure).toBeUndefined();
    expect(result.episodes?.chapters[0]!.episodes.map((entry) => entry.title)).toEqual([CORONATION.title]);
    expect(result.episodes?.chapters[2]!.episodes.map((entry) => entry.title)).toEqual([ABDICATION.title, "A Norfolk quarter-sessions book"]);
    expect(result.episodes?.chapters[1]!.focus?.contribution).toBe(CAUTIOUS_CONTRIBUTION);
    expect(result.episodes?.chapters[1]!.focus?.investigation).toEqual(["the clerk's fee schedule", "the calendar of sittings"]);
  });

  it("reports the diagnostics as advisory: never re-asked, nothing dropped or blanked", async () => {
    const { model } = scriptedDevelopmentModel([answer()]);
    const result = await planEpisodes({ input: developmentInput, plan, stance, textModel: model });
    expect(result.contract).toEqual({ reasked: false, issues: 1, collisions: 1, dropped: [], blanked: [] });
  });

  it("passes the caller's own feedback through, and only that", async () => {
    const { model, calls } = scriptedDevelopmentModel([answer()]);
    const feedback = ["Chapter 2 needs a different document: the Suffolk roll is not available."];
    await planEpisodes({ input: developmentInput, plan, stance, textModel: model, feedback });
    expect(calls).toHaveLength(1);
    expect(userPayload(calls[0]!).feedback).toEqual(feedback);
    expect(systemPrompt(calls[0]!)).toContain("Select each case for one chapter only");
  });

  it("still keeps only the plan's chapters and reports an empty answer as a failure", async () => {
    const { model } = scriptedDevelopmentModel([{ chapters: [{ index: 9, episodes: [episode("Nobody's chapter")] }] }]);
    const result = await planEpisodes({ input: developmentInput, plan, stance, textModel: model });
    expect(result.episodes).toBeUndefined();
    expect(result.failure).toBe("no chapter of the plan received episodes");
  });
});

describe("the chapterFocus option", () => {
  const noFocusAnswer = {
    chapters: [1, 2, 3].map((index) => ({ index, episodes: [episode(`Episode ${index}`)] }))
  };

  it("plans no focus at all when the gate is off", async () => {
    const { model, calls } = scriptedDevelopmentModel([noFocusAnswer]);
    const result = await planEpisodes({ input: developmentInput, plan, stance, textModel: model, focus: false });
    expect(calls).toHaveLength(1);
    const system = systemPrompt(calls[0]!);
    expect(system).not.toContain("focus is the chapter's explanatory assignment");
    expect(system).not.toContain("investigation");
    expect(system).toContain("three or four for a chapter of eight or more pages");
    expect(userPayload(calls[0]!).outputContract?.chapters?.[0]).not.toHaveProperty("focus");
    expect(result.episodes?.chapters.every((chapter) => chapter.focus === undefined)).toBe(true);
  });

  it("assigns scenes by material on the unfocused path only", async () => {
    // One told scene in twelve chapters, engagement 6.0 against 7.0: the legacy
    // scene call runs on a `scene` or `portrait` episode, and the planner
    // returned documents and figures nearly everywhere.
    const unfocused = scriptedDevelopmentModel([noFocusAnswer]);
    await planEpisodes({ input: developmentInput, plan, stance, textModel: unfocused.model, focus: false });
    const system = systemPrompt(unfocused.calls[0]!);
    expect(system).toContain("a datable event with a named participant in a named place");
    expect(system).toContain("at least half the chapters carry one scene");
    expect(system).toContain("never a scene in every chapter");
    expect(system).not.toContain("A scene is optional.");
    const focused = scriptedDevelopmentModel([noFocusAnswer]);
    await planEpisodes({ input: developmentInput, plan, stance, textModel: focused.model, focus: true });
    expect(systemPrompt(focused.calls[0]!)).toContain("A scene is optional.");
    expect(systemPrompt(focused.calls[0]!)).not.toContain("at least half the chapters carry one scene");
  });

  it("keeps the focused prompt when the option is omitted or true", async () => {
    const omitted = scriptedDevelopmentModel([noFocusAnswer]);
    await planEpisodes({ input: developmentInput, plan, stance, textModel: omitted.model });
    const explicit = scriptedDevelopmentModel([noFocusAnswer]);
    await planEpisodes({ input: developmentInput, plan, stance, textModel: explicit.model, focus: true });
    expect(systemPrompt(explicit.calls[0]!)).toBe(systemPrompt(omitted.calls[0]!));
    expect(systemPrompt(omitted.calls[0]!)).toContain("focus is the chapter's explanatory assignment");
    expect(userPayload(omitted.calls[0]!).outputContract?.chapters?.[0]).toHaveProperty("focus");
  });
});
