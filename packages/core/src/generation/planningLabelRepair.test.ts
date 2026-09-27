import { describe, expect, it } from "vitest";
import { createProjectSchema, pageQualityReportSchema } from "../schemas/book.js";
import { characterSchema } from "../schemas/plan.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { reviewPageDraft, revisePageDraft } from "./pagesReview.js";
import { reviewPictureBookManuscript } from "./pictureBookReview.js";
import { repairPictureBookManuscript } from "./pictureBookRepair.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

// Premium page 25, captured 2026-09-25. Its plan used L4; the original prose did not.
const originalMarkdown = "Near the creek bridge, Wise Turtle set the fourth lantern on its proper post. Its light shone across the wet boards. Rabbit checked the next patch of ground, then gave a thumbs-up. The neighbors came forward only after the way glowed. They stopped beyond the bridge, with pine shadows rising ahead and one lantern still in Turtle’s care.";
const leakedMarkdown = "At the creek bridge, Wise Turtle set L4 on post four. Its flame warmed the damp boards. Rabbit peered across the bridge to check the path. The neighbors followed the lit ground to the near bank and stopped before the creek light. No one crossed the bridge. Wise Turtle lifted the fifth lantern. The pine rise still lay dark.";
const pageBrief = { pageIndex: 25, chapterIndex: 5, purpose: "Advance the neighbors safely",
  beat: "Turtle sets L4 at post four as Rabbit checks the route; neighbors follow only the lit stretch.",
  requiredContinuity: ["L4 is restored to post four; the neighbors remain behind the lit path."],
  endingPressure: "Will the final post be reached in time?" };
const input = createProjectSchema.parse({ prompt: "Rabbit and Wise Turtle restore the lantern path. Use their established names.",
  category: "KIDS", targetPages: 30, mediaSettings: { fullIllustrations: false, includeCover: false } });
const plan = { ...makeFallbackPlan(input), characters: [characterSchema.parse("Rabbit"), characterSchema.parse("Wise Turtle")] };
const draft = { title: "Creek-Side Glow", markdown: leakedMarkdown, summary: "The neighbors wait at the near bank.", continuityNotes: [] };
const options = { input, plan, pageIndex: 25, pageBrief, draft, previousPages: [], continuityNotes: [], skipLocalChecks: true };
const leakReport = pageQualityReportSchema.parse({ approved: false, score: 90,
  notes: "The prose is natural except for the planning shorthand.",
  issues: ['The page is otherwise acceptable, but "set L4 on post four" exposes planning shorthand.'],
  requiredRevisions: ['Restore "the fourth lantern" without undoing the corrected near-bank position.'],
  checks: { promptLeakFree: false } });
const finding = { domain: "prose", basis: "page_prose", requirementQuote: null, category: "prompt_leak",
  message: "The repair substituted internal L4 for the established fourth lantern.",
  guidance: 'Use "the fourth lantern" while keeping the neighbors on the near bank.',
  quote: "Wise Turtle set L4 on post four.", relatedEvidence: [] };

describe("contextual planning-label repairs", () => {
  it("does not promote an explicit leak rejection to approval because other prose is acceptable", async () => {
    const { model, calls } = scriptedDevelopmentModel([leakReport]);
    const report = await reviewPageDraft({ ...options, textModel: model });
    expect(calls).toHaveLength(1);
    expect(report).toMatchObject({ approved: false, checks: { promptLeakFree: false }, requiredRevisions: leakReport.requiredRevisions });
  });

  it("gives the existing reviewer original prose and canon for distinguishing shorthand from names", async () => {
    const { model, calls } = scriptedDevelopmentModel([leakReport]);
    await reviewPageDraft({ ...options, repairOriginalMarkdown: originalMarkdown, textModel: model });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.messages[1]!.content)).toMatchObject({
      brief: input.prompt, book: { characterNames: plan.characters.map((character) => character.name) }, repairOriginalMarkdown: originalMarkdown,
      draft: { markdown: leakedMarkdown }, pageBrief
    });
    expect(calls[0]!.messages[0]!.content).toContain("planning shorthand");
    expect(calls[0]!.messages[0]!.content).toContain("legitimate alphanumeric");
  });

  it("briefs page and manuscript repair calls to preserve established reader names", async () => {
    const corrected = { ...draft, markdown: leakedMarkdown.replace("L4", "the fourth lantern") };
    const page = scriptedDevelopmentModel([corrected]);
    expect(await revisePageDraft({ ...options, draft: { ...draft, markdown: originalMarkdown }, report: leakReport, textModel: page.model })).toEqual(corrected);
    const manuscript = scriptedDevelopmentModel([{ pages: [] }]);
    await repairPictureBookManuscript({ input, plan, pages: [{ ...draft, index: 25 }],
      issues: [{ pageIndexes: [25], messages: leakReport.issues }], textModel: manuscript.model });
    for (const { calls } of [page, manuscript]) {
      expect(calls).toHaveLength(1);
      expect(calls[0]!.messages[0]!.content).toContain("established reader-facing names");
      expect(calls[0]!.messages[0]!.content).toContain("legitimate alphanumeric");
    }
  });

  it("carries an exact quoted manuscript leak into a failing quality check in one call", async () => {
    const { model, calls } = scriptedDevelopmentModel([{ pages: [{ pageIndex: 25, score: 90, findings: [finding], storyExtract: null, styleAudit: null,
      repairAssessment: { targetResolved: true, meaningPreserved: false, noNewRegressions: false, reason: "The bridge correction introduced internal planning shorthand." } }] }]);
    const reviews = await reviewPictureBookManuscript({ input, plan, pages: [{ ...draft, index: 25 }], chapterBriefs: [],
      checks: { pageModelReview: true, storyExtractAudit: false, styleAuditor: false }, textModel: model,
      repairContext: { issues: [{ pageIndexes: [25], messages: ["Keep the neighbors on the near bank."] }],
        changes: [{ pageIndex: 25, originalMarkdown, reason: "Correct the bridge transition." }] } });
    expect(calls).toHaveLength(1);
    expect(reviews[0]!.report).toMatchObject({ approved: false, checks: { promptLeakFree: false }, requiredRevisions: [finding.guidance] });
    expect(reviews[0]!.report.issues[0]).toContain(finding.quote);
    expect(calls[0]!.messages[0]!.content).toContain("planning shorthand");
  });

  it.each(["L4", "R2-D2", "B12"])("preserves a contextually valid %s without a lexical veto", async (name) => {
    const namedPlan = { ...plan, characters: [characterSchema.parse({ name, description: `A robot named ${name}.` })] };
    const namedDraft = { ...draft, markdown: `${name} held the lantern while Rabbit tied the rope. Together they crossed the creek and waited for Turtle.` };
    const { model, calls } = scriptedDevelopmentModel([pageQualityReportSchema.parse({ approved: true, score: 95, issues: [], requiredRevisions: [] })]);
    expect(await reviewPageDraft({ ...options, plan: namedPlan, draft: namedDraft, textModel: model })).toMatchObject({ approved: true, checks: { promptLeakFree: true } });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.messages[1]!.content).draft.markdown).toBe(namedDraft.markdown);
  });
});
