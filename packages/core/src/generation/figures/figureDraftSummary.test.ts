import { describe, expect, it } from "vitest";
import { pageDraftSchema } from "../../schemas/book.js";
import { finalizePageDraft } from "./figureDraftSummary.js";

describe("finalizePageDraft summaries", () => {
  const figureFence =
    "```figure\n" +
    JSON.stringify({
      kind: "bar",
      title: "Share of the workforce in farming",
      categories: ["1900", "1950"],
      series: [{ name: "United States", values: [41, 12] }]
    }) +
    "\n```";
  const prose = "The clerks counted the people every ten years. The towns felt the change first.";

  it("derives a missing summary from figure-free markdown", () => {
    const page = finalizePageDraft(
      pageDraftSchema.parse({
        title: "The farm count",
        markdown: `${prose}\n\n${figureFence}`
      })
    );

    expect(page.summary).toMatch(/clerks counted/i);
    expect(page.summary).not.toMatch(/\{|"kind"|```figure|"categories"|"series"/);
  });

  it("does not store a provided summary that still carries figure JSON", () => {
    const page = finalizePageDraft(
      pageDraftSchema.parse({
        title: "The farm count",
        markdown: `${prose}\n\n${figureFence}`,
        summary: JSON.stringify({
          kind: "bar",
          title: "Share of the workforce in farming",
          categories: ["1900", "1950"],
          series: [{ name: "United States", values: [41, 12] }]
        })
      })
    );

    expect(page.summary).toMatch(/clerks counted/i);
    expect(page.summary).not.toMatch(/\{|"kind"|```figure|"categories"|"series"/);
  });

  it("derives a summary around an indented info-string figure fence", () => {
    const infoFence =
      "  ```figure json\n" +
      JSON.stringify({
        kind: "bar",
        title: "Share of the workforce in farming",
        categories: ["1900", "1950"],
        series: [{ name: "United States", values: [41, 12] }]
      }) +
      "\n  ```";
    const page = finalizePageDraft(
      pageDraftSchema.parse({
        title: "The farm count",
        markdown: `${prose}\n\n${infoFence}`
      })
    );

    expect(page.summary).toMatch(/clerks counted/i);
    expect(page.summary).not.toMatch(/\{|"kind"|```figure|"categories"|"series"/);
  });

  it("derives a summary after an unterminated figure opener", () => {
    const page = finalizePageDraft(
      pageDraftSchema.parse({
        title: "The farm count",
        markdown:
          "```figure\n" +
          JSON.stringify({
            kind: "bar",
            title: "Share of the workforce in farming",
            categories: ["1900", "1950"],
            series: [{ name: "United States", values: [41, 12] }]
          }) +
          `\n\n${prose}`
      })
    );

    expect(page.summary).toMatch(/clerks counted/i);
    expect(page.summary).not.toMatch(/\{|"kind"|```figure|"categories"|"series"/);
  });
});
