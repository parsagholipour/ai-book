import { describe, expect, it } from "vitest";
import { checkQuoteProvenance, foldQuoteText, quotedSpans, spanIsVerbatim, stripMisattributedQuotes } from "./quoteProvenance.js";

const excerpt = {
  documentTitle: "The Secret History of the Mongols",
  text: "Then Temüjin said: “Let us make the Merkit our prey; let us take back what they took from us, and let no man of them escape across the river.”"
};

describe("quoteProvenance", () => {
  it("folds quotes, dashes and case so a typographic variant still matches", () => {
    expect(foldQuoteText("“Let us make the Merkit—our prey”")).toBe("let us make the merkit our prey");
    expect(foldQuoteText("Temüjin")).toBe("temujin");
  });

  it("finds only quoted spans of eight or more words and never across paragraphs", () => {
    const text = 'He called it “a good day.” Then he wrote “let us make the Merkit our prey; let us take back what they took from us” and stopped.\n\n“Never again,” she said.';
    const spans = quotedSpans(text);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.text.startsWith("let us make")).toBe(true);
  });

  it("accepts an elided quotation whose segments are each in the dossier", () => {
    expect(spanIsVerbatim("Let us make the Merkit our prey … let no man of them escape across the river", [foldQuoteText(excerpt.text)])).toBe(true);
    expect(spanIsVerbatim("Let us make the Merkit our prey and burn their tents to the ground", [foldQuoteText(excerpt.text)])).toBe(false);
  });

  it("strips the marks only from a miss the paragraph hangs on a dossier document", () => {
    const chapter = [
      "The Secret History of the Mongols puts it plainly: “let us make the Merkit our prey and burn every tent they own tonight.”",
      "Napoleon is said to have remarked that “an army marches on its stomach, and so does a state.”",
      "The Secret History records the oath: “let us take back what they took from us, and let no man of them escape across the river.”"
    ].join("\n\n");
    const report = checkQuoteProvenance(chapter, [excerpt]);
    expect(report.checked).toBe(3);
    expect(report.verbatim).toBe(1);
    expect(report.misattributed).toBe(1);
    const stripped = stripMisattributedQuotes(chapter, report);
    expect(stripped.stripped).toBe(1);
    expect(stripped.markdown).toContain("puts it plainly: let us make the Merkit our prey and burn every tent they own tonight.");
    expect(stripped.markdown).toContain("“an army marches on its stomach, and so does a state.”");
    expect(stripped.markdown).toContain("“let us take back what they took from us, and let no man of them escape across the river.”");
  });
});
