import { describe, expect, it } from "vitest";
import { EVIDENCE_REPAIR_ROUNDS, evidenceRepairNotes, parseEvidenceFinding, repairChapterEvidence } from "./composedEvidenceRepair.js";

const finding = (quote: string, reason = "The passage does not say so.") => `“${quote}”: ${reason}`;

function scripted(reviews: Array<{ issues: string[]; dropped?: string[] }>, edits: string[]) {
  const seen: { reviewed: string[]; notes: string[][] } = { reviewed: [], notes: [] };
  const review = async (markdown: string) => { seen.reviewed.push(markdown); const next = reviews.shift(); if (!next) throw new Error("unexpected review"); return { issues: next.issues, dropped: next.dropped ?? [] }; };
  const edit = async (_markdown: string, notes: string[]) => { seen.notes.push(notes); const next = edits.shift(); if (next === undefined) throw new Error("unexpected edit"); return next; };
  return { review, edit, seen };
}

describe("bounded chapter evidence repair", () => {
  it("leaves a clean chapter alone", async () => {
    const { review, edit, seen } = scripted([{ issues: [] }], []);
    const result = await repairChapterEvidence({ markdown: "Clean.", review, edit, degenerate: () => false });
    expect(result).toEqual({ markdown: "Clean.", findings: 0, repairs: 0, unresolved: [], dropped: 0 });
    expect(seen.notes).toEqual([]);
  });

  it("keeps a narrowed repair that clears the findings", async () => {
    const { review, edit, seen } = scripted([{ issues: [finding("in 1086")] }, { issues: [] }], ["The survey took a year."]);
    const result = await repairChapterEvidence({ markdown: "The survey ended in 1086.", review, edit, degenerate: () => false });
    expect(result).toEqual({ markdown: "The survey took a year.", findings: 1, repairs: 1, unresolved: [], dropped: 0 });
    expect(seen.notes[0]![0]).toContain("Narrow the span");
    expect(seen.notes[0]![1]).toBe(finding("in 1086"));
  });

  it("records what two rounds cannot clear instead of throwing, and the last round orders a deletion", async () => {
    const { review, edit, seen } = scripted(
      [{ issues: [finding("in 1086"), finding("eldest sons")] }, { issues: [finding("eldest sons")] }, { issues: [finding("eldest sons")] }],
      ["narrowed once", "narrowed twice"]
    );
    const result = await repairChapterEvidence({ markdown: "original", review, edit, degenerate: () => false });
    expect(result.markdown).toBe("narrowed once");
    expect(result.repairs).toBe(EVIDENCE_REPAIR_ROUNDS);
    expect(result.findings).toBe(2);
    expect(result.unresolved).toEqual([{ quote: "eldest sons", reason: "The passage does not say so." }]);
    expect(seen.notes[1]![0]).toContain("Delete the unsupported detail outright");
    expect(seen.reviewed).toEqual(["original", "narrowed once", "narrowed twice"]);
  });

  it("keeps the previous text when a repair makes no progress or degenerates", async () => {
    const worse = scripted([{ issues: [finding("a")] }, { issues: [finding("a"), finding("b")] }, { issues: [finding("a")] }], ["worse", "same"]);
    const result = await repairChapterEvidence({ markdown: "original", review: worse.review, edit: worse.edit, degenerate: () => false });
    expect(result.markdown).toBe("original");
    expect(result.unresolved).toEqual([{ quote: "a", reason: "The passage does not say so." }]);
    const broken = scripted([{ issues: [finding("a")] }], ["loop loop loop"]);
    const kept = await repairChapterEvidence({ markdown: "original", review: broken.review, edit: broken.edit, degenerate: (text) => text.startsWith("loop") });
    expect(kept).toEqual({ markdown: "original", findings: 1, repairs: 1, unresolved: [{ quote: "a", reason: "The passage does not say so." }], dropped: 0 });
  });

  it("counts findings the reviewer could not re-quote", async () => {
    const { review, edit } = scripted([{ issues: [], dropped: [finding("gone")] }], []);
    expect((await repairChapterEvidence({ markdown: "x", review, edit, degenerate: () => false })).dropped).toBe(1);
  });

  it("parses the reviewer's format and tolerates a bare string", () => {
    expect(parseEvidenceFinding(finding("a “quoted” span", "why"))).toEqual({ quote: "a “quoted” span", reason: "why" });
    expect(parseEvidenceFinding("bare")).toEqual({ quote: "bare", reason: "" });
    expect(evidenceRepairNotes(["x"], false)).toHaveLength(2);
  });
});
