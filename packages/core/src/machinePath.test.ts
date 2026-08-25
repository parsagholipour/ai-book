import { describe, expect, it } from "vitest";
import { safePathPart } from "./machinePath.js";

describe("safePathPart", () => {
  it("preserves safe ASCII machine identifiers", () => {
    expect(safePathPart("clx1234abcd")).toBe("clx1234abcd");
    expect(safePathPart("generate-image")).toBe("generate-image");
    expect(safePathPart("book.pdf")).toBe("book.pdf");
  });

  it("replaces every unsafe character with an underscore", () => {
    expect(safePathPart("../etc/passwd")).toBe(".._etc_passwd");
    expect(safePathPart("a  b/c")).toBe("a__b_c");
  });

  it("truncates path segments to 120 characters", () => {
    expect(safePathPart("a".repeat(121))).toBe("a".repeat(120));
  });

  it("falls back only when no input remains", () => {
    expect(safePathPart("")).toBe("unknown");
    expect(safePathPart("بهرام")).toBe("_____");
  });
});
