import { describe, expect, it } from "vitest";
import { arithmeticErrorIssues, storedEvidenceResiduals, unsupportedCaseClaimIssues } from "./composedEvidenceResiduals.js";

const brief = { composition: {}, report: { evidence: { findings: 2, repairs: 2, dropped: 0, unresolved: [{ quote: "in 1085–1086", reason: "The passage dates only the order." }, { quote: "eldest sons", reason: "Not in the passage." }] } } };

describe("residual case findings at compile time", () => {
  it("flags the pages that still carry an unsupported span as an error, and only those", () => {
    const issues = unsupportedCaseClaimIssues([
      { index: 1, markdown: "The survey ran in 1085–1086.", chapter: { productionBrief: brief } },
      { index: 2, markdown: "Succession passed to eldest sons.", chapter: { productionBrief: brief } },
      { index: 3, markdown: "A page that was edited past the claim.", chapter: { productionBrief: brief } },
      { index: 4, markdown: "eldest sons appear here without a chapter report", chapter: { productionBrief: { composition: {} } } }
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "UNSUPPORTED_CASE_CLAIMS", severity: "error", source: "deterministic", affectedPageIndexes: [1, 2] });
    expect(issues[0]!.message).toContain("2 case assertions");
    expect(issues[0]!.message).toContain("in 1085–1086");
  });

  it("flags a wrong numeric statement the repair left standing, on the page that still prints it", () => {
    const statement = "128^2=16384\\equiv169\\pmod{187}.";
    const arithmetic = { composition: {}, report: { arithmetic: { findings: 4, repairs: 2, unresolved: [{ quote: statement, reason: "16384 ≡ 115 (mod 187), but the statement gives 169." }] }, evidence: { findings: 0, repairs: 0, dropped: 0, unresolved: [] } } };
    const issues = arithmeticErrorIssues([
      { index: 21, markdown: `Squaring: \\[\n${statement}\n\\]`, chapter: { productionBrief: arithmetic } },
      { index: 22, markdown: "The reader corrected this page to \\(128^2\\equiv115\\pmod{187}\\).", chapter: { productionBrief: arithmetic } }
    ]);
    expect(issues).toEqual([expect.objectContaining({ code: "ARITHMETIC_ERRORS", severity: "error", source: "deterministic", affectedPageIndexes: [21] })]);
    expect(issues[0]!.message).toContain("1 numeric statement the arithmetic check found wrong");
    expect(issues[0]!.message).toContain("16384 ≡ 115 (mod 187)");
    // The two reviews keep separate residual lists.
    expect(unsupportedCaseClaimIssues([{ index: 21, markdown: statement, chapter: { productionBrief: arithmetic } }])).toEqual([]);
    expect(arithmeticErrorIssues([{ index: 1, markdown: "in 1085–1086", chapter: { productionBrief: brief } }])).toEqual([]);
  });

  it("reports nothing for a book whose chapters carry no residuals or malformed ones", () => {
    expect(unsupportedCaseClaimIssues([{ index: 1, markdown: "x", chapter: null }, { index: 2, markdown: "y" }])).toEqual([]);
    expect(storedEvidenceResiduals({ report: { evidence: { unresolved: [{ quote: "", reason: "r" }, "bad", { quote: "ok", reason: "r" }] } } })).toEqual([{ quote: "ok", reason: "r" }]);
    expect(storedEvidenceResiduals("nope")).toEqual([]);
  });
});
