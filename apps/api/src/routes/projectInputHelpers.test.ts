import { describe, expect, it } from "vitest";
import { safePathPart } from "./projectInputHelpers.js";

describe("project input safePathPart", () => {
  it("uses the human-facing hyphen policy for unsafe characters", () => {
    expect(safePathPart("  chapter art/final  ")).toBe("chapter-art-final");
  });

  it("truncates names and falls back to asset", () => {
    expect(safePathPart("a".repeat(121))).toBe("a".repeat(120));
    expect(safePathPart("")).toBe("asset");
    expect(safePathPart("بهرام")).toBe("asset");
  });
});
