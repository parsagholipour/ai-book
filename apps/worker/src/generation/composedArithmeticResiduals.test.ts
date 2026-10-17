import { expect, it } from "vitest";
import { arithmeticErrorIssues, printsStatement } from "./composedEvidenceResiduals.js";

// cmusr57zp p.19 (2026-10-15): the chapter report kept `24^{10}\equiv1` as unresolved, the editor
// then corrected the line, and `includes` found the residual at the start of the corrected statement.
const corrected = String.raw`Alice computes \(24^{10}\) modulo 41; since \(24^2\equiv2\), \(24^4\equiv4\), and \(24^8\equiv16\), \(24^{10}\equiv16\cdot2\equiv32\pmod{41}\), matching Bob’s result.`;
const residual = { quote: String.raw`24^{10}\equiv1`, reason: "24^10 ≡ 4 (mod 7) and 32 (mod 41), but the statement gives 1." };
const brief = (unresolved: unknown[]) => ({ report: { arithmetic: { unresolved } } });

it("does not file a residual found only as the prefix of a corrected statement", () => {
  expect(printsStatement(corrected, residual.quote)).toBe(false);
  expect(arithmeticErrorIssues([{ index: 19, markdown: corrected, chapter: { id: "c", productionBrief: brief([residual]) } }])).toEqual([]);
});

it("does not file a residual the arithmetic no longer finds wrong, even printed whole", () => {
  // A statement that reads as the residual but holds under the section's modulus.
  const markdown = String.raw`Working modulo 41, \(32^4\equiv1\pmod{41}\).`;
  const stale = { quote: String.raw`32^4\equiv1`, reason: "stale" };
  expect(printsStatement(markdown, stale.quote)).toBe(true);
  expect(arithmeticErrorIssues([{ index: 3, markdown, chapter: { id: "c", productionBrief: brief([stale]) } }])).toEqual([]);
});

it("files the real wrong residue with the statement quoted on its page (cmuss9s0w p.19)", () => {
  const markdown = String.raw`The correct public values for these parameters are \(6^{10}\equiv32\) and \(6^{13}\equiv25\pmod{41}\).`;
  const wrong = { quote: String.raw`6^{13}\equiv25`, reason: "6^13 ≡ 6 (mod 7) and 24 (mod 41), but the statement gives 25." };
  expect(arithmeticErrorIssues([{ index: 19, markdown, chapter: { id: "c", productionBrief: brief([wrong]) } }])).toEqual([
    expect.objectContaining({ code: "ARITHMETIC_ERRORS", affectedPageIndexes: [19], evidence: [{ pageIndex: 19, excerpt: wrong.quote }] })
  ]);
});

it("re-checks prose arithmetic from the computation the report stored", () => {
  const quote = "leaves only $290 for everything else";
  const reason = "800 - 1200 - 110 = -510, not 290.";
  const page = (markdown: string) => [{ index: 4, markdown, chapter: { id: "c", productionBrief: brief([{ quote, reason }]) } }];
  expect(arithmeticErrorIssues(page(`From $800, after $1,200 rent and $110 electricity, that ${quote}.`))).toEqual([
    expect.objectContaining({ code: "ARITHMETIC_ERRORS", evidence: [{ pageIndex: 4, excerpt: quote }] })
  ]);
  // The number continued: "$290,000" is not the residual's statement.
  expect(printsStatement("that leaves only $290,000 for everything else", "leaves only $290")).toBe(false);
});
