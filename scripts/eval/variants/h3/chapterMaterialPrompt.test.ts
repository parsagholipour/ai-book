// node --import tsx --test scripts/eval/variants/h3/*.test.ts
import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import { chapterMaterialPrompt, chapterMaterialSections } from "./chapterMaterialPrompt.ts";

const bytes = (text: string) => new TextEncoder().encode(text).length;

describe("chapterMaterialPrompt", () => {
  it("opens by asking for one search per part, background and leads", () => {
    const prompt = chapterMaterialPrompt("Brazil 1988 constitution", { background: {}, leads: ["Article 76 text", "World Bank WGI"] });
    expect(prompt.split("\n")[0]).toBe(
      "Search the web separately for the chapter topic and for each numbered lead below (3 searches at least), then answer in Markdown sections built only from what the searches returned."
    );
    expect(prompt).toContain('Section "## Background"');
    expect(prompt).toContain('Then one section per lead, headed exactly "## Lead N"');
    expect(prompt).toMatch(/Chapter topic: Brazil 1988 constitution\nLead 1: Article 76 text\nLead 2: World Bank WGI$/);
  });

  it("folds plan research queries into the background and counts them as searches", () => {
    const prompt = chapterMaterialPrompt("Pension reform", { background: { alsoCover: ["Brazil 2019 pension reform legislation", " "] }, leads: ["PEC 6/2019"] });
    expect(prompt).toContain("for the chapter topic, each additional topic and for each numbered lead below (3 searches at least)");
    expect(prompt).toContain("Additional topic: Brazil 2019 pension reform legislation\nLead 1: PEC 6/2019");
    expect(prompt.match(/Additional topic:/g)).toHaveLength(1);
  });

  it("asks for more searches a lead under the later wordings", () => {
    const leads = ["Article 76 text", "World Bank WGI"];
    expect(chapterMaterialPrompt("Topic", { background: {}, leads, wording: "v2" })).toContain("at least twice for each numbered lead below");
    expect(chapterMaterialPrompt("Topic", { background: {}, leads, wording: "v2" })).toContain("— 5 searches at least.");
    expect(chapterMaterialPrompt("Topic", { leads, wording: "v3" })).toContain("at least four times for each numbered lead below");
    expect(chapterMaterialPrompt("Topic", { leads, wording: "v3" })).toContain("— 8 searches at least.");
  });

  it("asks a lead-only prompt for no background", () => {
    const prompt = chapterMaterialPrompt("ignored topic", { leads: ["Lead three"] });
    expect(prompt.split("\n")[0]).toContain("for each numbered lead below (1 searches at least)");
    expect(prompt).not.toContain("Background");
    expect(prompt).not.toContain("Chapter topic");
    expect(prompt).toContain('One section per lead, headed exactly "## Lead N"');
  });
});

describe("chapterMaterialSections", () => {
  it("attributes each support to the section its UTF-8 byte offset starts in", () => {
    const text = [
      "## Background",
      "Bolsonaro took office in 2019 — São Paulo backed him.",
      "## Lead 1: The 1988 text",
      "Article 76 vests executive power in the President.",
      "### Lead 2",
      "The WGI cover six dimensions."
    ].join("\n");
    const at = (needle: string) => bytes(text.slice(0, text.indexOf(needle)));
    const sections = chapterMaterialSections(text, [
      { segment: { endIndex: 10 }, groundingChunkIndices: [0] },
      { segment: { startIndex: at("Bolsonaro") }, groundingChunkIndices: [1, 0] },
      { segment: { startIndex: at("Article 76") }, groundingChunkIndices: [2] },
      { segment: { startIndex: at("The WGI") }, groundingChunkIndices: [3, 2] }
    ]);
    expect(sections.map((section) => section.key)).toEqual(["background", "lead1", "lead2"]);
    expect(sections.map((section) => section.chunkIndexes)).toEqual([[0, 1], [2], [2, 3]]);
    expect(sections[0]!.text).toBe("Bolsonaro took office in 2019 — São Paulo backed him.");
    expect(sections[1]!.text).toBe("Article 76 vests executive power in the President.");
  });

  it("drops the subheading the model repeats under a lead heading", () => {
    const sections = chapterMaterialSections("## Lead 1\n### PEC 6 2019 tramitação\n\nThe amendment was filed on 20 February 2019.", []);
    expect(sections).toEqual([{ key: "lead1", text: "The amendment was filed on 20 February 2019.", chunkIndexes: [] }]);
  });

  it("reads bold headings and a bare heading line, and keeps preamble as background", () => {
    const text = "Some preamble.\n**Lead 1**\nFirst lead text.\nLead 2:\nSecond lead text.";
    const sections = chapterMaterialSections(text, [{ segment: { startIndex: bytes(text.slice(0, text.indexOf("Second"))) }, groundingChunkIndices: [4] }]);
    expect(sections.map((section) => [section.key, section.text, section.chunkIndexes])).toEqual([
      ["background", "Some preamble.", []],
      ["lead1", "First lead text.", []],
      ["lead2", "Second lead text.", [4]]
    ]);
  });

  it("does not take a sentence that starts with the word for a heading", () => {
    const text = "## Lead 1\nBackground checks were introduced in 1998.\nLead investigators disagreed.";
    expect(chapterMaterialSections(text, []).map((section) => section.key)).toEqual(["lead1"]);
  });

  it("reads an answer with no headings as one background section", () => {
    const sections = chapterMaterialSections("Just an answer from memory.", [{ segment: { startIndex: 3 }, groundingChunkIndices: [0] }]);
    expect(sections).toEqual([{ key: "background", text: "Just an answer from memory.", chunkIndexes: [0] }]);
  });
});
