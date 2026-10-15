import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import {
  DOCUMENT_ARCHIVE_MAX_BYTES,
  DOCUMENT_ARCHIVE_MAX_ENTRIES,
  DOCUMENT_ENTRY_MAX_BYTES,
  DocumentArchive,
  DocumentTextError,
  EPUB_DOCUMENT_MAX_BYTES,
  docxXmlToText,
  extractDocxText,
  extractEpubText,
  readDocxDocumentXml,
  stripHtml
} from "./documentText.js";
import { emptyEntries, wordBomb, zeroBomb, zipArchive } from "./testing/zipArchive.js";
import { LINEAR_TIME_CEILING_MS } from "./testing/linearTime.js";

const MIB = 1024 * 1024;

function readMs(run: () => unknown): number {
  let best = Number.POSITIVE_INFINITY;
  for (let read = 0; read < 2; read += 1) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

/** The regex chains these functions were before they were made linear: the answers they must keep. */
function regexStripHtml(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code: string) => {
      const value = Number.parseInt(code, 10);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : " ";
    });
}

function regexDocxXmlToText(xml: string): string {
  return xml
    .replace(/<w:p\b[^>]*>/g, "\n")
    .replace(/<\/w:tc>/g, "\t")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

const HTML = [
  "<p>One</p><p>Two &amp; three</p>",
  "<script>var a = '<p>';</script><p>Kept</p><STYLE>p{}</style>",
  "<p>Before</p><script>never closed <p>after</p>",
  "<br/>a<BR>b<br class='x'>c</li>d",
  "<p a='>'>attribute holds a bracket</p>",
  "trailing <p unclosed tag",
  "<scripts>not a script</scripts> &#65;&#0;&#9999999;",
  "<div \"<div \"<div \">text"
];
const XML = [
  "<w:p><w:r><w:t>Hello</w:t></w:r></w:p>",
  "<w:p w:rsidR=\"1\"><w:r><w:tab/><w:t>a</w:t><w:br/><w:t>b</w:t></w:r></w:p>",
  "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>x</w:t></w:r></w:p></w:tc></w:tr></w:tbl>",
  "<w:tab><w:tab x/><w:br><w:br w:type=\"page\"/>&amp;&lt;&apos;",
  "<w:p <w:tab <w:br/> tail <w:p"
];

describe("document text", () => {
  it("strips HTML and Word XML exactly as the regexes did", () => {
    for (const html of HTML) expect(stripHtml(html), html).toBe(regexStripHtml(html));
    for (const xml of XML) expect(docxXmlToText(xml), xml).toBe(regexDocxXmlToText(xml));
  });

  it("stays linear on unclosed scripts, unclosed tags and tags that never close themselves", () => {
    const adversarial: Array<[string, (length: number) => string, (text: string) => unknown]> = [
      // 1.9 s at 192,000 characters before.
      ['stripHtml on <div "', (length) => `<div "`.repeat(length / 6), stripHtml],
      // 1.0 s at 256,000 characters before.
      ["stripHtml on unclosed <script>", (length) => "<script>".repeat(length / 8), stripHtml],
      // 1.1 s at 112,000 characters before.
      ["docxXmlToText on <w:tab ", (length) => "<w:tab ".repeat(length / 7), docxXmlToText],
      ["docxXmlToText on <w:br inside one tag", (length) => `${"<w:br ".repeat(length / 6)}>`, docxXmlToText]
    ];
    for (const [label, build, read] of adversarial) {
      for (const length of [25_600, 256_000]) {
        const text = build(length);
        const ms = readMs(() => read(text));
        expect(ms, `${label} at ${length} chars: ${ms.toFixed(1)} ms`).toBeLessThan(LINEAR_TIME_CEILING_MS);
      }
    }
  });
});

describe("document archive limits", () => {
  function refusal(error: unknown): { code: string; message: string } {
    expect(error).toBeInstanceOf(DocumentTextError);
    return { code: (error as DocumentTextError).code, message: (error as DocumentTextError).message };
  }

  it("refuses a Word document that inflates past the limit, whatever its header claims", async () => {
    // 2 GiB of zeros behind a header claiming 1,000 bytes: read to the end, it
    // would not fit the heap. The read stops at the limit instead.
    const bomb = wordBomb(2048);
    expect(bomb.length).toBeLessThan(4 * MIB);
    for (const read of [readDocxDocumentXml, extractDocxText]) {
      const started = performance.now();
      const error = await read(bomb).catch((caught: unknown) => caught);
      expect(refusal(error)).toEqual({
        code: "FILE_TOO_LARGE",
        message: "That Word document is too large to read. Split it into smaller files and try again."
      });
      expect(performance.now() - started).toBeLessThan(5_000);
    }
  });

  it("reads an entry right up to the limit", async () => {
    const archive = await DocumentArchive.open(
      zipArchive([{ path: "a.txt", deflated: zeroBomb(DOCUMENT_ENTRY_MAX_BYTES / MIB), claimedSize: DOCUMENT_ENTRY_MAX_BYTES }]),
      "file"
    );
    expect((await archive.text("a.txt"))?.length).toBe(DOCUMENT_ENTRY_MAX_BYTES);
    expect(await archive.text("missing.txt")).toBeUndefined();
  });

  it("refuses the file whose bytes take the archive past its total", async () => {
    const perEntry = DOCUMENT_ENTRY_MAX_BYTES / MIB;
    const entries = Math.floor(DOCUMENT_ARCHIVE_MAX_BYTES / DOCUMENT_ENTRY_MAX_BYTES) + 1;
    const archive = await DocumentArchive.open(
      zipArchive(Array.from({ length: entries }, (_, index) => ({ path: `c${index}.xhtml`, deflated: zeroBomb(perEntry), claimedSize: DOCUMENT_ENTRY_MAX_BYTES }))),
      "EPUB"
    );
    for (let index = 0; index < entries - 1; index += 1) expect((await archive.text(`c${index}.xhtml`))?.length).toBe(DOCUMENT_ENTRY_MAX_BYTES);
    expect(refusal(await archive.text(`c${entries - 1}.xhtml`).catch((caught: unknown) => caught)).code).toBe("FILE_TOO_LARGE");
  });

  it("refuses an archive of more files than any book has", async () => {
    const entries = Array.from({ length: DOCUMENT_ARCHIVE_MAX_ENTRIES + 1 }, (_, index) => ({ path: `p${index}.xhtml`, text: "" }));
    const error = await DocumentArchive.open(zipArchive(entries), "EPUB").catch((caught: unknown) => caught);
    expect(refusal(error)).toEqual({ code: "FILE_TOO_LARGE", message: "That EPUB is too large to read. Split it into smaller files and try again." });
  });

  it("refuses a directory of 200,000 entries before JSZip reads it", async () => {
    // The launch review's 17 MB .docx: JSZip took 0.8–3.7 s and 325 MB to
    // build its directory before the count above could be taken.
    const data = emptyEntries(200_000);
    const loadAsync = vi.spyOn(JSZip, "loadAsync");
    try {
      const started = performance.now();
      const error = await DocumentArchive.open(data, "Word document").catch((caught: unknown) => caught);
      const ms = performance.now() - started;
      expect(refusal(error)).toEqual({
        code: "FILE_TOO_LARGE",
        message: "That Word document is too large to read. Split it into smaller files and try again."
      });
      expect(loadAsync).not.toHaveBeenCalled();
      expect(ms).toBeLessThan(LINEAR_TIME_CEILING_MS);
    } finally {
      loadAsync.mockRestore();
    }
  });

  it("refuses entries that share one local header's long name before JSZip decodes them", async () => {
    const data = zipArchive([
      { path: "n".repeat(0xffff), text: "" },
      ...Array.from({ length: DOCUMENT_ARCHIVE_MAX_ENTRIES - 1 }, () => ({ path: "x", sharesLocalHeaderOf: 0 }))
    ]);
    const loadAsync = vi.spyOn(JSZip, "loadAsync");
    try {
      expect(refusal(await DocumentArchive.open(data, "EPUB").catch((caught: unknown) => caught)).code).toBe("FILE_TOO_LARGE");
      expect(loadAsync).not.toHaveBeenCalled();
    } finally {
      loadAsync.mockRestore();
    }
  });

  it("answers a cut or foreign file as one that could not be opened", async () => {
    const docx = new JSZip();
    docx.file("word/document.xml", "<w:document/>");
    const whole = await docx.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    for (const data of [whole.subarray(0, whole.length - 10), Buffer.from("Chapter One"), Buffer.alloc(0)]) {
      expect(refusal(await DocumentArchive.open(data, "Word document").catch((caught: unknown) => caught))).toEqual({
        code: "UNREADABLE_FILE",
        message: "That Word document could not be opened."
      });
    }
  });

  it("refuses an EPUB chapter past the content document limit", async () => {
    const data = zipArchive([
      { path: "chapter.xhtml", deflated: zeroBomb(EPUB_DOCUMENT_MAX_BYTES / MIB + 1), claimedSize: 10 }
    ]);
    expect(refusal(await extractEpubText(data).catch((caught: unknown) => caught)).code).toBe("FILE_TOO_LARGE");
  });

  it("still reads an ordinary EPUB and Word document", async () => {
    const epub = new JSZip();
    epub.file("chapter.xhtml", "<html><body><p>Snow fell.</p></body></html>");
    expect(await extractEpubText(await epub.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }))).toBe("Snow fell.");
    const docx = new JSZip();
    docx.file("word/document.xml", "<w:document><w:body><w:p><w:r><w:t>Snow fell.</w:t></w:r></w:p></w:body></w:document>");
    expect((await extractDocxText(await docx.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }))).trim()).toBe("Snow fell.");
    const commented = await docx.generateAsync({ type: "nodebuffer", compression: "DEFLATE", comment: "Saved by a tool that signs its files." });
    expect((await extractDocxText(commented)).trim()).toBe("Snow fell.");
    const zip64 = zipArchive([{ path: "word/document.xml", text: "<w:p><w:r><w:t>Snow fell.</w:t></w:r></w:p>", zip64Offset: true }], { zip64: true, comment: "ZIP64" });
    expect((await extractDocxText(zip64)).trim()).toBe("Snow fell.");
  });
});
