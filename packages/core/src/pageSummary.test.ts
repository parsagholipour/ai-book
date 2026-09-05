import { describe, expect, it } from "vitest";
import { summaryFromMarkdown } from "./pageSummary.js";

describe("summaryFromMarkdown", () => {
  it("returns an empty string for undefined or empty markdown", () => {
    expect(summaryFromMarkdown(undefined)).toBe("");
    expect(summaryFromMarkdown("")).toBe("");
  });

  it("returns short prose unchanged after collapsing whitespace", () => {
    expect(summaryFromMarkdown("The chapel door had been painted black.")).toBe(
      "The chapel door had been painted black."
    );
    expect(summaryFromMarkdown("The chapel  door\nhad been painted.")).toBe(
      "The chapel door had been painted."
    );
  });

  it("strips images and heading hashes, and keeps link text", () => {
    const markdown = [
      "## Heading",
      "",
      "See the [guide](https://example.com/guide) for details.",
      "",
      "![chart](https://example.com/chart.png)",
      "",
      "**Bold** and *italic* and `code`."
    ].join("\n");

    expect(summaryFromMarkdown(markdown)).toBe(
      "Heading See the guide for details. Bold and italic and code."
    );
  });

  it("clips at a word boundary when the last space in the first 240 sits after 160", () => {
    const markdown = Array.from({ length: 42 }, () => "alpha").join(" ");

    expect(summaryFromMarkdown(markdown)).toBe(
      `${Array.from({ length: 40 }, () => "alpha").join(" ")}...`
    );
  });

  it("clips at 240 when a token has no space after 160", () => {
    expect(summaryFromMarkdown("x".repeat(300))).toBe(`${"x".repeat(240)}...`);
  });
});
