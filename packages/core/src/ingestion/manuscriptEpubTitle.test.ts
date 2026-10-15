import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { parseManuscript } from "./manuscriptImport.js";

const BODY = "The rain stopped, and the road opened before them.";

describe("EPUB title-page headings", () => {
  it.each(["My Book", "زمستان طولانی", "長い冬"])(
    "imports a semantic title-only page without inventing a subtitle: %s", async (title) => {
      const data = await epubWithOpening(`<section epub:type="titlepage"><h1>${title}</h1></section>`);
      const parsed = await parseManuscript({ data, format: "epub" });

      expect(parsed.bookTitle).toBe(title);
      expect(parsed.matter).toBeUndefined();
      expect(parsed.matterRemoved).toEqual(["title_page"]);
      expect(parsed.sections).toEqual([{ title: "Chapter One", text: BODY }]);
    }
  );

  it("reads a heading-only title page marked on its body", async () => {
    const data = await epubWithOpening('<h1>My Book</h1>', 'epub:type="titlepage"');
    const parsed = await parseManuscript({ data, format: "epub" });

    expect(parsed.bookTitle).toBe("My Book");
    expect(parsed.matter).toBeUndefined();
    expect(parsed.matterRemoved).toEqual(["title_page"]);
    expect(parsed.text).toBe(BODY);
  });

  it("keeps an actual subtitle on a semantic title page", async () => {
    const data = await epubWithOpening('<section epub:type="titlepage"><h1>My Book</h1><p>A Winter Journey</p></section>');
    const parsed = await parseManuscript({ data, format: "epub" });

    expect(parsed.bookTitle).toBe("My Book");
    expect(parsed.matter).toEqual({ subtitle: "A Winter Journey" });
    expect(parsed.text).toBe(BODY);
  });

  it.each(["Part One", "Chapter One"])("preserves a heading-only %s divider and package title", async (heading) => {
    const data = await epubWithOpening(`<h1>${heading}</h1>`);
    const parsed = await parseManuscript({ data, format: "epub" });

    expect(parsed.bookTitle).toBe("Package Title");
    expect(parsed.matter).toBeUndefined();
    expect(parsed.sections).toEqual([
      { title: heading, text: heading },
      { title: "Chapter One", text: BODY }
    ]);
  });
});

async function epubWithOpening(opening: string, bodyAttributes = ""): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("META-INF/container.xml", '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>');
  zip.file("OEBPS/content.opf", `<package><metadata><dc:title>Package Title</dc:title></metadata>
    <manifest>
      <item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>
      <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
    </manifest><spine><itemref idref="title"/><itemref idref="chapter"/></spine></package>`);
  zip.file("OEBPS/title.xhtml", `<html xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Opening</title></head>
    <body ${bodyAttributes}>${opening}</body></html>`);
  zip.file("OEBPS/chapter.xhtml", `<html><body><h1>Chapter One</h1><p>${BODY}</p></body></html>`);
  return zip.generateAsync({ type: "nodebuffer" });
}
