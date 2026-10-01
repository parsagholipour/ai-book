import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, PDFString, rgb } from "pdf-lib";
import { slicePdfToFirstSheets } from "./sharePreviewPdf.js";

/**
 * A preview is a PDF of its first sheets and nothing else. Each page of the
 * source carries a marker only it holds, written uncompressed into its own page
 * dictionary and into a private image stream, and the first page links
 * *directly* to the last one — the object reference `copyPages` would follow
 * into the slice if the link were kept.
 */
async function markedBook(pages: number): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const pageRefs = [];
  for (let number = 1; number <= pages; number += 1) {
    const page = document.addPage([300, 400]);
    page.drawText(`Page ${number}`, { x: 20, y: 360, size: 14, color: rgb(0, 0, 0) });
    page.node.set(PDFName.of("Marker"), PDFString.of(`secret-page-${number}`));
    const privateStream = document.context.stream(`private-bytes-of-page-${number}`, {});
    page.node.set(PDFName.of("PieceInfo"), document.context.obj({ Private: document.context.register(privateStream) }));
    pageRefs.push(page.ref);
  }
  const first = document.getPage(0);
  const internalLink = document.context.register(
    document.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [0, 0, 100, 20],
      Dest: [pageRefs[pages - 1]!, PDFName.of("Fit")]
    })
  );
  const externalLink = document.context.register(
    document.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [0, 30, 100, 50],
      A: { S: "URI", URI: PDFString.of("https://example.org/source") }
    })
  );
  first.node.set(PDFName.of("Annots"), document.context.obj([internalLink, externalLink]));
  return document.save({ useObjectStreams: false });
}

describe("slicePdfToFirstSheets", () => {
  it("never carries a byte of a page past the last one it keeps", async () => {
    const source = await markedBook(8);

    const slice = await slicePdfToFirstSheets(source, 3);
    const text = Buffer.from(await PDFDocument.load(slice).then((document) => document.save({ useObjectStreams: false }))).toString("latin1");

    expect((await PDFDocument.load(slice)).getPageCount()).toBe(3);
    for (const kept of [1, 2, 3]) {
      expect(text).toContain(`secret-page-${kept}`);
      expect(text).toContain(`private-bytes-of-page-${kept}`);
    }
    for (const dropped of [4, 5, 6, 7, 8]) {
      expect(text).not.toContain(`secret-page-${dropped}`);
      expect(text).not.toContain(`private-bytes-of-page-${dropped}`);
    }
  });

  it("keeps an external link and drops the link that pointed into the rest of the book", async () => {
    const slice = await PDFDocument.load(await slicePdfToFirstSheets(await markedBook(5), 1));

    const annots = slice.getPage(0).node.Annots();
    expect(annots?.size()).toBe(1);
    const text = Buffer.from(await slice.save({ useObjectStreams: false })).toString("latin1");
    expect(text).toContain("https://example.org/source");
  });

  it("never cuts past the book or below one sheet", async () => {
    const source = await markedBook(2);

    expect((await PDFDocument.load(await slicePdfToFirstSheets(source, 9))).getPageCount()).toBe(2);
    expect((await PDFDocument.load(await slicePdfToFirstSheets(source, 0))).getPageCount()).toBe(1);
  });
});
