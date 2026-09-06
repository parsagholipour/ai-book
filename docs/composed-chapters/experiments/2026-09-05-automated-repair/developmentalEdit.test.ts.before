import { describe, expect, it } from "vitest";
import { applyDevelopmentChanges, developmentEditPlanIssues, editManuscriptDevelopment, type DevelopmentEditPlan } from "./developmentalEdit.js";
import { developmentInput, originalDevelopmentPlan, scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

const chapters = [
  { index: 1, title: "The claim", markdown: "Keep this exact opening.\n\nA repeated explanation belongs later.\n\nKeep this exact closing." },
  { index: 2, title: "Appeal", markdown: "The appeal opens here.\n\nExisting evidence remains in place." }
];
const move: DevelopmentEditPlan = { groups: [{ id: "move", reason: "Put the explanation beside the appeal it explains", changes: [
  { id: "remove", chapterIndex: 1, startParagraph: 2, deleteCount: 1, targetWords: 0, instruction: "Delete the repeated explanation" },
  { id: "insert", chapterIndex: 2, startParagraph: 2, deleteCount: 0, targetWords: 6, instruction: "Insert its useful explanation of the appeal" }
] }] };
const replacements = { replacements: [{ id: "remove", text: "" }, { id: "insert", text: "The appeal reopens this disputed factual question." }] };
const wordBudget = { min: 20, target: 30, max: 50 };

async function edit(responses: unknown[], budget = wordBudget) {
  const { model } = scriptedDevelopmentModel(responses);
  return editManuscriptDevelopment({ input: developmentInput, plan: originalDevelopmentPlan(), chapters, wordBudget: budget, textModel: model });
}

describe("bounded developmental editing", () => {
  it("moves a section between chapters while retaining every unselected paragraph", async () => {
    const result = await edit([move, replacements]);
    expect(result.appliedGroups).toEqual(["move"]);
    expect(result.chapters[0]!.markdown).toBe("Keep this exact opening.\n\nKeep this exact closing.");
    expect(result.chapters[1]!.markdown).toBe("The appeal opens here.\n\nThe appeal reopens this disputed factual question.\n\nExisting evidence remains in place.");
    expect(result.chapters[0]!.markdown.split(/\s+/).length).toBeLessThan(chapters[0]!.markdown.split(/\s+/).length);
    expect(chapters[0]!.markdown).toContain("A repeated explanation belongs later.");
  });

  it("rejects both ends of a move when the destination replacement is missing", async () => {
    const result = await edit([move, { replacements: [{ id: "remove", text: "" }] }]);
    expect(result.appliedGroups).toEqual([]);
    expect(result.rejectedGroups[0]!.id).toBe("move");
    expect(result.chapters).toEqual(chapters);
  });

  it("rejects an overlong replacement or fabricated figure without deleting its source section", async () => {
    for (const text of ["word ".repeat(100), "[Figure: made up] six extra words"]) {
      const result = await edit([move, { replacements: [{ id: "remove", text: "" }, { id: "insert", text }] }]);
      expect(result.chapters).toEqual(chapters);
      expect(result.appliedGroups).toEqual([]);
    }
  });

  it("uses original paragraph coordinates for multiple edits in a chapter", () => {
    const changes = [
      { ...move.groups[0]!.changes[0]!, id: "first", startParagraph: 1, targetWords: 5 },
      { ...move.groups[0]!.changes[0]!, id: "third", startParagraph: 3, targetWords: 3 }
    ];
    const result = applyDevelopmentChanges(chapters, changes, new Map([["first", "First new paragraph.\n\nSecond new paragraph."], ["third", "A new closing."]]));
    expect(result[0]!.markdown).toBe("First new paragraph.\n\nSecond new paragraph.\n\nA repeated explanation belongs later.\n\nA new closing.");
  });

  it("rejects overlapping operations and protects existing figure anchors", () => {
    const duplicate: DevelopmentEditPlan = { groups: [...move.groups, { ...move.groups[0]!, id: "other" }] };
    expect(developmentEditPlanIssues(chapters, duplicate).join(" ")).toContain("overlapping range");
    const withFigure = [{ ...chapters[0]!, markdown: "Keep opening.\n\n[Figure: Trial dates]\n\nKeep closing." }, chapters[1]!];
    expect(developmentEditPlanIssues(withFigure, move).join(" ")).toContain("protected figure");
    const tooMuch = structuredClone(move); tooMuch.groups[0]!.changes[1]!.targetWords = 900;
    expect(developmentEditPlanIssues(chapters, tooMuch).join(" ")).toContain("thirty percent");
  });

  it("rejects the combined edit when it would leave the whole book too short", async () => {
    const cut = { groups: [{ ...move.groups[0], changes: [move.groups[0]!.changes[0]] }] };
    const result = await edit([cut, { replacements: [{ id: "remove", text: "" }] }], { min: 23, target: 30, max: 50 });
    expect(result.chapters).toEqual(chapters);
    expect(result.appliedGroups).toEqual([]);
    expect(result.rejectedGroups[0]!.reason).toContain("whole-book word budget");
  });
});
