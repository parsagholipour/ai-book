import { describe, expect, it } from "vitest";
import { createProjectSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import type { PictureBookRepairContext } from "./pictureBookRepair.js";
import type { PictureBookReviewCheckpoint, PictureBookReviewOptions } from "./pictureBookReview.js";
import { pictureBookPageReview, pictureBookReviewRowSchema } from "./pictureBookReviewValidation.js";
import { isInheritedRepairFinding, retainUnverifiedRepairPrefix } from "./pictureBookRepairResiduals.js";

function setup() {
  const input = createProjectSchema.parse({ prompt: "Rabbit and Turtle recover lanterns.", category: "KIDS", targetPages: 30 });
  const pages = [1, 2, 3].map(index => ({ index, title: `Scene ${index}`, summary: "", markdown: `Rabbit carried the lantern through scene ${index}. Turtle followed him along the path.` }));
  const checks = { pageModelReview: true, storyExtractAudit: false, styleAuditor: false };
  const context: PictureBookRepairContext = { issues: [{ pageIndexes: [3], messages: ["Simplify the final sentence."] }],
    changes: [{ pageIndex: 3, originalMarkdown: "Original scene three.", reason: "Simplify the final sentence." }] };
  const row = pictureBookReviewRowSchema.parse({ pageIndex: 1, score: 80, storyExtract: null, styleAudit: null, findings: [{
    domain: "prose", basis: "page_prose", category: "continuity", requirementQuote: null,
    message: "The signal is not established.", guidance: "Establish the signal before it is used.",
    quote: "This quotation does not occur in the page.", relatedEvidence: []
  }] });
  const options: PictureBookReviewOptions = { input, plan: makeFallbackPlan(input), pages, checks, repairContext: context,
    chapterBriefs: [], textModel: new FakeTextModelAdapter() };
  const checkpoint: PictureBookReviewCheckpoint = { version: 2, roundsStarted: 2, attemptsUsed: 2, outputWidened: false,
    unresolvedPageIndexes: [1], protocolIssues: [], validationIssues: [], citationRows: [row],
    reviews: pages.slice(1).map(page => pictureBookPageReview(pictureBookReviewRowSchema.parse({
      pageIndex: page.index, score: 95, findings: [], storyExtract: null, styleAudit: null,
      ...(page.index === 3 ? { repairAssessment: { targetResolved: true, meaningPreserved: true, noNewRegressions: true, reason: "Verified." } } : {})
    }), page, checks, input.prompt)) };
  return { options, checkpoint, context, row };
}

describe("inherited findings after a coordinated repair", () => {
  it("retains exhausted quotation-only failures as failed QA without claiming their quotes are evidence", () => {
    const { options, checkpoint, row } = setup();
    const result = retainUnverifiedRepairPrefix(options, checkpoint)!;
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ findings: [], unverifiedFindings: row.findings,
      report: { approved: false, requiredRevisions: [row.findings[0]!.guidance], checks: { progressionOk: false } } });
    expect(result[0]!.report.issues[0]).toContain("Unverified existing concern");
    expect(result[0]!.report.issues[0]).not.toContain(row.findings[0]!.quote);
    expect(checkpoint.reviews).toHaveLength(2);
  });

  it.each(["protocol", "missing", "duplicate", "early", "schema", "checkMismatch", "stale", "target", "dependency", "newContinuity", "requirement", "badRelatedPage", "empty", "extraPending"])(
    "cannot retain a %s failure as an unrelated prefix warning", kind => {
      const { options, checkpoint, context, row } = setup();
      if (kind === "protocol") checkpoint.protocolIssues.push("Unexpected extra row.");
      if (kind === "missing") checkpoint.reviews.pop();
      if (kind === "duplicate") checkpoint.reviews.push(checkpoint.reviews[0]!);
      if (kind === "early") checkpoint.roundsStarted = 1;
      if (kind === "schema") row.storyExtract = "no_changes";
      if (kind === "checkMismatch") checkpoint.reviews[0]!.completedChecks.styleAuditor = true;
      if (kind === "stale") checkpoint.reviews[0]!.draftMarkdown += " Changed.";
      if (kind === "target") context.issues = [{ pageIndexes: [1, 3], messages: ["Resolve both pages."] }];
      if (kind === "dependency") row.findings[0]!.relatedEvidence = [{ pageIndex: 3, quote: options.pages[2]!.markdown }];
      if (kind === "newContinuity") context.changes.push({ pageIndex: 1, originalMarkdown: "Earlier prose.", reason: "Earlier edit." });
      if (kind === "requirement") { row.findings[0]!.basis = "missing_requirement"; row.findings[0]!.requirementQuote = "Rabbit and Turtle recover lanterns."; }
      if (kind === "badRelatedPage") row.findings[0]!.relatedEvidence = [{ pageIndex: 0, quote: "Invalid page reference." }];
      if (kind === "empty") row.findings = [];
      if (kind === "extraPending") checkpoint.unresolvedPageIndexes.push(2);
      expect(retainUnverifiedRepairPrefix(options, checkpoint)).toBeUndefined();
    });

  it("allows unchanged repetition dependencies but requires the complete continuity prefix to precede the first edit", () => {
    const { context, row } = setup();
    const finding = { ...row.findings[0]!, category: "repetition" as const, relatedEvidence: [{ pageIndex: 2, quote: "Unchanged earlier prose." }] };
    expect(isInheritedRepairFinding(finding, 4, context)).toBe(true);
    expect(isInheritedRepairFinding(finding, 4, context, true)).toBe(false);
    expect(isInheritedRepairFinding({ ...finding, category: "continuity" }, 4, context)).toBe(false);
    expect(isInheritedRepairFinding({ ...finding, category: "continuity" }, 1, context)).toBe(true);
    expect(isInheritedRepairFinding({ ...finding, relatedEvidence: [{ pageIndex: 3, quote: "Edited prose." }] }, 4, context)).toBe(false);
  });
});
