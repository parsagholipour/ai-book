import { describe, expect, it } from "vitest";
import {
  chapterEdges,
  detemplateNotes,
  isGeneralisingCloser,
  isGenericSingularOpening,
  isNegationContrast,
  measureProse,
  measurementNotes,
  negationThenShortPairs,
  sampleSentenceLeaks,
  splitSentences
} from "./proseMeasurements.js";

const TEMPLATED = [
  "A cannon was never only a cannon. It was iron that had to be mined, powder that had to be measured, animals that had to be fed, and men who had to be paid. Early modern power did not simply make violence efficient; it made it administratively reliable. The distinction matters.",
  "The road connected the quarry to the fort. Taken together, these arrangements show that the frontier depended less on the wall than on the supply behind it. Reliability could mean protection at home, conquest abroad, or both at once.",
  "Hadrian's Wall was begun around 122 CE, and the forts along it held around 15,000 men by the reign of Antoninus Pius. The strongest objection is that the wall never stopped anyone. It did not need to. The wall made movement legible.",
  "Modern mass violence depended less on a new human appetite for aggression than on new capacities to classify, transport, supply, and command populations. The lesson is simple."
].join("\n\n");

const PARTICULAR = [
  "In 1534 the clerk at Housesteads recorded forty-one carts through the north gate between the kalends and the ides, each with its driver's name and the weight of grain on the bed. The ledger survives because a later hand used its blank verso for a list of debts, and the debts were never settled, so the book stayed in the fort's chest until the roof fell in on it.",
  "Marcus Cocceius Firmus, prefect of the Second Cohort, signed the last page. His signature is smaller than the clerk's hand, and it is dated to the ides of March.",
  "The grain came from Corbridge by the Stanegate road. A cart took two days. At the halfway point a mansio kept fresh mules, and the mansio's own accounts, found in 1936, list the mule-driver Ioventius forty times over eleven years, always with the same three animals until the year one of them is struck through."
].join("\n\n");

describe("sentence classifiers", () => {
  it("recognises negation followed by its correction", () => {
    expect(isNegationContrast("Early modern power did not simply make violence efficient; it made it reliable.")).toBe(true);
    expect(isNegationContrast("A cannon was never only a cannon.")).toBe(true);
    expect(isNegationContrast("Modern violence depended less on appetite than on capacity.")).toBe(true);
    expect(isNegationContrast("The clerk signed the last page.")).toBe(false);
    expect(isNegationContrast("The wall did not stop anyone in 122 CE.")).toBe(false);
  });

  it("recognises a negation followed by a short corrective sentence", () => {
    const pairs = negationThenShortPairs(splitSentences("The wall did not stop anyone. It made movement legible. The forts held 15,000 men."));
    expect(pairs).toEqual(["The wall did not stop anyone. It made movement legible."]);
    expect(negationThenShortPairs(splitSentences("The wall did not stop anyone. In 122 CE the forts held fifteen thousand men and their families."))).toEqual([]);
  });

  it("recognises a short closer with no particular in it", () => {
    expect(isGeneralisingCloser("The distinction matters.")).toBe(true);
    expect(isGeneralisingCloser("The household persists because people continue to perform its identity.")).toBe(true);
    expect(isGeneralisingCloser("Marcus signed the last page in 1534.")).toBe(false);
    expect(isGeneralisingCloser("The mansio's own accounts, found in 1936, list the mule-driver Ioventius forty times over eleven years.")).toBe(false);
  });

  it("recognises a general claim about a common noun as an opening", () => {
    expect(isGenericSingularOpening("A cannon was never only a cannon.")).toBe(true);
    expect(isGenericSingularOpening("A boundary is easiest to notice when someone crosses it.")).toBe(true);
    expect(isGenericSingularOpening("A Roman frontier did not begin where the watchtower stood.")).toBe(false);
    expect(isGenericSingularOpening("In 1534 the clerk at Housesteads recorded forty-one carts.")).toBe(false);
  });
});

