import { describe, expect, it } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import {
  applyBookArcPages,
  arcChapterLines,
  architectBook,
  bookArcSchema,
  planBookArc,
  repairArcPages,
  repairChapterIndex,
  sharesAnswer
} from "./bookArc.js";

const input = {
  prompt: "A comparative history of aggression",
  category: "EDUCATION",
  targetPages: 24,
  temperature: 0.4,
  language: "en",
  mediaSettings: { illustrationCadence: "none" }
} as unknown as CreateProjectInput;

function fourChapterPlan() {
  return {
    ...makeFallbackPlan(input),
    chapters: [1, 2, 3, 4].map((index) => ({ index, title: `Chapter ${index}`, summary: `Summary ${index}`, keyBeats: [], targetPages: 6 }))
  };
}

const arcFixture = {
  question: "Whether organised violence follows temperament or offices?",
  opponent: { name: "Steven Pinker", work: "The Better Angels of Our Nature", year: 2011, claim: "Violence declined as states grew.", whereRight: "The counts are real.", whereTheBookBreaks: "The counts measure offices, not temperament." },
  answer: "Offices give organised violence its reach and its targets.",
  turn: { chapterIndex: 2, trouble: "A crowd kills without an office.", repair: "The committee is the office." },
  chapters: [
    { index: 1, kind: "method", pages: 5, job: { believesSoFar: "", does: "establish: how a trace becomes a claim.", adds: "The method.", leavesOpen: "Whether offices matter." }, cast: ["Aelius"] },
    { index: 2, kind: "complication", pages: 7, job: { believesSoFar: "That offices give organised violence its reach and targets.", does: "complicate: the crowd.", adds: "The crowd.", leavesOpen: "Who organised it." }, cast: [], dispute: { sideA: { name: "Keeley", claim: "war is old" }, sideB: { name: "Fry", claim: "war is young" }, atStake: "the rate" } },
    { index: 3, kind: "argument", pages: 6, job: { believesSoFar: "That crowds organise themselves.", does: "repair: the committee as an office.", adds: "The committee.", leavesOpen: "" }, cast: [], dispute: { sideA: { name: "Morgan", claim: "the state conquered" }, sideB: { name: "Weatherford", claim: "the state connected" }, atStake: "what conquest was" } },
    { index: 4, kind: "resolution", pages: 6, job: { believesSoFar: "", does: "resolve: the answer through one last case.", adds: "", leavesOpen: "" }, cast: [] }
  ]
};

