import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { scriptProfileForLanguage } from "../prompting/script.js";
import { generateBookEpub } from "./epub.js";
import { buildBookPdfDocument } from "./pdfDocument.js";

const markdown = String.raw`# Modular arithmetic

The public value is \(A=5^6\bmod23=8\), also written $A=8$.

\[
\frac{1}{2}+\frac{1}{2}=1
\]

$$128^2\equiv115\pmod{187}$$

Prices are $5 and $10. Literal code: \`$x^2$\`.
`.replaceAll("\\`", "`");

describe("equations in book exports", () => {
  it("renders all four math delimiters in the PDF document without scripts or remote fonts", async () => {
    const html = await buildBookPdfDocument({ markdown, css: "", profile: scriptProfileForLanguage("en") });
    expect(html.match(/<math\b/g)).toHaveLength(4);
    expect(html).toContain("<msup>");
    expect(html).toContain("<mfrac>");
    expect(html).toContain('display="block"');
    expect(html).toContain("Prices are $5 and $10.");
    expect(html).toContain("<code>$x^2$</code>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<annotation");
  });

  it("packages MathML and declares it in the EPUB manifest", async () => {
    const zip = await JSZip.loadAsync(await generateBookEpub(markdown, {
      title: "Arithmetic", language: "en", imageStorageDir: "/tmp", publicApiUrl: "http://localhost:4001"
    }));
    const chapters = await Promise.all(zip.file(/chapter-\d+\.xhtml$/).map((file) => file.async("string")));
    expect(chapters.join("\n").match(/<math\b/g)).toHaveLength(4);
    expect(await zip.file("OEBPS/content.opf")!.async("string")).toContain('properties="mathml"');
  });
});
