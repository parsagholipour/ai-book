import { describe, expect, it } from "vitest";
import { currentCoverAsset } from "./currentCover.js";

const row = (id: string, type: string, day: number) => ({ id, type, createdAt: new Date(Date.UTC(2026, 0, day)) });

describe("currentCoverAsset", () => {
  it("picks the newest COVER row whatever order the rows were loaded in", () => {
    const rows = [row("cover-old", "COVER", 1), row("page-art", "SCENE_ILLUSTRATION", 9), row("cover-new", "COVER", 2)];
    expect(currentCoverAsset(rows)?.id).toBe("cover-new");
    expect(currentCoverAsset([...rows].reverse())?.id).toBe("cover-new");
  });

  it("breaks a createdAt tie by id, so two reads of one tied pair agree", () => {
    const rows = [row("cover-a", "COVER", 1), row("cover-b", "COVER", 1)];
    expect(currentCoverAsset(rows)?.id).toBe("cover-b");
    expect(currentCoverAsset([...rows].reverse())?.id).toBe("cover-b");
  });

  it("finds no cover among rows of other types", () => {
    expect(currentCoverAsset([row("sheet", "CHARACTER_REFERENCE", 1)])).toBeUndefined();
    expect(currentCoverAsset([])).toBeUndefined();
  });
});
