import { describe, expect, it } from "vitest";
import { editManuscriptDevelopment, type DevelopmentEditPlan } from "./developmentalEdit.js";
import { developmentInput, originalDevelopmentPlan, scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

const chapters = [
  { index: 1, title: "First", markdown: "A council considered the claim.\n\nThe report may omit earlier objections.\n\nThe recorded vote was unanimous." },
  { index: 2, title: "Second", markdown: "The record arrived the next morning.\n\nAn appeal reopened the original judgment." }
];
const move: DevelopmentEditPlan = { groups: [{ id: "move", reason: "Keep the uncertainty beside the appeal", changes: [
  { id: "remove", chapterIndex: 1, startParagraph: 2, deleteCount: 1, targetWords: 0, instruction: "Relocate" },
  { id: "insert", chapterIndex: 2, startParagraph: 2, deleteCount: 0, targetWords: 7, instruction: "Retain the exact qualification", sourceParagraphs: [{ chapterIndex: 1, paragraph: 2 }] }
] }] };

async function run(plan: DevelopmentEditPlan, scope = [1, 2], max = 100) {
  const { model, calls } = scriptedDevelopmentModel([plan]);
  const result = await editManuscriptDevelopment({ input: developmentInput, plan: originalDevelopmentPlan(), chapters, wordBudget: { min: 15, target: 40, max }, textModel: model, mode: "extractive", editableChapterIndexes: scope });
  return { result, calls };
}

describe("extractive developmental edits", () => {
  it("does not report a copy of the same paragraph back onto itself as an applied edit", async () => {
    const plan = structuredClone(move);
    plan.groups[0]!.changes = [{ ...plan.groups[0]!.changes[0]!, targetWords: 7, sourceParagraphs: [{ chapterIndex: 1, paragraph: 2 }] }];
    const { result } = await run(plan);
    expect(result.chapters).toEqual(chapters);
    expect(result.appliedGroups).toEqual([]);
    expect(result.rejectedGroups[0]!.reason).toContain("no textual change");
  });

  it("does not empty a chapter even when the whole-book length budget allows the cut", async () => {
    const plan = structuredClone(move);
    plan.groups[0]!.changes = [{ ...plan.groups[0]!.changes[0]!, startParagraph: 1, deleteCount: 3 }];
    const { model } = scriptedDevelopmentModel([plan]);
    const result = await editManuscriptDevelopment({ input: developmentInput, plan: originalDevelopmentPlan(), chapters, wordBudget: { min: 1, target: 40, max: 100 }, textModel: model, mode: "extractive" });
    expect(result.chapters).toEqual(chapters);
    expect(result.rejectedGroups[0]!.reason).toContain("empties a chapter");
  });
  it("rejects a within-chapter cut when only cross-chapter case duplication is allowed", async () => {
    const plan = structuredClone(move);
    plan.groups[0]!.changes = [plan.groups[0]!.changes[0]!];
    plan.groups[0]!.retainedCaseParagraphs = [{ chapterIndex: 1, paragraph: 1 }];
    const { model, calls } = scriptedDevelopmentModel([plan]);
    const result = await editManuscriptDevelopment({ input: developmentInput, plan: originalDevelopmentPlan(), chapters, wordBudget: { min: 1, target: 40, max: 100 }, textModel: model, mode: "extractive", crossChapterCasesOnly: true });
    expect(result.chapters).toEqual(chapters);
    expect(result.rejectedGroups[0]!.reason).toContain("another chapter");
    expect(calls).toHaveLength(1);
  });

  it("protects a unique date inside a passage the planner calls duplicated", async () => {
    const source = [{ ...chapters[0]!, markdown: "The council met.\n\nThe record dates his birth to around 1160.\n\nThe vote remained disputed." }, chapters[1]!];
    const plan = structuredClone(move);
    plan.groups[0]!.changes = [plan.groups[0]!.changes[0]!];
    plan.groups[0]!.retainedCaseParagraphs = [{ chapterIndex: 2, paragraph: 1 }];
    const { model } = scriptedDevelopmentModel([plan]);
    const result = await editManuscriptDevelopment({ input: developmentInput, plan: originalDevelopmentPlan(), chapters: source, wordBudget: { min: 1, target: 40, max: 100 }, textModel: model, mode: "extractive", crossChapterCasesOnly: true });
    expect(result.chapters).toEqual(source);
    expect(result.rejectedGroups[0]!.reason).toContain("numeric detail");
  });

  it("does not delete a paragraph the same linked group names as retained evidence", async () => {
    const plan = structuredClone(move);
    plan.groups[0]!.changes[1] = { ...plan.groups[0]!.changes[0]!, id: "second-cut", chapterIndex: 2, startParagraph: 1 };
    plan.groups[0]!.retainedCaseParagraphs = [{ chapterIndex: 1, paragraph: 1 }, { chapterIndex: 2, paragraph: 1 }];
    const { model } = scriptedDevelopmentModel([plan]);
    const result = await editManuscriptDevelopment({ input: developmentInput, plan: originalDevelopmentPlan(), chapters, wordBudget: { min: 1, target: 40, max: 100 }, textModel: model, mode: "extractive", crossChapterCasesOnly: true });
    expect(result.chapters).toEqual(chapters);
    expect(result.rejectedGroups[0]!.reason).toContain("retained case paragraph");
  });
  it("moves original prose with its uncertainty intact and spends only the planner call", async () => {
    const { result, calls } = await run(move);
    expect(result.appliedGroups).toEqual(["move"]);
    expect(result.chapters[0]!.markdown).toBe("A council considered the claim.\n\nThe recorded vote was unanimous.");
    expect(result.chapters[1]!.markdown).toBe("The record arrived the next morning.\n\nThe report may omit earlier objections.\n\nAn appeal reopened the original judgment.");
    expect(calls.map((call) => call.purpose)).toEqual(["plan-developmental-edit"]);
  });

  it("keeps both ends of a move when a source reference does not exist", async () => {
    const plan = structuredClone(move);
    plan.groups[0]!.changes[1]!.sourceParagraphs = [{ chapterIndex: 1, paragraph: 99 }];
    const { result, calls } = await run(plan);
    expect(result.chapters).toEqual(chapters);
    expect(result.rejectedGroups[0]!.reason).toContain("invalid source paragraph");
    expect(calls).toHaveLength(1);
  });

  it("does not call a writer when an extractive proposal requests generated prose", async () => {
    const plan = structuredClone(move);
    delete plan.groups[0]!.changes[1]!.sourceParagraphs;
    const { result, calls } = await run(plan);
    expect(result.chapters).toEqual(chapters);
    expect(result.rejectedGroups[0]!.reason).toContain("extractive mode");
    expect(calls).toHaveLength(1);
  });

  it("does not relocate a source when its linked destination is outside the editable scope", async () => {
    const { result } = await run(move, [1]);
    expect(result.chapters).toEqual(chapters);
    expect(result.rejectedGroups[0]!.reason).toContain("outside the editable scope");
  });

  it("charges actual copied words to the book budget, not the planner's estimate", async () => {
    const plan = structuredClone(move);
    plan.groups[0]!.changes[1]!.targetWords = 1;
    plan.groups[0]!.changes[1]!.sourceParagraphs = Array.from({ length: 8 }, () => ({ chapterIndex: 2, paragraph: 2 }));
    const { result, calls } = await run(plan, [1, 2], 40);
    expect(result.chapters).toEqual(chapters);
    expect(result.rejectedGroups[0]!.reason).toContain("whole-book word budget");
    expect(calls).toHaveLength(1);
  });
});