describe("measureProse and measurementNotes", () => {
  it("quotes the sentences that put a templated chapter over its ceilings", () => {
    const measured = measureProse(TEMPLATED);
    expect(measured.negationContrast.count).toBeGreaterThanOrEqual(4);
    expect(measured.negationThenShort.count).toBeGreaterThanOrEqual(1);
    expect(measured.pivots.byPhrase["the distinction matters"]).toBe(1);
    expect(measured.pivots.byPhrase["the strongest objection"]).toBe(1);
    expect(measured.genericSingularOpening).toBe(true);
    expect(measured.closingGeneralises).toBe(true);
    // Negation and closing-verdict notes are diagnostics unless asked for:
    // quoted into the editor's prompt they fused the hedge into the antithesis.
    const quiet = measurementNotes(measured);
    expect(quiet.some((note) => note.includes("negation followed by its correction"))).toBe(false);
    expect(quiet.some((note) => note.includes("one-sentence verdict"))).toBe(false);
    const notes = measurementNotes(measured, undefined, { includeNegationNotes: true });
    expect(notes.some((note) => note.includes("negation followed by its correction") && note.includes("A cannon was never only a cannon."))).toBe(true);
    expect(notes.some((note) => note.includes("short corrective sentence") && note.includes("It did not need to."))).toBe(true);
    expect(notes.some((note) => note.includes("Stock pivots") && note.includes('"the strongest objection" ×1'))).toBe(true);
    expect(notes.some((note) => note.includes("opens on a general claim about a common noun"))).toBe(true);
    expect(notes.some((note) => note.includes("one-sentence verdict"))).toBe(true);
  });

  it("has little to say about prose made of particulars", () => {
    const measured = measureProse(PARTICULAR);
    expect(measured.negationContrast.count).toBe(0);
    expect(measured.negationThenShort.count).toBe(0);
    expect(measured.pivots.count).toBe(0);
    expect(measured.genericSingularOpening).toBe(false);
    expect(measured.closingGeneralises).toBe(false);
    expect(measurementNotes(measured).filter((note) => !note.startsWith("Sentence openings"))).toEqual([]);
  });
});

describe("sampleSentenceLeaks and chapterEdges", () => {
  it("finds a sample sentence that reached the prose verbatim, and reads a chapter's edges", () => {
    const sample = "A boundary is easiest to notice when someone crosses it. Traders learn where to stop.";
    const prose = "A boundary is easiest to notice when someone crosses it. In the chapters behind us that crossing took many forms.\n\nThe last cart left at dusk.";
    expect(sampleSentenceLeaks(sample, prose)).toEqual(["A boundary is easiest to notice when someone crosses it."]);
    expect(chapterEdges(prose)).toEqual({
      opening: "A boundary is easiest to notice when someone crosses it.",
      closing: "The last cart left at dusk."
    });
  });
});

describe("detemplateNotes", () => {
  it("quotes assert-retract pairs, balanced closers, a roll-call ending and question seams", () => {
    const chapter = [
      "The tablet from Ur records a ration of barley for a named worker in the third year of the king. It does not record whether he ate it. The register at Lagash shows the same allocation a decade later. It cannot show who carried the grain. The papyrus from Oxyrhynchus lists a tax in kind on the village of Karanis. It does not list the collector's name. The census at Elephantine gives a household of six in the reign of Darius; it says nothing of their work.",
      "The wall at Jericho was raised before the tower, and the tower before the ditch. Why did the builders stop?",
      "Protection was specific in Ur; coercion was specific in Lagash.",
      "Ur shows the ration, Lagash shows the register, Oxyrhynchus shows the tax, and Elephantine shows the household. Taken together they show that the record is evidence of what the institution needed to know."
    ].join("\n\n");
    const notes = detemplateNotes(measureProse(chapter), { maxAssertRetract: 1 });
    expect(notes.some((note) => note.includes("affirm what a source shows and then retract it") && note.includes("It does not record whether he ate it."))).toBe(true);
    expect(notes.some((note) => note.includes("names the chapter's cases again in sequence"))).toBe(true);
    expect(notes.some((note) => note.includes("Stock pivots") && note.includes('"taken together"'))).toBe(true);
  });
});
