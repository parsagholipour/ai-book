import { describe, expect, it } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { auditPageStyle, withStyleAudit } from "./styleAuditor.js";
import { pageQualityReportSchema } from "../schemas/book.js";

describe("style audit evidence boundary", () => {
  const markdown = "Rabbit passed Wise Turtle a warm bun. The picnic carried on.";
  async function audit(issue: string, category: string, quote: string) {
    const model = new FakeTextModelAdapter();
    model.generateJson = async (options) => ({ data: options.schema.parse({ styleOk: false, styleIssues: [issue], evidence: [{ issue, category, quote }] }), text: "{}", model: "fixture", provider: "fixture" });
    return auditPageStyle({ textModel: model, pageIndex: 30, finalPage: true, markdown,
      voiceGuide: ["Warm and plain."], styleExcerpts: ["The unlit lantern waited for the picnic."] });
  }
  it.each([
    ["The picnic cannot happen because the opening lantern was unlit.", "continuity", "The picnic carried on."],
    ["The ending must introduce an inviting next action.", "next_action", "The picnic carried on."],
    ["Rabbit does nothing.", "scaffold", "Rabbit stood motionless and watched."]
  ])("does not spend a rewrite on out-of-scope or invented evidence: %s", async (issue, category, quote) => {
    const result = await audit(issue, category, quote);
    const reviewed = withStyleAudit(pageQualityReportSchema.parse({ approved: true, score: 91, issues: [], requiredRevisions: [], notes: "A complete ending." }), result);
    expect(reviewed.approved).toBe(true);
    expect(reviewed.requiredRevisions).toEqual([]);
    expect(result.unverifiedStyleIssues).toEqual([issue]);
    expect(reviewed.qualityAdvisories).toEqual([{ check: "style", status: "unverified", message: issue }]);
  });
  it("still rejects an evidenced generic scaffold phrase", async () => {
    const issue = "The closing sentence is a generic summary.";
    const result = await audit(issue, "scaffold", "The picnic carried on.");
    expect(result.styleOk).toBe(false);
    expect(result.styleIssues).toEqual([issue]);
  });
  it("keeps an unexplained negative verdict explicitly unverified", async () => {
    const model = new FakeTextModelAdapter();
    model.generateJson = async (options) => ({ data: options.schema.parse({ styleOk: false, styleIssues: [] }), text: "{}", model: "fixture", provider: "fixture" });
    const result = await auditPageStyle({ textModel: model, markdown, voiceGuide: [], styleExcerpts: [markdown] });
    expect(result.styleIssues).toEqual([]);
    expect(result.unverifiedStyleIssues).toEqual(["Style audit rejected the page without an evidenced finding."]);
  });
});
