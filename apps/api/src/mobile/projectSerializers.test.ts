import { describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());

import { isImportedManuscript } from "@book-maker/core";
import { projectSourceFromMediaSettings } from "./projectSerializers.js";

/**
 * `mediaSettings.mobile.import` records that a book is a manuscript the reader
 * brought in. Two things read it: the label the app shows on the book, and
 * whether the generation pipeline is allowed to rewrite the author's own
 * opening sentence (`isImportedManuscript`, packages/core/.../schemas/mediaSettings.ts).
 * They were two character-identical expressions in two workspaces.
 */
describe("projectSourceFromMediaSettings", () => {
  const cases: Array<{ label: string; mediaSettings: unknown }> = [
    { label: "an imported manuscript", mediaSettings: { mobile: { import: { importId: "imp_1", format: "docx" } } } },
    { label: "a generated book", mediaSettings: { mobile: { bookType: "custom" } } },
    // The shapes the two copies had to agree on character for character: an
    // empty record is not provenance, and neither is a non-object standing
    // where one of the two levels should be.
    { label: "an empty import record", mediaSettings: { mobile: { import: {} } } },
    { label: "a non-object import", mediaSettings: { mobile: { import: "imp_1" } } },
    { label: "a non-object mobile", mediaSettings: { mobile: "imported" } },
    { label: "no mobile record at all", mediaSettings: { includeCover: true } },
    { label: "null mediaSettings", mediaSettings: null },
    { label: "undefined mediaSettings", mediaSettings: undefined }
  ];

  it("labels the book with core's imported-manuscript predicate, not a copy of it", () => {
    for (const { label, mediaSettings } of cases) {
      expect(projectSourceFromMediaSettings(mediaSettings), label).toBe(
        isImportedManuscript(mediaSettings) ? "imported" : "generated"
      );
    }
  });

  it("still answers the two labels the app renders", () => {
    expect(projectSourceFromMediaSettings({ mobile: { import: { importId: "imp_1" } } })).toBe("imported");
    expect(projectSourceFromMediaSettings({ mobile: { import: {} } })).toBe("generated");
    expect(projectSourceFromMediaSettings({})).toBe("generated");
  });
});
