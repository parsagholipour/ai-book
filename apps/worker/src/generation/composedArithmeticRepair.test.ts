import { describe, expect, it, vi } from "vitest";
import { repairChapterArithmetic, arithmeticRepairNotes, type ArithmeticCorrection } from "./composedArithmeticRepair.js";

type Edit = (markdown: string, correction: ArithmeticCorrection) => Promise<string>;

const wrong = "Squaring and reducing: \\[\n128^2=16384\\equiv169\\pmod{187}.\n\\] and then \\[\n128^4\\equiv169^2\\equiv81\\pmod{187}.\n\\] The key is \\(187=11\\cdot17\\).";
const right = wrong.replace("169\\pmod", "115\\pmod").replace("169^2\\equiv81", "115^2\\equiv135");

describe("repairChapterArithmetic", () => {
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

  it("stops after two rounds, the last told to delete the steps, and reports what still fails", async () => {
    const edit = vi.fn<Edit>(async (markdown) => `${markdown} `);
    const repair = await repairChapterArithmetic({ markdown: wrong, edit, degenerate: () => false });
    expect(repair).toMatchObject({ markdown: wrong, findings: 2, repairs: 2 });
    expect(repair!.unresolved.map((residual) => residual.quote)).toEqual(["128^2=16384\\equiv169\\pmod{187}.", "128^4\\equiv169^2\\equiv81\\pmod{187}."]);
    expect(edit.mock.calls[1]![1].instructions[0]).toContain("delete the intermediate steps");
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
