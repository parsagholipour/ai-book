import { describe, expect, it } from "vitest";
import { bookPlanSchema } from "../schemas/book.js";
import { applyBookDevelopment, bookDevelopmentIssues, developBookPlan, developmentCoverage, chapterCaseEvidence, chapterDevelopmentLines, type BookDevelopment } from "./bookDevelopment.js";
import { developmentInput, originalDevelopmentPlan, evidenceFixture, scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

const plan = originalDevelopmentPlan();
const packet = evidenceFixture();
const dossier = { documents: [], excerpts: packet.excerpts, evidencePackets: [packet] };
function proposal(): BookDevelopment {
  const coverage = developmentCoverage(plan);
  return {
    version: 1, question: "When is a verdict final?", answer: "Appeal can reopen the dispute.", coverage,
    chapters: [
      { index: 1, title: "What the first verdict established", summary: "Combine the claim with the jury's evidence and initial finding", targetPages: 7, keyBeats: ["Who won initially", "Evidence before the jury"], contribution: "Establish what the jury actually decided", requires: [], covers: coverage.slice(0, 4).map(({ id }) => id), caseIds: [packet.id], callbacks: [] },
      { index: 2, title: "The limits of that decision", summary: "Distinguish an initial verdict from disposition on appeal", targetPages: 5, keyBeats: ["Explain the consequence of appeal"], contribution: "Show which questions the appeal reopened", requires: [1], covers: coverage.slice(4).map(({ id }) => id), caseIds: [], callbacks: [{ caseId: packet.id, newInference: "The new trial changes what counts as a final result" }] }
    ]
  };
}

function modelProposal() {
  const development = proposal();
  return { ...development, authorStance: { thesis: development.answer, positions: ["The first verdict does not end the dispute", "Appeal can reopen a factual question"], refusals: [], voiceSample: "The clerk carried the court record into the next room. ".repeat(10) } };
}

describe("research-led chapter development", () => {
  it("merges three chapters into two, renames them and remaps evidence before freezing the plan", async () => {
    const { model } = scriptedDevelopmentModel([modelProposal(), { approved: true, issues: [] }]);
    const developed = await developBookPlan({ input: developmentInput, plan, dossier, textModel: model });
    expect(developed.chapters.map(({ title, targetPages }) => [title, targetPages])).toEqual(proposal().chapters.map(({ title, targetPages }) => [title, targetPages]));
    expect(developed.chapters).toHaveLength(2);
    expect(developed.authorStance?.thesis).toBe(proposal().answer);
    expect(developed.episodes!.chapters[1]!.episodes).toEqual([]);
    expect(chapterCaseEvidence(developed, 2)).toEqual([packet]);
    expect(developed.dossier!.excerpts.map(({ chapterIndex }) => chapterIndex)).toEqual([1, 2]);
    expect(bookPlanSchema.parse(JSON.parse(JSON.stringify(developed))).bookDevelopment).toEqual(developed.bookDevelopment);
  });

  it("adopts the developed answer as the thesis by construction when the model paraphrases it", async () => {
    const paraphrased = modelProposal();
    paraphrased.authorStance.thesis = "An appeal reopens what a verdict seemed to settle.";
    const { model, calls } = scriptedDevelopmentModel([paraphrased, { approved: true, issues: [] }]);
    const developed = await developBookPlan({ input: developmentInput, plan, dossier, textModel: model });
    expect(developed.authorStance?.thesis).toBe(proposal().answer);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1]!.messages[1]!.content).authorStance.thesis).toBe(proposal().answer);
  });

  it("lets a synthesis chapter reason from its prerequisites' cases, and rejects one with nothing to reason from", () => {
    const synthesis = proposal();
    synthesis.chapters[1] = { ...synthesis.chapters[1]!, caseIds: [], callbacks: [], requires: [1] };
    expect(bookDevelopmentIssues(synthesis, [packet], 12)).toEqual([]);
    const developed = applyBookDevelopment(plan, synthesis, dossier);
    expect(chapterCaseEvidence(developed, 2)).toEqual([packet]);
    expect(chapterDevelopmentLines(developed, 2).join(" ")).toContain("owns no verified case");
    expect(chapterDevelopmentLines(developed, 1).join(" ")).not.toContain("owns no verified case");
    const adrift = proposal();
    adrift.chapters[1] = { ...adrift.chapters[1]!, caseIds: [], callbacks: [], requires: [] };
    expect(bookDevelopmentIssues(adrift, [packet], 12).join("; ")).toContain("chapter 2 has no evidence assigned and no prerequisite chapter to reason from");
  });

  it("rejects lost coverage, forward prerequisites, duplicated full treatment and absent research", () => {
    const bad = proposal();
    bad.chapters[0]!.covers = [];
    bad.chapters[0]!.requires = [2];
    bad.chapters[1]!.caseIds = [packet.id];
    const issues = bookDevelopmentIssues(bad, [packet], 12).join("; ");
    expect(issues).toContain("missing requested coverage");
    expect(issues).toContain("forward prerequisite");
    expect(issues).toContain("more than one full treatment");
    expect(bookDevelopmentIssues(proposal(), [], 12).join(" ")).toContain("no reviewed case evidence");
  });

  it("feeds the semantic review's objections back, then records what three attempts could not resolve instead of losing the book", async () => {
    const { model, calls } = scriptedDevelopmentModel([
      modelProposal(), { approved: false, issues: ["The proposed appeal chapter omits the disposition."] },
      modelProposal(), { approved: false, issues: ["The omission remains."] },
      modelProposal(), { approved: false, issues: ["The appeal chapter still promises a disposition the record does not carry."] }
    ]);
    const developed = await developBookPlan({ input: developmentInput, plan, dossier, textModel: model });
    expect(calls.map((call) => call.purpose)).toEqual(["develop-book-plan", "review-book-development", "develop-book-plan", "review-book-development", "develop-book-plan", "review-book-development"]);
    expect(calls[2]!.messages[1]!.content).toContain("omits the disposition");
    expect(calls[4]!.messages[1]!.content).toContain("omission remains");
    expect(developed.bookDevelopment?.reviewNotes).toEqual(["The appeal chapter still promises a disposition the record does not carry."]);
    expect(bookPlanSchema.parse(JSON.parse(JSON.stringify(developed))).bookDevelopment?.reviewNotes).toEqual(developed.bookDevelopment?.reviewNotes);
  });

  it("fails only when no proposal passes the deterministic contract", async () => {
    const adrift = () => { const proposed = modelProposal(); proposed.chapters[1] = { ...proposed.chapters[1]!, caseIds: ["case-invented"], callbacks: [] }; return proposed; };
    const { model, calls } = scriptedDevelopmentModel([adrift(), adrift(), adrift()]);
    await expect(developBookPlan({ input: developmentInput, plan, dossier, textModel: model })).rejects.toThrow("unknown case case-invented");
    expect(calls).toHaveLength(3);
  });

  it("refuses corrupted development metadata instead of silently discarding it on resume", () => {
    const developed = applyBookDevelopment(plan, proposal(), dossier);
    expect(bookPlanSchema.safeParse({ ...developed, bookDevelopment: { version: 99 } }).success).toBe(false);
    expect(bookPlanSchema.safeParse({ ...developed, dossier: { evidencePackets: [{ reviewVersion: 0 }] } }).success).toBe(false);
  });
});
