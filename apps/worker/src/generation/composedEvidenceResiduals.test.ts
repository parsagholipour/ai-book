import { describe, expect, it, vi } from "vitest";
// The claim review is off in production (`SOURCE_CLAIM_REVIEW`); these tests keep its dormant path working.
vi.mock("./sourceClaimState.js", async (original) => ({ ...await original<object>(), SOURCE_CLAIM_REVIEW: true }));
import { arithmeticErrorIssues, storedEvidenceResiduals, unsupportedCaseClaimIssues } from "./composedEvidenceResiduals.js";

it("surfaces an unconfirmed computation as review required, without instructing a numeric replacement", () => {
  const quote = "Send six pumps might produce 5";
  // The stored reason carries the computation, which the compile redoes before it files anything.
  const reason = "Check whether this statement uses the proposed calculation: 6 * 1 = 6, not 5. The intent check did not confirm the connection; do not automatically replace the number.";
  const productionBrief = { report: { arithmetic: { unresolved: [{ quote, reason, reviewOnly: true }] } } };
  expect(arithmeticErrorIssues([{ index: 42, markdown: quote, chapter: { productionBrief } }])).toEqual([
    expect.objectContaining({ code: "ARITHMETIC_REVIEW_REQUIRED", severity: "error", affectedPageIndexes: [42],
      guidance: expect.stringContaining("before changing") })
  ]);
  expect(arithmeticErrorIssues([{ index: 42, markdown: "A corrected example.", chapter: { productionBrief } }])).toEqual([]);
});
import { sourceClaimDigest } from "./sourceClaimState.js";

const brief = { composition: {}, report: { evidence: { findings: 2, repairs: 2, dropped: 0, unresolved: [{ quote: "in 1085–1086", reason: "The passage dates only the order." }, { quote: "eldest sons", reason: "Not in the passage." }] } } };

describe("residual case findings at compile time", () => {
  it("cannot reuse a clean review after a later compile repair introduces a new assertion", () => {
    const original = "A hypothetical example follows.";
    const chapter = { productionBrief: { chapterIndex: 1, report: { sourceClaims: { textDigest: sourceClaimDigest(original),
      coverage: { status: "reviewed" }, claims: [] } } } };
    expect(unsupportedCaseClaimIssues([{ index: 1, markdown: original, chapter }])).toEqual([]);
    expect(unsupportedCaseClaimIssues([{ index: 1, markdown: original + " The three authors are listed alphabetically.", chapter }]))
      .toEqual([expect.objectContaining({ code: "SOURCE_VERIFICATION_INCOMPLETE", affectedPageIndexes: [1] })]);
    expect(unsupportedCaseClaimIssues([{ index: 1, markdown: "A hypothetical\n\nexample follows.", chapter }])).toEqual([]);
  });
  it("flags repeated assertions without joining different chapters into a fabricated claim", () => {
    const sourceClaims = { coverage: { status: "reviewed" }, claims: [{ quote: "Listed alphabetically.", status: "contradicted" }] };
    const chapter = (chapterIndex: number) => ({ productionBrief: { chapterIndex, report: { sourceClaims } } });
    const issues = unsupportedCaseClaimIssues([
      { index: 1, markdown: "Listed alphabetically.", chapter: chapter(1) },
      { index: 2, markdown: "Listed alphabetically.", chapter: chapter(1) },
      { index: 3, markdown: "Listed", chapter: chapter(2) },
      { index: 4, markdown: "alphabetically.", chapter: chapter(3) }
    ]);
    expect(issues).toEqual([expect.objectContaining({ affectedPageIndexes: [1, 2] })]);
  });
  it("flags a source claim that crosses a page cut and an incomplete verification", () => {
    const productionBrief = { report: { sourceClaims: { coverage: { status: "incomplete" },
      claims: [{ quote: "The three authors were listed alphabetically.", status: "contradicted", reason: "The order is R, S, A." }] } } };
    const issues = unsupportedCaseClaimIssues([
      { index: 1, markdown: "The three authors", chapter: { productionBrief } },
      { index: 2, markdown: "were listed alphabetically.", chapter: { productionBrief } }
    ]);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "UNSUPPORTED_FACTUAL_CLAIMS", severity: "error", affectedPageIndexes: [1, 2] }),
      expect.objectContaining({ code: "SOURCE_VERIFICATION_INCOMPLETE", severity: "error", affectedPageIndexes: [1, 2] })
    ]));
  });
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
