import { describe, expect, it } from "vitest";
import { bookMatterForImportedManuscript, parseManuscript } from "./manuscriptImport.js";
import { parseByline } from "./manuscriptMatterWords.js";

const CREDITS = ["Illustrated by John Smith", "Illustrations by John Smith", "Pictures by John Smith"];

describe("imported illustrator credits", () => {
  it.each(CREDITS)("keeps %s as source text and retains the profile author", async (credit) => {
    const parsed = await parseManuscript({
      data: Buffer.from(`The Long Winter\n${credit}\n\f\nChapter One\n\nBody text.`),
      format: "text"
    });

    expect(parsed.matter?.byline).toBeUndefined();
    expect(parsed.sections.map((section) => section.text).join("\n")).toContain(credit);
    expect(bookMatterForImportedManuscript({ authorName: "Jane Doe" }, parsed.matter).authorName).toBe("Jane Doe");
    expect(parseByline(credit)).toBeNull();
  });

  it.each(CREDITS)("keeps %s after an explicit author", async (credit) => {
    const parsed = await parseManuscript({
      data: Buffer.from(`The Long Winter\nby Jane Doe\n${credit}\n\f\nChapter One\n\nBody text.`),
      format: "text"
    });

    expect(parsed.matter?.byline).toBe("Jane Doe");
    expect(parsed.sections.map((section) => section.text).join("\n")).toContain(credit);
    expect(parsed.matter?.subtitle).not.toBe(credit);
  });

  it.each(CREDITS)("keeps %s before an explicit author", async (credit) => {
    const parsed = await parseManuscript({
      data: Buffer.from(`The Long Winter\n${credit}\nby Jane Doe\n\f\nChapter One\n\nBody text.`),
      format: "text"
    });

    expect(parsed.matter?.byline).not.toBe("John Smith");
    expect(parsed.matter?.subtitle).not.toBe(credit);
    expect(parsed.sections.map((section) => section.text).join("\n")).toContain(credit);
    expect(bookMatterForImportedManuscript({ authorName: "Jane Doe" }, parsed.matter).authorName).toBe("Jane Doe");
  });

  it.each(["Written by", "Text by", "Story by", "Words by"])("still recognizes %s as an author credit", (prefix) => {
    expect(parseByline(`${prefix} Jane Doe`)).toEqual({ name: "Jane Doe" });
  });

  it.each(["A Novel", "Novel", "Memoir", "Poems", "Stories", "Essays", "Tales"])("still recognizes the %s genre lead", (lead) => {
    expect(parseByline(`${lead} by Jane Doe`)).toEqual({ name: "Jane Doe", lead });
  });
});
