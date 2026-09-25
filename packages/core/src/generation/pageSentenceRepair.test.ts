import { describe, expect, it } from "vitest";
import { createProjectSchema, pageQualityReportSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { revisePageDraft, reviewPageDraft } from "./pagesReview.js";
import { sentenceLengthRepairFor } from "./pageSentenceRepair.js";
import { runLocalPageQualityChecks } from "./pagesLocalQa.js";
import { capturingReviewModel } from "./testing/pagesReviewFixtures.js";
import captured from "./testing/balancedSentenceRepair.json" with { type: "json" };

const input = createProjectSchema.parse({ prompt: "Rabbit and Wise Turtle restore the lantern path before moonrise.", category: "KIDS", targetPages: 30, mediaSettings: { audienceAgeRange: "6-8" } });
const plan = makeFallbackPlan(input);
const fixtures = [
  { pageIndex: 16,
    markdown: "Wise Turtle followed the bent grass from the trail to the low side of a fern hollow. One wet leaf pointed the same way. “The lanterns may have drifted downhill,” Wise Turtle said. The hollow held dark ferns and scattered drops, but the friends could not yet see where the lights had stopped.",
    find: "The hollow held dark ferns and scattered drops, but the friends could not yet see where the lights had stopped.",
    replace: "The hollow held dark ferns and scattered drops. The friends could not yet see where the lights had stopped." },
  { pageIndex: 18,
    markdown: "Wise Turtle asked the neighbors to wait at clear spots beside the trail. “Leave room for Rabbit to come back,” Wise Turtle said. The neighbors moved away from the fork and settled where they could see the path. Rabbit hurried into the ferns, with open space for the search ahead.",
    find: "The neighbors moved away from the fork and settled where they could see the path.",
    replace: "The neighbors moved away from the fork. They settled where they could see the path." }
];
const optionsFor = (f = fixtures[0]!) => {
  const draft = { title: "The existing page", markdown: f.markdown, summary: "The existing scene and unresolved search.", imagePrompt: "Keep this existing scene.", continuityNotes: [] };
  const options = { input, plan, pageIndex: f.pageIndex, draft, textModel: capturingReviewModel({}).model, previousPages: [], nextPages: [{ index: 19, title: "The return", markdown: "Rabbit returned carrying two lanterns. Wise Turtle waited beside the trail.", summary: "Rabbit returns." }], continuityNotes: [] };
  const report = runLocalPageQualityChecks(options);
  return { ...options, report, sentenceRepair: { originalMarkdown: draft.markdown, issues: report.issues } };
};

describe("sentence-only final repair", () => {
  it("reviews the captured Balanced ending as a syntax delta with no story-replotting assignment", async () => {
    const draft = captured.originalDraft;
    const options = { input, plan, pageIndex: 30, draft, previousPages: captured.previousPages, continuityNotes: [] };
    const report = runLocalPageQualityChecks({ ...options, textModel: capturingReviewModel({}).model });
    const sentenceRepair = sentenceLengthRepairFor(input, draft, report)!;
    const patchModel = capturingReviewModel(captured.patch);
    const candidate = await revisePageDraft({ ...options, sentenceRepair, report, textModel: patchModel.model });
    const review = capturingReviewModel(pageQualityReportSchema.parse({ approved: true, score: 95 }));
    expect((await reviewPageDraft({ ...options, sentenceRepair, draft: candidate, textModel: review.model })).approved).toBe(true);
    expect(candidate.markdown).toContain("The neighbors pass the last pieces");
    expect(review.system).toContain("Review only the sentence-length repair");
    expect(review.system).not.toContain("including serious defects present before the repair");
    expect(review.payload).not.toHaveProperty("pageBrief");
    expect(review.payload).not.toHaveProperty("chapter");
    expect(review.payload?.sentenceRepair).toEqual(sentenceRepair);
    expect(JSON.stringify(review.payload).length).toBeLessThan(3000);
  });

  it("does not promote a rejected meaning-preservation review or a malformed response to local approval", async () => {
    const options = optionsFor();
    const draft = { ...options.draft, markdown: fixtures[0]!.markdown.replace(fixtures[0]!.find, fixtures[0]!.replace) };
    const review = capturingReviewModel(pageQualityReportSchema.parse({ approved: false, score: 90,
      issues: ["The ending is generally adequate but the original uncertainty has been lost."],
      requiredRevisions: ["Preserve the original uncertainty."], notes: "The syntax repair is adequate." }));
    expect((await reviewPageDraft({ ...options, draft, textModel: review.model })).approved).toBe(false);
    for (const raw of [null, { score: 99, notes: "Looks fine." }]) {
      const malformed = capturingReviewModel(raw);
      await expect(reviewPageDraft({ ...options, draft, textModel: malformed.model })).rejects.toThrow();
    }
  });

  it.each(fixtures)("patches the measured page $pageIndex without replotting the accepted draft", async (f) => {
    const options = optionsFor(f);
    expect(options.report.issues).toHaveLength(1);
    expect(options.report.issues[0]).toContain("Sentences are too long");
    const capture = capturingReviewModel({ patches: [{ find: f.find, replace: f.replace }] });
    const result = await revisePageDraft({ ...options, textModel: capture.model });
    expect(result).toEqual({ ...options.draft, markdown: f.markdown.replace(f.find, f.replace) });
    expect(runLocalPageQualityChecks({ ...options, draft: result }).approved).toBe(true);
    expect(capture.system).not.toContain("Change the actual story or explanation beat");
    expect(capture.payload?.pageMarkdown).toBe(f.markdown);
  });

  it.each(["friends\ncould", "friends  could", "friends\r\n\tcould"])("patches a long sentence without normalizing its raw whitespace: %j", async (wrapped) => {
    const f = fixtures[0]!;
    const markdown = f.markdown.replace("friends could", wrapped);
    const find = f.find.replace("friends could", wrapped);
    const options = optionsFor({ ...f, markdown, find });
    expect(options.report.issues[0]).toContain("Sentences are too long");
    const capture = capturingReviewModel({ patches: [{ find, replace: f.replace }] });
    const result = await revisePageDraft({ ...options, textModel: capture.model });
    expect(capture.payload?.eligibleSentences).toContain(find);
    expect(result).toEqual({ ...options.draft, markdown: markdown.replace(find, f.replace) });
    expect(runLocalPageQualityChecks({ ...options, draft: result }).approved).toBe(true);
  });

  it("retains the whole keeper for a missing span, ambiguous span, or a patch outside an eligible sentence", async () => {
    const options = optionsFor();
    for (const find of ["A span that never existed.", "One wet leaf pointed the same way.", options.draft.markdown]) {
      const capture = capturingReviewModel({ patches: [{ find, replace: "The scene changed." }] });
      expect(await revisePageDraft({ ...options, textModel: capture.model })).toEqual(options.draft);
    }
  });

  it("keeps mixed story defects and explicit reader edits in the ordinary rewrite path", async () => {
    const options = optionsFor();
    expect(sentenceLengthRepairFor(input, options.draft, { ...options.report, issues: [...options.report.issues, "The moon rises before the promised arrival."] })).toBeUndefined();
    const capture = capturingReviewModel(options.draft);
    await revisePageDraft({ ...options, editInstruction: "Move the scene to the riverbank.", textModel: capture.model });
    expect(capture.payload?.editInstruction).toBe("Move the scene to the riverbank.");
    expect(capture.payload?.rejectedDraft).toEqual(options.draft);
  });

  it("cannot escalate an existing sentence repair into a whole-page rewrite after rejection", async () => {
    const options = optionsFor();
    const textModel = capturingReviewModel({}).model;
    textModel.generateJson = async () => { throw new Error("No new writer call is authorized by a semantic rejection"); };
    const result = await revisePageDraft({ ...options, textModel, report: { ...options.report,
      issues: ["The patch removes the unresolved search."], requiredRevisions: ["Restore the original uncertainty."] } });
    expect(result).toEqual(options.draft);
  });

  it("applies no partial patch when another find is invalid or repeated", async () => {
    const options = optionsFor();
    for (const invalid of ["missing", fixtures[0]!.find]) {
      const capture = capturingReviewModel({ patches: [{ find: fixtures[0]!.find, replace: fixtures[0]!.replace }, { find: invalid, replace: "Another event." }] });
      expect(await revisePageDraft({ ...options, textModel: capture.model })).toEqual(options.draft);
    }
    const markdown = `${options.draft.markdown} ${fixtures[0]!.find}`;
    const capture = capturingReviewModel({ patches: [{ find: fixtures[0]!.find, replace: fixtures[0]!.replace }] });
    const draft = { ...options.draft, markdown };
    expect(await revisePageDraft({ ...options, draft, textModel: capture.model })).toEqual(draft);
  });

  it("bounds malformed patch JSON on the existing route without falling back to a whole-page writer", async () => {
    const options = optionsFor();
    const capture = capturingReviewModel({ title: "An unauthorized whole page", markdown: "Replacement scene." });
    let calls = 0;
    const generate = capture.model.generateJson.bind(capture.model);
    capture.model.generateJson = async (request) => {
      calls += 1;
      expect(request.purpose).toBe("revise-page");
      expect(request.messages[0]!.content).toContain("exact sentence replacements");
      return generate(request);
    };
    await expect(revisePageDraft({ ...options, textModel: capture.model })).rejects.toThrow();
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(2);
  });

  it("still rejects a meaning-changing age-passing patch at the actual reviewer", async () => {
    const options = optionsFor();
    const capture = capturingReviewModel({ patches: [{ find: fixtures[0]!.find, replace: "The friends found every lantern. Their search was over." }] });
    const draft = await revisePageDraft({ ...options, textModel: capture.model });
    const review = capturingReviewModel(pageQualityReportSchema.parse({ approved: false, score: 50,
      issues: ["The patch says their search was over, but the next page still searches for lanterns."],
      requiredRevisions: ["Preserve the original uncertainty and ongoing search."], notes: "The rewrite changes causality.",
      checks: { placeholderFree: true, promptLeakFree: true, titleClean: true, repetitionOk: true, progressionOk: false, styleNatural: true } }));
    const report = await reviewPageDraft({ ...options, draft, textModel: review.model });
    expect(report.approved).toBe(false);
    expect(review.payload?.sentenceRepair).toMatchObject({ originalMarkdown: options.draft.markdown });
    expect(report.issues.join(" ")).toContain("search was over");
  });
});
