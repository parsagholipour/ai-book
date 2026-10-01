import { describe, expect, it, vi } from "vitest";
import { repairChapterArithmetic, arithmeticRepairNotes, type ArithmeticCorrection } from "./composedArithmeticRepair.js";
import { StopRequestedError } from "../runtime/jobTypes.js";

type Edit = (markdown: string, correction: ArithmeticCorrection) => Promise<string>;

const wrong = "Squaring and reducing: \\[\n128^2=16384\\equiv169\\pmod{187}.\n\\] and then \\[\n128^4\\equiv169^2\\equiv81\\pmod{187}.\n\\] The key is \\(187=11\\cdot17\\).";
const right = wrong.replace("169\\pmod", "115\\pmod").replace("169^2\\equiv81", "115^2\\equiv135");

describe("repairChapterArithmetic", () => {
  it("repairs incorrect labeled calculations before they reach pagination", async () => {
    const markdown = "The public value is \\(A=5^6\\bmod23=9\\).";
    const fixed = markdown.replace("=9", "=8");
    const edit = vi.fn<Edit>(async () => fixed);
    expect(await repairChapterArithmetic({ markdown, edit, degenerate: () => false })).toMatchObject({
      markdown: fixed, findings: 1, repairs: 1, unresolved: []
    });
    expect(edit.mock.calls[0]![1].computations).toEqual(["5^6 mod 23 = 8, which is ≡ 8 (mod 23), but the statement gives 9."]);
  });

  it("does nothing, and spends no edit, on a chapter whose arithmetic holds", async () => {
    const edit = vi.fn<Edit>();
    expect(await repairChapterArithmetic({ markdown: right, edit, degenerate: () => false })).toBeUndefined();
    expect(edit).not.toHaveBeenCalled();
  });

  it("hands the editor each wrong statement with the value that makes it true, as a factual correction", async () => {
    const edit = vi.fn<Edit>(async () => right);
    const repair = await repairChapterArithmetic({ markdown: wrong, edit, degenerate: () => false });
    expect(repair).toMatchObject({ markdown: right, findings: 2, repairs: 1, unresolved: [], dropped: 0 });
    const correction = edit.mock.calls[0]![1];
    expect(correction.instructions[0]).toContain("Wrong arithmetic");
    expect(correction.instructions[0]).toContain("recompute the steps that follow");
    expect(correction.instructions.slice(1)).toEqual([
      "“128^2=16384\\equiv169\\pmod{187}.”: 16384 ≡ 115 (mod 187), but the statement gives 169.",
      "“128^4\\equiv169^2\\equiv81\\pmod{187}.”: 128^4 ≡ 135 (mod 187), but the statement gives 169^2 ≡ 137."
    ]);
    expect(correction.computations).toEqual(["16384 ≡ 115 (mod 187), but the statement gives 169.", "128^4 ≡ 135 (mod 187), but the statement gives 169^2 ≡ 137."]);
  });

  it("stops after a repair makes no progress and reports what still fails", async () => {
    const edit = vi.fn<Edit>(async (markdown) => `${markdown} `);
    const repair = await repairChapterArithmetic({ markdown: wrong, edit, degenerate: () => false });
    expect(repair).toMatchObject({ markdown: wrong, findings: 2, repairs: 1 });
    expect(repair!.unresolved.map((residual) => residual.quote)).toEqual(["128^2=16384\\equiv169\\pmod{187}.", "128^4\\equiv169^2\\equiv81\\pmod{187}."]);
    expect(edit).toHaveBeenCalledOnce();
    expect(arithmeticRepairNotes(["x"], true)[0]).toContain("keep only the correct final result");
  });

  it("keeps a partial repair only when fewer statements fail, and never a degenerate one", async () => {
    const partial = wrong.replace("169\\pmod", "115\\pmod");
    const edit = vi.fn<Edit>(async () => partial);
    expect(await repairChapterArithmetic({ markdown: wrong, edit, degenerate: () => false })).toMatchObject({ markdown: partial, repairs: 2, unresolved: [expect.objectContaining({ quote: "128^4\\equiv169^2\\equiv81\\pmod{187}." })] });
    const degenerate = vi.fn<Edit>(async () => right);
    expect(await repairChapterArithmetic({ markdown: wrong, edit: degenerate, degenerate: () => true })).toMatchObject({ markdown: wrong, repairs: 1, unresolved: [expect.anything(), expect.anything()] });
  });
});


it("does not spend a repair on grouped integers from the Balanced RSA chapter", async () => {
  const markdown = String.raw`\[128^2=16\,384.\] \[187\cdot70=13\,090.\]`;
  const edit = vi.fn<Edit>(async () => markdown);
  expect(await repairChapterArithmetic({ markdown, edit, degenerate: () => false })).toBeUndefined();
  expect(edit).not.toHaveBeenCalled();
});

describe("the prose's arithmetic beside the math's", () => {
  const prose = "After rent of $1,200 and electricity of $110 from $800, only $290 remains.";
  const fixedProse = prose.replace("only $290 remains", "the month is $510 short");
  const finding = { quote: "only $290 remains", reason: "800 - 1200 - 110 = -510, not 290." };

  it("repairs a verified prose error, asks once for the first review and again only for the edited text", async () => {
    const proseFindings = vi.fn(async (markdown: string) => (markdown.includes("$290") ? [finding] : []));
    const edit = vi.fn<Edit>(async () => fixedProse);
    const repair = await repairChapterArithmetic({ markdown: prose, edit, degenerate: () => false, proseFindings });
    expect(repair).toMatchObject({ markdown: fixedProse, findings: 1, repairs: 1, unresolved: [] });
    expect(edit.mock.calls[0]![1].computations).toEqual([finding.reason]);
    expect(proseFindings.mock.calls.map(([markdown]) => markdown)).toEqual([prose, fixedProse]);
  });

  it("treats a failed prose check as no findings and lets a stop through", async () => {
    const edit = vi.fn<Edit>();
    expect(await repairChapterArithmetic({ markdown: prose, edit, degenerate: () => false, proseFindings: async () => { throw new Error("provider down"); } })).toBeUndefined();
    const stop = new StopRequestedError();
    await expect(repairChapterArithmetic({ markdown: prose, edit, degenerate: () => false, proseFindings: async () => { throw stop; } })).rejects.toBe(stop);
    expect(edit).not.toHaveBeenCalled();
  });
});
