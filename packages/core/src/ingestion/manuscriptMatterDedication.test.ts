import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { parseManuscript } from "./manuscriptImport.js";

const CHAPTER = "On the fourth day Alice left home.";
const OPENING = "For three days it rained. The river swallowed the bridge and the village waited.";

describe("unheaded dedications need evidence beyond a preposition", () => {
  it.each([
    OPENING,
    "To reach the village, Alice crossed the river before dawn.",
    "Für drei Tage blieb das Dorf vom Fluss abgeschnitten.",
    "Para llegar al pueblo, Alicia cruzó el río antes del amanecer.",
    "إلى القرية سارت ليلى قبل الفجر."
  ])("preserves short opening prose before the first chapter: %s", async (opening) => {
    const parsed = await parseManuscript({
      data: Buffer.from(`${opening}\n\nChapter One\n\n${CHAPTER}`),
      format: "text"
    });

    expect(parsed.matter).toBeUndefined();
    expect(parsed.matterRemoved).toBeUndefined();
    expect(parsed.sections).toEqual([
      { title: null, text: opening },
      { title: "Chapter One", text: CHAPTER }
    ]);
    expect(parsed.text).toContain(opening);
  });

  it.each([
    ["text", `${OPENING}\n\n## Chapter One\n\n${CHAPTER}`],
    ["html", `<p>${OPENING}</p><h1>Chapter One</h1><p>${CHAPTER}</p>`],
    ["rtf", `{\\rtf1\\ansi ${OPENING}\\par Chapter One\\par ${CHAPTER}}`]
  ] as const)("preserves unheaded opening prose in %s", async (format, source) => {
    const parsed = await parseManuscript({ data: Buffer.from(source), format });
    expect(parsed.matter?.dedication).toBeUndefined();
    expect(parsed.text).toContain(OPENING);
  });

  it.each([
    "The Long Winter\nby Jane Doe",
    "© 2026 Jane Doe",
    "The Long Winter\nby Jane Doe\n© 2026 Jane Doe"
  ])("preserves short prose after a recognized matter prefix: %s", async (prefix) => {
    const parsed = await parseManuscript({
      data: Buffer.from(`${prefix}\n${OPENING}\nChapter One\n${CHAPTER}`),
      format: "text"
    });
    expect(parsed.matter?.dedication).toBeUndefined();
    expect(parsed.matterRemoved ?? []).not.toContain("dedication");
    expect(parsed.matterRemoved?.length).toBeGreaterThan(0);
    expect(parsed.text).toContain(OPENING);
  });

  it.each([
    OPENING,
    "For my mother, the journey had only just begun.",
    "To Jane Doe, this was the last straw.",
    "Für drei Tage blieb das Dorf vom Fluss abgeschnitten.",
    "Para llegar al pueblo, Alicia cruzó el río antes del amanecer.",
    "إلى القرية سارت ليلى قبل الفجر."
  ])("preserves prose even before an author's page break: %s", async (opening) => {
    const parsed = await parseManuscript({
      data: Buffer.from(`${opening}\n\f\nChapter One\n\n${CHAPTER}`),
      format: "text"
    });
    expect(parsed.matter?.dedication).toBeUndefined();
    expect(parsed.text).toContain(opening);
  });

  it.each([
    "For my mother, who taught me to read.",
    "Für meine Mutter.",
    "Para mi madre.",
    "إلى أمي."
  ])("extracts a dedication bounded by an author's page break: %s", async (dedication) => {
    const parsed = await parseManuscript({
      data: Buffer.from(`${dedication}\n\f\nChapter One\n\n${CHAPTER}`),
      format: "text"
    });
    expect(parsed.matter?.dedication).toBe(dedication);
    expect(parsed.matterRemoved).toContain("dedication");
    expect(parsed.sections).toEqual([{ title: "Chapter One", text: CHAPTER }]);
  });

  it.each([
    "This book is dedicated to my mother.",
    "In loving memory of Jane Doe.",
    "تقدیم به مادرم",
    "母に捧げる。"
  ])("extracts explicit dedication wording without a heading or page break: %s", async (dedication) => {
    const parsed = await parseManuscript({
      data: Buffer.from(`${dedication}\n\nChapter One\n\n${CHAPTER}`),
      format: "text"
    });
    expect(parsed.matter?.dedication).toBe(dedication);
    expect(parsed.sections).toEqual([{ title: "Chapter One", text: CHAPTER }]);
  });

  it.each([
    { name: "before the heading", prefix: "", heading: "\fChapter One", isolated: true },
    { name: "before the heading after a blank first page", prefix: "\f\n", heading: "\fChapter One", isolated: true },
    { name: "after the heading", prefix: "", heading: "Chapter One\f", isolated: false }
  ])("keeps a plain-text page boundary $name on the correct side", async ({ prefix, heading, isolated }) => {
    const dedication = "For my mother, who taught me to read.";
    const parsed = await parseManuscript({
      data: Buffer.from(`${prefix}${dedication}\n${heading}\n${CHAPTER}`),
      format: "text"
    });
    expect(parsed.matter?.dedication).toBe(isolated ? dedication : undefined);
    expect(parsed.sections).toEqual([
      ...(isolated ? [] : [{ title: null, text: dedication }]),
      { title: "Chapter One", text: CHAPTER }
    ]);
  });

  it.each([
    { name: "pageBreakBefore", properties: "<w:pageBreakBefore/>", before: "", isolated: true },
    { name: "an explicit break before the heading text", properties: "", before: '<w:br w:type="page"/>', isolated: true },
    { name: "disabled pageBreakBefore", properties: '<w:pageBreakBefore w:val="0"/>', before: "", isolated: false },
    { name: "an automatic rendered break", properties: "", before: "<w:lastRenderedPageBreak/>", isolated: false }
  ])("uses $name on a Word heading only when it ends the preceding page", async ({ properties, before, isolated }) => {
    const dedication = "For my mother, who taught me to read.";
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      `<?xml version="1.0"?><w:document><w:body>
        <w:p><w:r><w:t>${dedication}</w:t></w:r></w:p>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/>${properties}</w:pPr><w:r>${before}<w:t>Chapter One</w:t></w:r></w:p>
        <w:p><w:r><w:t>${CHAPTER}</w:t></w:r></w:p>
      </w:body></w:document>`
    );
    const parsed = await parseManuscript({ data: await zip.generateAsync({ type: "nodebuffer" }), format: "docx" });
    expect(parsed.matter?.dedication).toBe(isolated ? dedication : undefined);
    expect(parsed.sections).toEqual([
      ...(isolated ? [] : [{ title: null, text: dedication }]),
      { title: "Chapter One", text: CHAPTER }
    ]);
  });
});