describe("book arc", () => {
  it("is produced by the architect call, re-cuts the pages and gives each chapter its own lines", async () => {
    const plan = fourChapterPlan();
    const stance = { thesis: "T", positions: ["P1", "P2"], refusals: [], voiceSample: "V" };
    const { arc } = await architectBook({ input, plan, stance, textModel: new FakeTextModelAdapter(input) });
    expect(arc).toBeDefined();
    expect(arc!.chapters).toHaveLength(plan.chapters.length);
    const cut = applyBookArcPages(plan, arc!, input.targetPages);
    expect(cut.applied).toBe(true);
    expect(cut.plan.chapters.reduce((sum, chapter) => sum + chapter.targetPages, 0)).toBe(input.targetPages);
    const middle = plan.chapters[1]!.index;
    const lines = arcChapterLines(arc!, middle).join(" ");
    expect(lines).toContain("What this chapter does");
    expect(lines).toContain("Do not state the book's answer");
    expect(lines).not.toContain(arc!.answer);
    expect(arcChapterLines(arc!, plan.chapters.at(-1)!.index).join(" ")).toContain("resolution");
  });

  it("repairs a cut that does not sum to the book and keeps every chapter within the floor and ceiling", () => {
    expect(repairArcPages([8, 8, 8, 8], 24)).toEqual([6, 6, 6, 6]);
    expect(repairArcPages([10, 3, 3, 3], 24)).toEqual([12, 4, 4, 4]);
    // A residual is spread one page per chapter, largest first, never piled on one.
    expect(repairArcPages([8, 10, 7, 8, 8, 8, 8, 8, 8, 7, 8, 8, 4, 8, 8], 120)).toEqual([9, 11, 7, 9, 9, 8, 8, 8, 8, 7, 8, 8, 4, 8, 8]);
    expect(repairArcPages([20, 20, 20, 20], 120)!.reduce((a, b) => a + b, 0)).toBe(120);
    expect(repairArcPages([1, 1], 1)).toBeUndefined();
    const plan = fourChapterPlan();
    const arc = bookArcSchema.parse({ ...arcFixture, chapters: arcFixture.chapters.map((chapter) => ({ ...chapter, pages: chapter.pages + 1 })) });
    const cut = applyBookArcPages(plan, arc, input.targetPages);
    expect(cut.applied).toBe(true);
    expect(cut.reason).toContain("scaled");
    expect(cut.plan.chapters.reduce((sum, chapter) => sum + chapter.targetPages, 0)).toBe(input.targetPages);
    expect(cut.arc.chapters.map((chapter) => chapter.pages)).toEqual(cut.plan.chapters.map((chapter) => chapter.targetPages));
    const wrongChapters = bookArcSchema.parse({ ...arcFixture, chapters: arcFixture.chapters.slice(0, 2) });
    expect(applyBookArcPages(plan, wrongChapters, input.targetPages).applied).toBe(false);
  });

  it("shows the opponent to the first, the argument and the resolution chapters, and the turn to its chapter and the repair", () => {
    const arc = bookArcSchema.parse(arcFixture);
    expect(arc.chapters[0]!.kind).toBe("method");
    const first = arcChapterLines(arc, 1).join(" ");
    const turn = arcChapterLines(arc, 2).join(" ");
    const argument = arcChapterLines(arc, 3).join(" ");
    const resolution = arcChapterLines(arc, 4).join(" ");
    expect(first).toContain("Steven Pinker, The Better Angels of Our Nature (2011)");
    expect(first).not.toContain("Where the book breaks with them");
    expect(turn).not.toContain("Steven Pinker");
    expect(turn).not.toContain("Keeley");
    expect(argument).toContain("Morgan holds that the state conquered; Weatherford holds that the state connected");
    expect(turn).toContain("runs into trouble: A crowd kills without an office.");
    expect(argument).toContain("Steven Pinker");
    expect(argument).toContain("repairs the trouble");
    expect(repairChapterIndex(arc)).toBe(3);
    expect(resolution).toContain("Where the book breaks with them");
    expect(resolution).not.toContain("Do not state the book's answer");
  });

  it("drops a middle chapter's line that is the answer in other words, and never the question", () => {
    const arc = bookArcSchema.parse(arcFixture);
    expect(sharesAnswer("That offices give organised violence its reach and targets.", arc.answer)).toBe(true);
    expect(sharesAnswer("complicate: the crowd.", arc.answer)).toBe(false);
    const turn = arcChapterLines(arc, 2);
    expect(turn.join(" ")).toContain("The book asks:");
    expect(turn.some((line) => line.includes("What the reader believes by now"))).toBe(false);
    expect(turn.some((line) => line.includes("What this chapter does: complicate"))).toBe(true);
  });

  it("parses a stored arc tolerantly and refuses one that does not parse", () => {
    const plan = fourChapterPlan();
    const arc = bookArcSchema.parse({
      question: "Q?",
      answer: "A.",
      chapters: plan.chapters.map((chapter) => ({ index: chapter.index, kind: "CASE", pages: chapter.targetPages }))
    });
    expect(arc.chapters[0]!.kind).toBe("case");
    expect(planBookArc({ ...plan, bookArc: arc } as never)).toBeDefined();
    expect(planBookArc({ ...plan, bookArc: { question: "" } } as never)).toBeUndefined();
  });
});
