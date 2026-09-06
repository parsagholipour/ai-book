import { describe, expect, it } from "vitest";
import { capParagraphFinalDisclaimers, isDisclaimerSentence } from "./disclaimerCap.js";
import { countReadableWords } from "./proseShape.js";

// The eight sentences three Opus readers of `legacy-cuts-7b` were reading when
// they wrote "almost every paragraph closes on an epistemic-limit disclaimer".
const SAMPLES = [
  "Its evidence offers no rate of assault for Babylon.",
  "The body carries recurrence where the cemetery cannot supply narrative.",
  "It leaves open whether every day was violent and whether the community had means of ending a dispute.",
  "Hammurabi supports a claim about ranked legal classification more securely than a claim about everyday compliance.",
  "The material does not name the threat.",
  "That closeness does not prove that a particular injury was domestic, ritual, or martial.",
  "The site shows lethal asymmetry at one location; it does not reveal the political account that the attackers gave for it.",
  "The bones give us the point at which an encounter became materially visible, while the remainder of the encounter stays beyond their record."
];

const FILLER_A = "The masons cut the blocks on site and hauled them up a ramp of packed earth.";
const FILLER_B = "Two seasons of digging turned up a workshop, a kiln and a drain running under the wall.";

/** The six samples carrying no proper noun of their own: every one of them is a candidate. */
const ANCHORLESS = [SAMPLES[1]!, SAMPLES[2]!, SAMPLES[4]!, SAMPLES[5]!, SAMPLES[6]!, SAMPLES[7]!];

/** A paragraph whose last sentence is the disclaimer, with enough sentences before it to qualify. */
function paragraph(last: string): string {
  return `${FILLER_A} ${FILLER_B} ${last}`;
}

describe("isDisclaimerSentence", () => {
  it("finds the eight sampled shapes", () => {
    for (const sample of SAMPLES) {
      expect(isDisclaimerSentence(sample), sample).toBe(true);
    }
  });

  it("leaves an ordinary sentence alone", () => {
    expect(isDisclaimerSentence(FILLER_A)).toBe(false);
    expect(isDisclaimerSentence(FILLER_B)).toBe(false);
  });
});

describe("capParagraphFinalDisclaimers", () => {
  it("deletes a paragraph-final disclaimer and leaves the rest byte-identical", () => {
    const markdown = paragraph(SAMPLES[4]!);
    const result = capParagraphFinalDisclaimers(markdown, { minWords: 0 });
    expect(result.found).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.markdown).toBe(`${FILLER_A} ${FILLER_B}`);
    expect(result.words).toBe(countReadableWords(SAMPLES[4]!));
  });

  it("never touches a paragraph of two sentences", () => {
    const markdown = `${FILLER_A} ${SAMPLES[4]!}`;
    expect(capParagraphFinalDisclaimers(markdown, { minWords: 0 })).toMatchObject({
      markdown,
      found: 0,
      removed: 0
    });
  });

  it("keeps a disclaimer carrying a date nothing else in the chapter says", () => {
    const markdown = paragraph("The register does not name the threat before 1584.");
    expect(capParagraphFinalDisclaimers(markdown, { minWords: 0 })).toMatchObject({ found: 0, removed: 0 });
  });

  it("counts a disclaimer whose every anchor is said again elsewhere", () => {
    const markdown = [paragraph("The register does not name the threat before 1584."), "Nineveh fell in 1584, and the register was closed."].join("\n\n");
    expect(capParagraphFinalDisclaimers(markdown, { minWords: 0 })).toMatchObject({ found: 1, removed: 1 });
  });

  it("skips the samples whose proper noun is said nowhere else", () => {
    // "Babylon" and "Hammurabi" appear in their sentence alone, so those two
    // disclaimers carry the only mention of a fact and are never candidates.
    const markdown = [SAMPLES[0]!, SAMPLES[3]!].map(paragraph).join("\n\n");
    expect(capParagraphFinalDisclaimers(markdown, { minWords: 0 })).toMatchObject({ markdown, found: 0, removed: 0 });
  });

  it("keeps every third candidate", () => {
    const markdown = ANCHORLESS.map(paragraph).join("\n\n");
    const result = capParagraphFinalDisclaimers(markdown, { minWords: 0 });
    expect(result.found).toBe(6);
    expect(result.removed).toBe(4);
    expect(result.markdown).toContain(ANCHORLESS[2]!);
    expect(result.markdown).toContain(ANCHORLESS[5]!);
    expect(result.markdown).not.toContain(ANCHORLESS[0]!);
    expect(result.markdown).not.toContain(ANCHORLESS[4]!);
  });

  it("stops deleting at the floor", () => {
    const markdown = ANCHORLESS.map(paragraph).join("\n\n");
    const free = capParagraphFinalDisclaimers(markdown, { minWords: 0 });
    expect(free.removed).toBe(4);
    const floored = capParagraphFinalDisclaimers(markdown, { minWords: countReadableWords(markdown) - 1 });
    expect(floored).toMatchObject({ markdown, removed: 0, words: 0 });
    expect(floored.found).toBe(free.found);
  });

  it("reads past headings, quotations, lists and figure fences", () => {
    const markdown = [
      "## A chapter heading that does not prove anything at all here",
      `> ${FILLER_A} ${FILLER_B} ${SAMPLES[4]!}`,
      `- ${FILLER_A} ${FILLER_B} ${SAMPLES[4]!}`,
      "```figure\n{\"kind\":\"bar\"}\n```"
    ].join("\n\n");
    expect(capParagraphFinalDisclaimers(markdown, { minWords: 0 })).toMatchObject({ markdown, found: 0, removed: 0 });
  });

  it("returns the chapter unchanged when it has no candidates", () => {
    const markdown = `${FILLER_A} ${FILLER_B} ${FILLER_A}`;
    expect(capParagraphFinalDisclaimers(markdown, { minWords: 0 })).toEqual({
      markdown,
      found: 0,
      removed: 0,
      words: 0
    });
  });
});
