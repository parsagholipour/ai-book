import { describe, expect, it, vi } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { createProjectSchema, pageQualityReportSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { reviewPageDraft } from "./pagesReview.js";
import { reviewPageDraftLocally } from "./pagesLocalQa.js";

const input = createProjectSchema.parse({ prompt: "Explain the universal day and its limited scope.", category: "HISTORY", targetPages: 3 });
const markdown = "The universal day begins at mean midnight on the initial meridian. That instant coincides with the beginning of the civil day and date there. Hours are counted from zero to twenty-four. The convention provides a reference for coordination; it does not require every community to set its clocks to the same hour. Local or other standard time can remain in use where desirable. A railway can compare schedules against a common reference while a town retains the clock convention appropriate to its daily work. The conference therefore proposed a way to name and compare a day while preserving that distinction in its stated scope.";
const options = { input, plan: makeFallbackPlan(input), pageIndex: 3, draft: { title: "A universal day", markdown, summary: "A common reference preserves local time.", continuityNotes: [] }, previousPages: [], continuityNotes: [] };

describe("contextual ending review", () => {
  it("does not veto a factual use of beginning before its model review", async () => {
    expect(reviewPageDraftLocally(options)).toMatchObject({ approved: true, checks: { progressionOk: true } });
    const textModel = new FakeTextModelAdapter();
    const generate = vi.spyOn(textModel, "generateJson").mockResolvedValue({ data: pageQualityReportSchema.parse({ approved: true, score: 94, issues: [], requiredRevisions: [] }), text: "", provider: "fake", model: "fake" });
    expect(await reviewPageDraft({ ...options, textModel })).toMatchObject({ approved: true });
    expect(generate).toHaveBeenCalledOnce();
  });

  it("lets contextual judgment reject an unresolved ending instead of guessing from a phrase", async () => {
    const textModel = new FakeTextModelAdapter();
    const generate = vi.spyOn(textModel, "generateJson").mockResolvedValue({ data: pageQualityReportSchema.parse({ approved: false, score: 60, issues: ["The ending fails to fulfill the promised distinction."], requiredRevisions: ["Resolve the distinction between reference time and civil time."] }), text: "", provider: "fake", model: "fake" });
    const result = await reviewPageDraft({ ...options, draft: { ...options.draft, markdown: markdown + " What came next remained unknown." }, textModel });
    expect(generate).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ approved: false, issues: ["The ending fails to fulfill the promised distinction."] });
  });
});
