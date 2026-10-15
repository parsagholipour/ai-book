import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { parseManuscript } from "./manuscriptImport.js";

const CHAPTER = "On the fourth day Alice left home.";
const OPENING = "For three days it rained. The river swallowed the bridge and the village waited.";

describe("EPUB dedication evidence", () => {
  it.each(["Chapter One", "Kapitel Eins", "فصل اول", "第一章"])(
    "preserves a chapter named only in document metadata: %s", async (title) => {
      const opening = "For my mother, the journey had only just begun.";
      const parsed = await parseManuscript({ data: await epubWithOpening(`<p>${opening}</p>`, title), format: "epub" });

      expect(parsed.matter).toBeUndefined();
      expect(parsed.matterRemoved).toBeUndefined();
      expect(parsed.sections).toEqual([{ title, text: opening }, { title: "Chapter Two", text: CHAPTER }]);
      expect(parsed.text).toContain(opening);
    }
  );

  it.each([
    OPENING,
    "For my mother, the journey had only just begun.",
    "To Jane Doe, this was the last straw.",
    "For my mother it was already too late.",
    "For my mother. The journey had only just begun.",
    "To reach the village, Alice crossed the river before dawn.",
    "Pour trois jours, le village resta coupé du monde.",
    "Für drei Tage blieb das Dorf vom Fluss abgeschnitten.",
    "Para llegar al pueblo, Alicia cruzó el río antes del amanecer.",
    "Per tre giorni il villaggio rimase isolato.",
    "إلى القرية سارت ليلى قبل الفجر."
  ])("preserves an unheaded opening despite its spine-item boundary: %s", async (opening) => {
    const parsed = await parseManuscript({ data: await epubWithOpening(`<p>${opening}</p>`), format: "epub" });

    expect(parsed.matter).toBeUndefined();
    expect(parsed.matterRemoved).toBeUndefined();
    expect(parsed.sections).toEqual([{ title: "Opening", text: opening }, { title: "Chapter Two", text: CHAPTER }]);
    expect(parsed.text).toContain(opening);
  });

  it.each([
    "For my mother, who taught me to read.",
    "To Jane Doe, with gratitude.",
    "To Jane Doe.",
    "Pour ma mère.",
    "À mon père.",
    "Für meine Mutter.",
    "Für Jürgen Müller.",
    "Para mi madre.",
    "Para minha mãe.",
    "Per mia madre.",
    "Моей матери.",
    "إلى أمي."
  ])("still extracts an unheaded recipient dedication: %s", async (dedication) => {
    const parsed = await parseManuscript({ data: await epubWithOpening(`<p>${dedication}</p>`), format: "epub" });

    expect(parsed.matter?.dedication).toBe(dedication);
    expect(parsed.matterRemoved).toContain("dedication");
    expect(parsed.sections).toEqual([{ title: "Chapter Two", text: CHAPTER }]);
  });

  it.each([
    `<section epub:type="dedication"><p>${OPENING}</p></section>`,
    `<h1>Dedication</h1><p>${OPENING}</p>`,
    `<h1>تقدیم</h1><p>${OPENING}</p>`
  ])("honors explicit dedication markup even with chapter metadata: %s", async (body) => {
    const parsed = await parseManuscript({ data: await epubWithOpening(body, "Chapter One"), format: "epub" });

    expect(parsed.matter?.dedication).toBe(OPENING);
    expect(parsed.sections).toEqual([{ title: "Chapter Two", text: CHAPTER }]);
  });
});

async function epubWithOpening(body: string, title = "Opening"): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("META-INF/container.xml", '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>');
  zip.file("OEBPS/content.opf", `<package><metadata><dc:title>The Rain</dc:title></metadata>
    <manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/>
      <item id="b" href="b.xhtml" media-type="application/xhtml+xml"/></manifest>
    <spine><itemref idref="a"/><itemref idref="b"/></spine></package>`);
  zip.file("OEBPS/a.xhtml", `<html xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${title}</title></head><body>${body}</body></html>`);
  zip.file("OEBPS/b.xhtml", `<html><head><title>Chapter Two</title></head><body><p>${CHAPTER}</p></body></html>`);
  return zip.generateAsync({ type: "nodebuffer" });
}
