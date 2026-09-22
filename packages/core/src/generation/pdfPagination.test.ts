import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bookPlanSchema } from "../schemas/book.js";
import { closeSharedBrowser } from "./browserPool.js";
import { compileBookMarkdownWithPageAnchors } from "./markdown.js";
import { generateBookPdfWithPageMap } from "./pdf.js";
import { extractPdfNamedDestinations } from "./pdfNamedDestinations.js";

afterAll(closeSharedBrowser);

describe("physical PDF page target", () => {
  it("fits the whole book, including front and back matter, and maps the fitted bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pdf-pagination-"));
    try {
      const sentence = "The keeper carried the brass key across the quiet courtyard and opened the eastern gate.";
      const compiled = compileBookMarkdownWithPageAnchors({
        plan: bookPlanSchema.parse({
          title: "The Brass Key", premise: "A keeper opens the gate.", audience: "adults", writingComplexity: 5,
          illustrationPlan: { cadence: "none", globalStyle: "none" },
          chapters: [1, 2, 3, 4].map((index) => ({ index, title: `Movement ${index}`, summary: "A journey.", targetPages: 5 }))
        }),
        authorName: "Ada Example",
        pages: Array.from({ length: 20 }, (_, index) => ({
          index: index + 1, title: `Passage ${index + 1}`,
          markdown: `Witness${String.fromCharCode(65 + index)}. ${Array.from({ length: 4 }, () => sentence.repeat(5)).join("\n\n")}`
        })),
        includeSources: true,
        researchSources: [{ title: "Archive record", url: "https://example.org/record", summary: "The complete archive record." }]
      });
      const options = { imageStorageDir: directory, publicApiUrl: "http://localhost:4001", pageMapPlan: compiled };
      const original = await generateBookPdfWithPageMap(compiled.markdown, options);
      const originalCount = extractPdfNamedDestinations(original.pdf)!.pageCount;
      const targetPageCount = originalCount - 2;
      const fitted = await generateBookPdfWithPageMap(compiled.markdown, { ...options, targetPageCount });
      const measured = extractPdfNamedDestinations(fitted.pdf)!;
      expect(measured.pageCount).toBe(targetPageCount);
      expect(fitted.pageMap?.totalPdfPages).toBe(targetPageCount);
      expect(fitted.pageMap?.pages).toHaveLength(20);
      expect(fitted.pageMap?.hasCoverPage).toBe(true);
      expect(fitted.pageMap?.contentsStartPdfPage).toBe(2);
      expect(fitted.pageMap?.backMatterStartPdfPage).toBeGreaterThan(2);

      const text = execFileSync("pdftotext", ["-", "-"], { input: fitted.pdf, encoding: "utf8" })
        .replace(/\bPage\s+\d+\b/g, " ").replace(/\s+/g, " ");
      expect(text).toContain("Ada Example");
      expect(text).toContain("Archive record");
      for (let index = 0; index < 20; index += 1) expect(text).toContain(`Witness${String.fromCharCode(65 + index)}`);
      expect(text.match(/The keeper carried the brass key/g)).toHaveLength(400);
      for (let index = 1; index <= 4; index += 1) {
        const printedPage = measured.destinations.get(`chapter-${index}`)!.pdfPage - 1;
        expect(text).toMatch(new RegExp(`Movement ${index} ${printedPage}\\b`));
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
