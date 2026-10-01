import { describe, expect, it } from "vitest";

import { generatedPagePreview, markdownPlainText } from "./support.js";

describe("the book page's preview text", () => {
  it("ends a heading's sentence instead of running it into the next one", () => {
    // Dinner Week page 1 previewed as "The evening dinner keeps slipping It is Sunday".
    const markdown = "### The evening dinner keeps slipping\nIt is Sunday evening, and Jordan has the calendar open.";
    expect(markdownPlainText(markdown)).toBe(
      "The evening dinner keeps slipping. It is Sunday evening, and Jordan has the calendar open."
    );
  });

  it("keeps hyphens and underscores that belong to words", () => {
    expect(markdownPlainText("A one-hour session for well-drained pots, file_name kept.")).toBe(
      "A one-hour session for well-drained pots, file_name kept."
    );
  });

  it("reads a table as its cells and drops fences and markup", () => {
    const markdown = [
      "Use this **boundary card** first.",
      "| Planning choice | Household limit |",
      "| --- | --- |",
      "| Budget | Set a weekly limit |",
      "```figure",
      '{"kind":"bar"}',
      "```",
      "- *Check* the [calendar](http://example.com)"
    ].join("\n");
    expect(markdownPlainText(markdown)).toBe(
      "Use this boundary card first. Planning choice · Household limit Budget · Set a weekly limit Check the calendar"
    );
  });

  it("falls back to the summary for a page with no prose", () => {
    expect(generatedPagePreview("```figure\n{}\n```", "A chart of the week.")).toBe("A chart of the week.");
  });
});
