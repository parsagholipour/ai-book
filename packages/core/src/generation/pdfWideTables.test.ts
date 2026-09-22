import { afterAll, expect, it } from "vitest";
import { withRenderPage, closeSharedBrowser } from "./browserPool.js";
import { buildBookPdfDocument } from "./pdfDocument.js";
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
