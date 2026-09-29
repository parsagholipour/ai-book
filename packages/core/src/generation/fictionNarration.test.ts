import { describe, expect, it } from "vitest";
import { buildPageDraftMessages } from "./pageDraftMessages.js";
import { revisePageDraft, reviewPageDraft } from "./pagesReview.js";
import { input, plan, goodMarkdown, capturingReviewModel } from "./testing/pagesReviewFixtures.js";
import incident from "./testing/fictionalEncounterReview.json" with { type: "json" };
import { bookPlanSchema, createProjectSchema, pageDraftSchema } from "../schemas/book.js";

const draft = { title: "The Reserved Window", markdown: goodMarkdown(), summary: "The visitor asks for a reserved table.", continuityNotes: [] };
const report = {
  approved: false, score: 72, issues: ["The opening labels its own scene as invented."],
  requiredRevisions: ['Remove "In this invented scene" and open directly with the action.'], notes: "The scene itself is coherent and grounded.",
  groundedOk: true, unsupportedClaims: [],
  checks: { placeholderFree: true, promptLeakFree: false, titleClean: true, repetitionOk: true, progressionOk: true, styleNatural: false }
};

describe("fiction narration", () => {
  const options = { input, plan, pageIndex: 1, chapter: plan.chapters[0], previousPages: [], continuityNotes: [] };

  it("keeps the actual After the Cameras disclaimer rejection even when the reviewer calls it a style defect", async () => {
    const capture = capturingReviewModel(incident.review);
    const incidentPlan = bookPlanSchema.parse(incident.plan);
    const result = await reviewPageDraft({ ...options, input: createProjectSchema.parse(incident.input),
      plan: incidentPlan, chapter: incidentPlan.chapters[0], draft: pageDraftSchema.parse(incident.draft),
      skipLocalChecks: true, researchNotes: [], textModel: capture.model });
    expect(result.approved).toBe(false);
    expect(result.issues).toEqual(incident.review.issues);
    expect(result.requiredRevisions).toEqual(incident.review.requiredRevisions);
  });

  it("keeps fictional-status notes out of both new drafts and revisions", async () => {
    const capture = capturingReviewModel(draft);
    const messages = buildPageDraftMessages({ ...options, previousSummaries: [], researchNotes: [], textModel: capture.model });
    expect(messages[0]!.content).toContain('"In this invented scene"');
    expect(messages[0]!.content).toContain("internal context, not prose to copy");
    await revisePageDraft({ ...options, draft, report, textModel: capture.model });
    expect(capture.system).toContain('"In this invented scene"');
    expect(capture.system).toContain("internal context, not prose to copy");
  });

  it("retains a contextual fiction-disclaimer rejection even when the scene is otherwise grounded", async () => {
    const capture = capturingReviewModel(report);
    const result = await reviewPageDraft({ ...options, textModel: capture.model,
      draft: { ...draft, markdown: `In this invented scene, ${draft.markdown}` } });
    expect(capture.system).toContain("fictional narration labels its own scene");
    expect(capture.system).toContain("set checks.promptLeakFree=false");
    expect(capture.system).toContain("nonfiction discussion of fiction are not automatic defects");
    expect(result.approved).toBe(false);
    expect(result.checks.promptLeakFree).toBe(false);
    expect(result.issues).toEqual(report.issues);
    expect(result.requiredRevisions).toEqual(report.requiredRevisions);
  });
});
