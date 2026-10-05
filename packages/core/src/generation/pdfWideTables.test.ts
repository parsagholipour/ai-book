import { afterAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { withRenderPage, closeSharedBrowser } from "./browserPool.js";
import { buildBookPdfDocument, BOOK_PDF_MEDIA_TYPE, BOOK_PDF_OPTIONS } from "./pdfDocument.js";
import { bookPdfCss } from "./pdfCss.js";
import { scriptProfileForLanguage } from "../prompting/script.js";

afterAll(closeSharedBrowser);

it("keeps every column of a wide manuscript table inside the printable width", async () => {
  const markdown = [
    "| Primitive | Primary Security Objective | Private Key Role | Public Key Role | Interactive Requirement | Standard Implementations |",
    "| --- | --- | --- | --- | --- | --- |",
    "| Public-Key Encryption | Unidirectional message confidentiality | Inverts trapdoor to decrypt received ciphertext | Encapsulates plaintext into ciphertext | Non-interactive; offline recipient | RSA, ElGamal, ECIES |"
  ].join("\n");
  const profile = scriptProfileForLanguage("en");
  const html = await buildBookPdfDocument({ markdown, css: bookPdfCss(profile), profile });
  await withRenderPage(async (page) => {
    await page.setViewport({ width: 660, height: 1000 });
    await page.setContent(html);
    const widths = await page.evaluate(() => ({
      right: document.body.getBoundingClientRect().right,
      cells: [...document.querySelectorAll("th,td")].map((cell) => ({ right: cell.getBoundingClientRect().right, client: cell.clientWidth, scroll: cell.scrollWidth }))
    }));
    expect(widths.cells).toHaveLength(12);
    for (const cell of widths.cells) {
      expect(cell.right).toBeLessThanOrEqual(widths.right + 1);
      expect(cell.scroll).toBeLessThanOrEqual(cell.client + 1);
    }
  });
}, 30_000);

it.each(["en", "fa"])("preserves explicit numeric alignment and gives blank %s worksheets writing space", async (language) => {
  const profile = scriptProfileForLanguage(language);
  const markdown = [
    "| Category | What to record | Example or claim |",
    "| --- | --- | --- |",
    "| Public style | | |",
    "| Governing choices | | |",
    "| Documented outcomes | | |",
    "",
    "| Item | Amount | Share |",
    "| --- | ---: | :---: |",
    "| First | 1,234 | 20% |"
  ].join("\n");
  const html = await buildBookPdfDocument({ markdown, css: bookPdfCss(profile), profile });
  await withRenderPage(async (page) => {
    await page.setViewport({ width: 658, height: 1000 });
    await page.setContent(html);
    const measured = await page.evaluate(() => {
      const tables = document.querySelectorAll("table");
      const row = tables[0]!.querySelector("tbody tr")!;
      const cells = [...row.querySelectorAll("td")];
      return {
        rowHeight: row.getBoundingClientRect().height,
        widths: cells.map((cell) => cell.getBoundingClientRect().width),
        starts: cells.map((cell) => cell.getBoundingClientRect().left),
        alignments: [...tables[1]!.querySelectorAll("tbody td")].map((cell) => getComputedStyle(cell).textAlign.replace("-webkit-", ""))
      };
    });
    expect(measured.rowHeight).toBeGreaterThan(34);
    expect(measured.widths[1]).toBeGreaterThan(measured.widths[0]!);
    expect(measured.widths[2]).toBeGreaterThan(measured.widths[0]!);
    expect(measured.alignments).toEqual(["start", "right", "center"]);
    if (language === "fa") expect(measured.starts[0]).toBeGreaterThan(measured.starts[1]!);
    else expect(measured.starts[0]).toBeLessThan(measured.starts[1]!);
  });
}, 30_000);

const hasPdfText = (() => {
  try { execFileSync("pdftotext", ["-v"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

it.skipIf(!hasPdfText)("repeats column headings and keeps each ordinary row on one printed page", async () => {
  // Start near a page boundary: the old display:block table split the first
  // row and printed continuations without any column headings.
  const markdown = [
    '<div style="height: 180mm"></div>',
    "",
    "| Record | Evidence | Judgment |",
    "| --- | --- | --- |",
    ...Array.from({ length: 18 }, (_, i) =>
      `| ROWSTART${i} | ${"A dated source supports a limited claim. ".repeat(8)} ROWTEXTEND${i} | ROWEND${i} |`)
  ].join("\n");
  const profile = scriptProfileForLanguage("en");
  const html = await buildBookPdfDocument({ markdown, css: bookPdfCss(profile), profile });
  const pdf = await withRenderPage(async (page) => {
    await page.setContent(html);
    await page.emulateMediaType(BOOK_PDF_MEDIA_TYPE);
    return Buffer.from(await page.pdf(BOOK_PDF_OPTIONS));
  });
  const pages = execFileSync("pdftotext", ["-layout", "-", "-"], { input: pdf, encoding: "utf8" }).split("\f");
  expect(pages.length).toBeGreaterThan(3);
  for (let i = 0; i < 18; i++) {
    const containing = pages.filter((page) => new RegExp(`\\bROWSTART${i}\\b`).test(page));
    expect(containing, `row ${i} starts exactly once`).toHaveLength(1);
    expect(containing[0], `row ${i} stays on its page`).toMatch(new RegExp(`\\bROWEND${i}\\b`));
    expect(containing[0], `row ${i} keeps all its evidence`).toMatch(new RegExp(`\\bROWTEXTEND${i}\\b`));
    expect(containing[0]).toMatch(/Record\s+Evidence\s+Judgment/);
  }
}, 30_000);
