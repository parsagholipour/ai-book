import { describe, expect, it } from "vitest";
import { runDeterministicManuscriptChecks } from "./manuscriptQuality.js";

const pages = [
  { index: 1, title: "نانِ پشتِ در", markdown: "نانوا سنگک را از تنور بیرون کشید و روی پیشخوان گذاشت." },
  { index: 2, title: "در", markdown: "لید برنجیِ سنگین در کف دستِ باز او بود، покрыیده از گردِ خاکِ زرد." }
];

describe("the compile's foreign-script diagnostic", () => {
  it("lists a leaked word as a warning on its page, and nothing a reader is graded on", () => {
    const issues = runDeterministicManuscriptChecks({ pages, expectedPageCount: 2, language: "fa" })
      .filter((issue) => issue.code === "FOREIGN_SCRIPT");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      severity: "warning",
      affectedPageIndexes: [2],
      message: "Page 2 contains words in a script the book is not written in: \"покрыیده\" (Cyrillic)."
    });
  });

  it("says nothing about an author's own manuscript", () => {
    const issues = runDeterministicManuscriptChecks({ pages, expectedPageCount: 2, language: "fa", authorManuscript: true });
    expect(issues.some((issue) => issue.code === "FOREIGN_SCRIPT")).toBe(false);
  });
});
