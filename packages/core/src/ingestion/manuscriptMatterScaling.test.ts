import { describe, expect, it, vi } from "vitest";
import { separateManuscriptMatter, type MatterSourceSection } from "./manuscriptMatter.js";

function separateWithLookupCount(sections: readonly MatterSourceSection[]) {
  // Count work instead of elapsed time: re-reading every block's outcome for
  // every section froze import preflight even on modestly sized manuscripts.
  const lookups = vi.spyOn(Map.prototype, "get");
  try {
    const result = separateManuscriptMatter(sections);
    return { result, lookups: lookups.mock.calls.length };
  } finally {
    lookups.mockRestore();
  }
}

describe("manuscript matter rebuild scaling", () => {
  it.each([false, true])("reads outcomes in linear work with matter present: %s", (withMatter) => {
    const chapters = Array.from({ length: 200 }, (_, index) => ({
      title: `Chapter ${index + 1}`,
      text: `Snow fell in the valley on day ${index + 1}. The river slept under the ice.`
    }));
    const sections: MatterSourceSection[] = withMatter
      ? [
          { title: "The Long Winter", text: "by Jane Doe" },
          { title: "Dedication", text: "For my mother, who taught me to read." },
          ...chapters,
          { title: "About the Author", text: "Jane Doe lives in Maine with her two dogs." }
        ]
      : chapters;

    const { result, lookups } = separateWithLookupCount(sections);

    expect(result.sections).toEqual(chapters);
    expect(result.removed).toEqual(withMatter ? ["title_page", "dedication", "about_author"] : []);
    if (withMatter) {
      expect(result.bookTitle).toBe("The Long Winter");
      expect(result.matter).toEqual({
        byline: "Jane Doe",
        dedication: "For my mother, who taught me to read.",
        aboutAuthor: "Jane Doe lives in Maine with her two dogs."
      });
    }
    // Leave room for constant extra reads while ruling out sections × blocks.
    expect(lookups).toBeLessThan(sections.length * 10);
  });
});
