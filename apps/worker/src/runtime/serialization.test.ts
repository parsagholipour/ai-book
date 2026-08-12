import { describe, expect, it, vi } from "vitest";

// The module imports `Prisma` from the db package purely for a return type, and
// re-exports one helper from core; neither is exercised here, so both are
// stubbed to keep this suite off Prisma's generated client.
vi.mock("@book-maker/db", () => ({ Prisma: {} }));

import { cleanOptionalText, cleanTargetLanguage, range, safeJsonStringify, safePathPart, uniqueStrings } from "./serialization.js";

describe("safePathPart", () => {
  it("passes ASCII identifiers through untouched", () => {
    expect(safePathPart("clx1234abcd")).toBe("clx1234abcd");
    expect(safePathPart("generate-image")).toBe("generate-image");
    expect(safePathPart("book.pdf")).toBe("book.pdf");
  });

  it("substitutes anything outside the safe set", () => {
    expect(safePathPart("../etc/passwd")).toBe(".._etc_passwd");
    expect(safePathPart("a b/c")).toBe("a_b_c");
  });

  it("caps a segment at 120 characters", () => {
    expect(safePathPart("a".repeat(200))).toHaveLength(120);
  });

  it("collapses a wholly non-ASCII value to one name", () => {
    // Pinned because it is a trap, not a feature: two different Persian names
    // are indistinguishable after this, which is why `characterSlug` hashes
    // such a name itself instead of handing it here.
    expect(safePathPart("بهرام")).toBe(safePathPart("کیوان"));
    expect(safePathPart("")).toBe("unknown");
  });
});

describe("safeJsonStringify", () => {
  it("survives a cycle, a bigint and a buffer", () => {
    // The buffer is the one worth pinning: `JSON.stringify` runs `toJSON()`
    // before the replacer, so the compaction only fires if it reads the holder
    // rather than the value it was handed. Without it every logged buffer is a
    // full array of byte literals.
    const node: Record<string, unknown> = { size: 7n, bytes: Buffer.alloc(3) };
    node.self = node;

    expect(JSON.parse(safeJsonStringify(node))).toEqual({
      size: "7",
      bytes: { type: "Buffer", bytes: 3 },
      self: "[Circular]"
    });
  });
});

describe("text helpers", () => {
  it("bounds a target language and drops an empty one", () => {
    expect(cleanTargetLanguage("  Persian ")).toBe("Persian");
    expect(cleanTargetLanguage("   ")).toBeNull();
    expect(cleanTargetLanguage(undefined)).toBeNull();
    expect(cleanTargetLanguage("x".repeat(60))).toHaveLength(40);
  });

  it("collapses whitespace and reads a blank string as absent", () => {
    expect(cleanOptionalText(" a\n  b ")).toBe("a b");
    expect(cleanOptionalText("  ")).toBeUndefined();
    expect(cleanOptionalText(null)).toBeUndefined();
  });

  it("trims, drops blanks and de-duplicates", () => {
    expect(uniqueStrings([" a", "a ", "", "  ", "b"])).toEqual(["a", "b"]);
  });

  it("builds an inclusive range", () => {
    expect(range(2, 5)).toEqual([2, 3, 4, 5]);
    expect(range(3, 3)).toEqual([3]);
  });
});
