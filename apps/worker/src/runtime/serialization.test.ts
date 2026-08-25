import { describe, expect, it, vi } from "vitest";

// The module imports `Prisma` from the db package purely for a return type, and
// re-exports one helper from core; neither is exercised here, so both are
// stubbed to keep this suite off Prisma's generated client.
vi.mock("@book-maker/db", () => ({ Prisma: {} }));

import { cleanOptionalText, cleanTargetLanguage, safeJsonStringify } from "./serialization.js";

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

});
