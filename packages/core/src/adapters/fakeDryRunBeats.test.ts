import { describe, expect, it } from "vitest";
import { evidenceAnchorsCollide } from "../generation/productionMapAnchors.js";
import { dryRunPageBeat, rotate } from "./fakeDryRunBeats.js";

describe("dry-run page beats", () => {
  it("assigns a chapter's worth of pages distinct evidence anchors, so a mock analytical book audits clean", () => {
    const pages = Array.from({ length: 13 }, (_, offset) => dryRunPageBeat(offset + 1));
    for (let later = 1; later < pages.length; later += 1) {
      for (let earlier = 0; earlier < later; earlier += 1) {
        expect(evidenceAnchorsCollide(pages[later]!.evidenceAnchors, pages[earlier]!.evidenceAnchors).collides).toBe(false);
      }
    }
    expect(pages[0]?.claim).toMatch(/shows that/);
  });

  it("names a real table entry for every integer, including zero and negatives", () => {
    expect(rotate(["a", "b", "c"], 0)).toBe("c");
    expect(rotate(["a", "b", "c"], -1)).toBe("b");
    expect(rotate(["a", "b", "c"], 4)).toBe("a");
  });
});
