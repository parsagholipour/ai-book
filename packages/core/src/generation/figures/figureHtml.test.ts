import { describe, expect, it } from "vitest";
import { makeFallbackPlan } from "../../prompting/templates.js";
import type { CreateProjectInput } from "../../schemas/book.js";
import { usesFigures } from "./figureEligibility.js";
import { expandFigureFences, figureHtml, figureRenderContext } from "./figureHtml.js";
import type { ChartFigureSpec } from "./figureSpec.js";

const spec: ChartFigureSpec = {
  kind: "bar",
  title: "Share of the workforce in farming",
  categories: ["1900", "1950", "2000"],
  series: [{ name: "United States", values: [41, 12, 2] }],
  unit: "%",
  source: "US Census Bureau",
  caption: "Farm work as a share of all employment"
};
const fence = "```figure\n" + JSON.stringify(spec) + "\n```";
const before = "The farm counted its people every ten years.";
const after = "The towns felt the change first.";

describe("figureHtml", () => {
  it("wraps the drawing in a figure with a caption naming the source, on lines with no blank line", () => {
    const html = figureHtml(spec, figureRenderContext("en"));
    expect(html.startsWith('<figure class="book-figure" style="margin:1.4em 0;break-inside:avoid;page-break-inside:avoid">')).toBe(true);
    expect(html).toContain("<svg xmlns=");
    expect(html).toContain("<figcaption");
    expect(html).toContain("<strong style=\"color:#0b0b0b\">Share of the workforce in farming.</strong> Farm work as a share of all employment. Source: US Census Bureau.");
    expect(html).not.toContain("\n\n");
    expect(html.endsWith("</figure>")).toBe(true);
  });

  it("marks a right-to-left book's figure and speaks its language in the caption", () => {
    const html = figureHtml(spec, figureRenderContext("Farsi"));
    expect(html).toContain('<figure class="book-figure" style="margin:1.4em 0;break-inside:avoid;page-break-inside:avoid" dir="rtl">');
    expect(html).toContain("منبع: US Census Bureau.");
    expect(html).toContain('aria-label="شکل: Share of the workforce in farming"');
  });
});

describe("expandFigureFences", () => {
  it("returns markdown with no figure byte for byte", () => {
    const markdown = `${before}\n\n\`\`\`python\nprint(1)\n\`\`\`\n\n\n\n${after}`;
    expect(expandFigureFences(markdown, { language: "en" })).toBe(markdown);
  });

  it("replaces a readable block in place and leaves the prose and its spacing alone", () => {
    const markdown = `${before}\n\n${fence}\n\n${after}`;
    const expanded = expandFigureFences(markdown, { language: "en" });
    expect(expanded.startsWith(`${before}\n\n<figure class="book-figure"`)).toBe(true);
    expect(expanded.endsWith(`</figure>\n\n${after}`)).toBe(true);
    expect(expanded).not.toContain("```");
  });

  it("removes an unreadable block with its trailing blank line and draws every readable one", () => {
    const broken = "```figure\n{not json}\n```";
    const markdown = `${before}\n\n${broken}\n\n${fence}\n\n${fence}\n\n${after}`;
    const expanded = expandFigureFences(markdown, { language: "en" });
    expect(expanded).not.toContain("not json");
    expect(expanded.startsWith(`${before}\n\n<figure`)).toBe(true);
    expect((expanded.match(/<figure /g) ?? []).length).toBe(2);
    expect(expanded).not.toContain("\n\n\n");
  });
});

describe("usesFigures", () => {
  const input = (category: CreateProjectInput["category"]): CreateProjectInput => ({
    prompt: "A book about the thing.",
    category,
    targetPages: 24,
    complexity: 5,
    temperature: 0.8,
    language: "en",
    mediaSettings: {
      fullIllustrations: false,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "auto",
      finalReview: true,
      toneProfile: "neutral"
    }
  });

  it("allows analytical, instructional and reference books and refuses fiction and children's books", () => {
    expect(usesFigures(input("HISTORY"), makeFallbackPlan(input("HISTORY")))).toBe(true);
    expect(usesFigures(input("BUSINESS"), makeFallbackPlan(input("BUSINESS")))).toBe(true);
    expect(usesFigures(input("STORY"), makeFallbackPlan(input("STORY")))).toBe(false);
    expect(usesFigures(input("KIDS"), { ...makeFallbackPlan(input("KIDS")), writingMode: "instructional" })).toBe(false);
    expect(usesFigures(input("STORY"), { ...makeFallbackPlan(input("STORY")), writingMode: "instructional" })).toBe(true);
  });
});
