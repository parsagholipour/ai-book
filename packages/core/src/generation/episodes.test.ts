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

const METHOD_CONTRIBUTION =
  "The reader can distinguish evidence of what a court decided from evidence of what the parties believed, rather than treating them as one record.";

function episode(title: string) {
  return { title, kind: "document", person: "", place: "", date: "", document: "", why: "", searchQueries: [] };
}

function answer(options: { collide: boolean; methodContribution: boolean }) {
  return {
    chapters: [
      { index: 1, episodes: [episode("The Nataruk mass-killing site at Lake Turkana")], focus: { question: "How did the first jury reach its verdict?", investigation: ["the sequence of decisions", "the fees paid"], contribution: "The reader will know who paid the jury and when." } },
      {
        index: 2,
        episodes: [episode("A Suffolk assize roll")],
        focus: {
          question: "How was an appeal filed in 1783?",
          investigation: ["the clerk's fee schedule", "the calendar of sittings"],
          contribution: options.methodContribution ? METHOD_CONTRIBUTION : "The reader will know what an appeal cost and who could pay it."
        }
      },
      {
        index: 3,
        episodes: options.collide
          ? [episode("The Nataruk site at Lake Turkana revisited"), episode("A Norfolk quarter-sessions book")]
          : [episode("A Norfolk quarter-sessions book")],
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

describe("planEpisodes and the plan contract", () => {
  it("re-asks once, naming the method-shaped chapter and the colliding pair", async () => {
    const { model, calls } = scriptedDevelopmentModel([
      answer({ collide: true, methodContribution: true }),
      answer({ collide: false, methodContribution: false })
    ]);
    const result = await planEpisodes({ input: developmentInput, plan, stance, textModel: model });
    expect(calls).toHaveLength(2);
    const feedback = userPayload(calls[1]!).feedback ?? [];
    expect(feedback.some((line) => line.startsWith("Chapter 2: contribution"))).toBe(true);
    expect(feedback.some((line) => line.startsWith("Chapters 1 and 3 both take"))).toBe(true);
    expect(result.contract?.reasked).toBe(true);
    expect(result.contract?.issuesBefore).toBe(1);
    expect(result.contract?.collisionsBefore).toBe(1);
    expect(result.contract?.issuesAfter).toBe(0);
    expect(result.contract?.collisionsAfter).toBe(0);
    expect(result.episodes?.chapters[1]!.focus?.contribution).toBe("The reader will know what an appeal cost and who could pay it.");
  });

  it("makes one call when the first answer honours the contract", async () => {
    const { model, calls } = scriptedDevelopmentModel([answer({ collide: false, methodContribution: false })]);
    const result = await planEpisodes({ input: developmentInput, plan, stance, textModel: model });
    expect(calls).toHaveLength(1);
    expect(userPayload(calls[0]!).feedback).toBeUndefined();
    expect(result.contract).toEqual({ reasked: false, issuesBefore: 0, collisionsBefore: 0, issuesAfter: 0, collisionsAfter: 0, dropped: [], blanked: [] });
  });

  it("cleans a second answer that still violates rather than failing the book", async () => {
    const { model, calls } = scriptedDevelopmentModel([
      answer({ collide: true, methodContribution: true }),
      answer({ collide: true, methodContribution: true })
    ]);
    const result = await planEpisodes({ input: developmentInput, plan, stance, textModel: model });
    expect(calls).toHaveLength(2);
    expect(result.contract?.reasked).toBe(true);
    expect(result.contract?.blanked).toEqual([{ chapterIndex: 2, kind: "contribution" }]);
    expect(result.contract?.dropped).toHaveLength(1);
    expect(result.contract?.dropped[0]!.chapterIndex).toBe(3);
    expect(result.episodes?.chapters[1]!.focus?.contribution).toBe("");
    // The colliding episode goes; chapter 3 keeps the material that is its own.
    expect(result.episodes?.chapters[2]!.episodes.map((entry) => entry.title)).toEqual(["A Norfolk quarter-sessions book"]);
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
