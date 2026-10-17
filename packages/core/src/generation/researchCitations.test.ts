import { describe, expect, it } from "vitest";
import { makeFallbackPlan } from "../prompting/templates.js";
import { compileBookMarkdown } from "./markdown.js";
import { readerFacingResearchSources } from "./researchCitations.js";

describe("readerFacingResearchSources", () => {
  it("keeps only linked rows, once per address", () => {
    expect(
      readerFacingResearchSources([
        { title: "Research brief", url: null },
        { title: "Neymargate", url: "https://en.wikipedia.org/wiki/Neymargate" },
        { title: "Neymargate again", url: "https://en.wikipedia.org/wiki/Neymargate/#History" },
        { title: "The Guardian", url: " https://www.theguardian.com/sport/2019 " },
        { title: "", url: "" }
      ])
    ).toEqual([
      { title: "Neymargate", host: "en.wikipedia.org", url: "https://en.wikipedia.org/wiki/Neymargate" },
      { title: "The Guardian", host: "theguardian.com", url: "https://www.theguardian.com/sport/2019" }
    ]);
  });

  it("titles a row by its site when its own title is unusable", () => {
    const [blank, leaked, long, unparsable] = readerFacingResearchSources([
      { title: "  ", url: "https://www.si.com/soccer/a" },
      { title: "Research this for the image prompt", url: "https://heavy.com/b" },
      { title: "x".repeat(121), url: "https://ranker.com/c" },
      { title: "", url: "not a url" }
    ]);
    expect(blank).toMatchObject({ title: "si.com", host: "si.com" });
    expect(leaked).toMatchObject({ title: "heavy.com", host: "heavy.com" });
    expect(long).toMatchObject({ title: "ranker.com" });
    expect(unparsable).toEqual({ title: "Source", host: null, url: "not a url" });
  });

  it("is the list the compiled Sources section prints", () => {
    const researchSources = [
      { title: "Neymargate", url: "https://en.wikipedia.org/wiki/Neymargate", summary: "" },
      { title: "Duplicate", url: "https://en.wikipedia.org/wiki/Neymargate#x", summary: "" },
      { title: "Brief", summary: "No link." },
      { title: "A [bracketed] title", url: "https://example.com/a", summary: "" }
    ];
    const markdown = compileBookMarkdown({
      plan: makeFallbackPlan({
        prompt: "A short history of a footballer.",
        category: "HISTORY",
        targetPages: 1,
        complexity: 5,
        temperature: 0.8,
        language: "en",
        mediaSettings: {
          fullIllustrations: false,
          illustrationCadence: "template-driven",
          includeCover: false,
          coverTemplate: "auto",
          finalReview: true,
          toneProfile: "neutral" as const
        }
      }),
      category: "HISTORY",
      includeSources: true,
      researchSources,
      pages: [{ index: 1, title: "One", markdown: "Page one of the history." }]
    });
    for (const source of readerFacingResearchSources(researchSources)) {
      expect(markdown).toContain(`](${source.url})`);
    }
    expect(markdown.match(/\]\(https:\/\/en\.wikipedia\.org/g)).toHaveLength(1);
    expect(markdown).toContain("[A \\[bracketed\\] title](https://example.com/a)");
  });
});
