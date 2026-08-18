import { describe, expect, it } from "vitest";
import { extractPdfNamedDestinations } from "./pdfNamedDestinations.js";

/**
 * A minimal PDF in the shape Skia writes: classic xref table with real byte
 * offsets, uncompressed object dictionaries, a `trailer` keyword. Object 1 must
 * be the catalog; bodies are given without the `N 0 obj` / `endobj` wrappers.
 */
function syntheticPdf(bodies: string[]): Buffer {
  let text = "%PDF-1.4\n";
  const offsets: number[] = [];
  bodies.forEach((body, index) => {
    offsets.push(text.length);
    text += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = text.length;
  text += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    text += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  text += `trailer\n<</Size ${bodies.length + 1}\n/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(text, "latin1");
}

/** Three leaves under a nested tree, destinations for two anchors and a chapter. */
function threePagePdf(): Buffer {
  return syntheticPdf([
    "<</Type /Catalog\n/Pages 2 0 R\n/Dests 6 0 R>>",
    "<</Type /Pages\n/Count 3\n/MediaBox [0 0 595.28 841.89]\n/Kids [3 0 R 7 0 R]>>",
    "<</Type /Page\n/Parent 2 0 R>>",
    "<</Type /Page\n/Parent 7 0 R>>",
    "<</Type /Page\n/Parent 7 0 R>>",
    "<</bp-1 [3 0 R /XYZ 6 781.9 0]\n/chapter-2 [4 0 R /XYZ 6 400.5 0]\n/bp-3 [5 0 R /XYZ 6 781.9 0]>>",
    "<</Type /Pages\n/Count 2\n/Parent 2 0 R\n/Kids [4 0 R 5 0 R]>>"
  ]);
}

describe("extractPdfNamedDestinations", () => {
  it("reads destinations and the page order through a nested page tree", () => {
    const extracted = extractPdfNamedDestinations(threePagePdf());
    expect(extracted).toBeDefined();
    expect(extracted?.pageCount).toBe(3);
    expect(extracted?.mediaBoxHeight).toBeCloseTo(841.89);
    expect(extracted?.destinations.get("bp-1")).toEqual({ pdfPage: 1, y: 781.9 });
    expect(extracted?.destinations.get("chapter-2")).toEqual({ pdfPage: 2, y: 400.5 });
    expect(extracted?.destinations.get("bp-3")).toEqual({ pdfPage: 3, y: 781.9 });
  });

  it("refuses a page tree whose /Count disagrees with its leaves", () => {
    const pdf = syntheticPdf([
      "<</Type /Catalog\n/Pages 2 0 R>>",
      "<</Type /Pages\n/Count 5\n/Kids [3 0 R]>>",
      "<</Type /Page\n/Parent 2 0 R>>"
    ]);
    expect(extractPdfNamedDestinations(pdf)).toBeUndefined();
  });

  it("never fabricates an object from stream content, because offsets come from the xref", () => {
    // A stream body containing the byte pattern of an object header.
    const pdf = syntheticPdf([
      "<</Type /Catalog\n/Pages 2 0 R\n/Dests 4 0 R>>",
      "<</Type /Pages\n/Count 1\n/Kids [3 0 R]>>",
      "<</Type /Page\n/Parent 2 0 R>>\nstream\n99 0 obj <</Type /Page>> endobj\nendstream",
      "<</bp-1 [3 0 R /XYZ 6 700 0]>>"
    ]);
    const extracted = extractPdfNamedDestinations(pdf);
    expect(extracted?.pageCount).toBe(1);
    expect(extracted?.destinations.get("bp-1")?.pdfPage).toBe(1);
  });

  it("returns undefined for bytes with no trailer", () => {
    expect(extractPdfNamedDestinations(Buffer.from("%PDF-1.4 not a real file"))).toBeUndefined();
  });

  it("decodes #-escaped destination names", () => {
    const pdf = syntheticPdf([
      "<</Type /Catalog\n/Pages 2 0 R\n/Dests 4 0 R>>",
      "<</Type /Pages\n/Count 1\n/Kids [3 0 R]>>",
      "<</Type /Page\n/Parent 2 0 R>>",
      "<</with#20space [3 0 R /XYZ 0 10 0]>>"
    ]);
    expect(extractPdfNamedDestinations(pdf)?.destinations.get("with space")?.pdfPage).toBe(1);
  });
});