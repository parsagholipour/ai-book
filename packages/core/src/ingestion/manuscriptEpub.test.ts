import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { EPUB_DOCUMENT_MAX_BYTES } from "./documentText.js";
import { extractEpubSections } from "./manuscriptEpub.js";
import { zeroBomb, zipArchive } from "./testing/zipArchive.js";
import { LINEAR_TIME_CEILING_MS } from "./testing/linearTime.js";

async function readMs(run: () => Promise<unknown>): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let read = 0; read < 2; read += 1) {
    const start = performance.now();
    await run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

function epub(chapters: readonly string[], metadata = "<dc:title>The Long Winter</dc:title><dc:creator>Jane Doe</dc:creator>"): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("META-INF/container.xml", `<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`);
  zip.file(
    "OEBPS/content.opf",
    `<package><metadata>${metadata}</metadata><manifest>${chapters.map((_, index) => `<item id="c${index}" href="c${index}.xhtml"/>`).join("")}</manifest>` +
      `<spine>${chapters.map((_, index) => `<itemref idref="c${index}"/>`).join("")}</spine></package>`
  );
  chapters.forEach((html, index) => zip.file(`OEBPS/c${index}.xhtml`, html));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

describe("EPUB sections", () => {
  it("reads headings, titles and the package's metadata", async () => {
    const data = await epub([
      "<html><head><title>Front</title></head><body><section epub:type=\"dedication\"><p>For my mother.</p></section><p>Prose</p></body></html>",
      "<html><head><title>Ignored</title></head><body><h1>Chapter <em>One</em></h1><p>Snow &amp; ice.</p></body></html>"
    ]);
    expect(await extractEpubSections(data)).toEqual({
      sections: [
        { title: "Front", text: "For my mother.", standalone: true, hint: "dedication", headingless: true },
        { title: "Front", text: "Prose", standalone: true, headingless: true },
        { title: "Chapter One", text: "Snow & ice.", standalone: true }
      ],
      title: "The Long Winter",
      creators: ["Jane Doe"]
    });
  });

  it("stops reading once it holds more text than an import keeps", async () => {
    const data = await epub(Array.from({ length: 5 }, () => `<html><body><p>${"word ".repeat(200)}</p></body></html>`));
    expect((await extractEpubSections(data, 1_500)).sections).toHaveLength(2);
    expect((await extractEpubSections(data)).sections).toHaveLength(5);
  });

  it("stays linear on headings and creators that never close, and on blocks with no title", async () => {
    const shapes: Array<[string, (length: number) => Promise<Buffer>]> = [
      // 2.4 s at 120,000 characters before.
      ["unclosed <h1", (length) => epub([`<html><body><p>Text</p>${"<h1 ".repeat(length / 4)}</body></html>`])],
      ["unclosed <dc:creator>", (length) => epub(["<html><body><p>Text</p></body></html>"], "<dc:creator>".repeat(length / 12))],
      // Every block searched the whole file for a `<title>` it does not have.
      [
        "dedication blocks with no title",
        (length) => epub([`<html><body>${'<section epub:type="dedication"><p>For you</p></section>'.repeat(length / 55)}</body></html>`])
      ]
    ];
    for (const [label, build] of shapes) {
      for (const length of [12_000, 120_000]) {
        const data = await build(length);
        const ms = await readMs(() => extractEpubSections(data).catch(() => undefined));
        expect(ms, `${label} at ${length} chars: ${ms.toFixed(1)} ms`).toBeLessThan(LINEAR_TIME_CEILING_MS);
      }
    }
  });

  it("refuses a chapter past the content document limit", async () => {
    const data = zipArchive([{ path: "c.xhtml", deflated: zeroBomb(EPUB_DOCUMENT_MAX_BYTES / (1024 * 1024) + 1) }]);
    await expect(extractEpubSections(data)).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });
});
