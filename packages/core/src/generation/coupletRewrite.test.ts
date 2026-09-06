import { describe, expect, it } from "vitest";
import { antithesesPer1000Sentences, coupletsPer1000Sentences, findCouplets } from "./coupletRewrite.js";

const chapter = [
  "A Mongol army did not carry its whole world behind it in wagons. It carried a moving pasture. Each warrior might have several horses, and the army's speed depended on changing them.",
  "The wagon train was not an afterthought to the army in 1241. It set the limits of the army's reach under Batu. Nothing here is a couplet: the sentence runs on with a subordinate clause before it settles.",
  "Baghdad fell in 1258 after the campaign led by Hülegü. The city was the seat of the Abbasid caliphate."
].join("\n\n");

describe("coupletRewrite", () => {
  it("finds the negation-then-assertion pairs and counts them per thousand sentences", () => {
    const couplets = findCouplets(chapter);
    expect(couplets.map((couplet) => couplet.first)).toEqual([
      "A Mongol army did not carry its whole world behind it in wagons.",
      "The wagon train was not an afterthought to the army in 1241."
    ]);
    expect(couplets.every((couplet) => couplet.kind === "classic")).toBe(true);
    expect(couplets[1]!.paragraph).toBe(1);
    expect(couplets[1]!.text).toBe("The wagon train was not an afterthought to the army in 1241. It set the limits of the army's reach under Batu.");
    expect(Math.round(coupletsPer1000Sentences(chapter))).toBe(Math.round((2 / 8) * 1000));
    // A classic-only chapter reads the same on both series.
    expect(antithesesPer1000Sentences(chapter)).toBe(coupletsPer1000Sentences(chapter));
  });

});

const MUST_FLAG: Array<{ kind: string; markdown: string; text: string }> = [
  {
    kind: "assertRetract",
    markdown: "It makes social support a serious question. It does not prove a particular ethic of care.",
    text: "It makes social support a serious question. It does not prove a particular ethic of care."
  },
  {
    kind: "assertRetract",
    markdown: "The cemetery gathered the consequences of repeated episodes. It did not necessarily gather the members of one army killed on one day.",
    text: "The cemetery gathered the consequences of repeated episodes. It did not necessarily gather the members of one army killed on one day."
  },
  {
    kind: "semicolonRetract",
    markdown: "Context narrows possibilities; it rarely supplies motive.",
    text: "Context narrows possibilities; it rarely supplies motive."
  },
  {
    kind: "semicolonRetract",
    markdown: "Mobility changes the geography of danger; it does not abolish danger.",
    text: "Mobility changes the geography of danger; it does not abolish danger."
  },
  {
    kind: "semicolonRetract",
    markdown: "The stones establish construction; they do not, by themselves, establish warfare.",
    text: "The stones establish construction; they do not, by themselves, establish warfare."
  },
  {
    kind: "withoutProving",
    markdown: "The evidence can support interpersonal blows without proving a systematic practice of assault.",
    text: "The evidence can support interpersonal blows without proving a systematic practice of assault."
  },
  {
    kind: "withoutProving",
    markdown: "They can reveal exposure to force without telling us whether force was exceptional or routine.",
    text: "They can reveal exposure to force without telling us whether force was exceptional or routine."
  }
];

const MUST_NOT_FLAG = [
  "Generals, diplomats, lawyers, and intelligence officers filled the room, but the decisive object was neither the map nor the missile.",
  "The imperial government could ask not merely whether it possessed cannon but how many were fit for service and where they stood.",
  "The list ran: grain, oil, wine; cloth, rope; iron.",
  "They marched without food for three days."
];

describe("the broadened antithesis detector", () => {
  it("flags each new shape once, with its kind and the exact span", () => {
    for (const example of MUST_FLAG) {
      const hits = findCouplets(example.markdown);
      expect(hits, example.markdown).toHaveLength(1);
      expect(hits[0]!.kind, example.markdown).toBe(example.kind);
      expect(hits[0]!.text, example.markdown).toBe(example.text);
      if (example.kind === "assertRetract") {
        expect(hits[0]!.second).not.toBe("");
      } else {
        expect(hits[0]!.second).toBe("");
      }
    }
  });

  it("flags none of the measured false positives", () => {
    for (const sentence of MUST_NOT_FLAG) {
      expect(findCouplets(sentence), sentence).toEqual([]);
    }
    // Nor when they sit in a paragraph together.
    expect(findCouplets(MUST_NOT_FLAG.join(" "))).toEqual([]);
  });

  it("takes at most one hit per sentence and never both halves of a pair", () => {
    const paragraph = [
      "It makes social support a serious question.",
      "It does not prove a particular ethic of care; it rarely supplies motive.",
      "The evidence can support interpersonal blows without proving a systematic practice of assault."
    ].join(" ");
    const hits = findCouplets(paragraph);
    expect(hits.map((hit) => hit.kind)).toEqual(["assertRetract", "withoutProving"]);
    expect(hits.map((hit) => hit.id)).toEqual(["c1", "c2"]);
  });

  it("counts the classic series apart from every kind", () => {
    const mixed = [
      "A Mongol army did not carry its whole world behind it in wagons. It carried a moving pasture.",
      "Context narrows possibilities; it rarely supplies motive.",
      "The evidence can support interpersonal blows without proving a systematic practice of assault."
    ].join("\n\n");
    expect(Math.round(coupletsPer1000Sentences(mixed))).toBe(250);
    expect(Math.round(antithesesPer1000Sentences(mixed))).toBe(750);
  });

  it("reads past headings, quotes, lists and fences", () => {
    const markdown = [
      "## Context narrows possibilities; it rarely supplies motive.",
      "> Context narrows possibilities; it rarely supplies motive.",
      "- Context narrows possibilities; it rarely supplies motive.",
      "```\nContext narrows possibilities; it rarely supplies motive.\n```"
    ].join("\n\n");
    expect(findCouplets(markdown)).toEqual([]);
  });

});

describe("historical cadence measurement", () => {
  const pair = [
    "The cemetery did not speak in sentences.",
    "Its evidence lay in bodies, burial positions, implements, and the relation between them."
  ].join(" ");
  const couplet = findCouplets(pair)[0]!;

  it("is the classic couplet the readers quoted", () => {
    expect(couplet.kind).toBe("classic");
    expect(couplet.text).toBe(pair);
  });



});
