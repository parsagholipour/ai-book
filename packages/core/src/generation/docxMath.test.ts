import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { xml2js, type Element } from "xml-js";
import { generateBookDocx } from "./docx.js";

async function render(markdown: string, language = "en") {
  const zip = await JSZip.loadAsync(await generateBookDocx(markdown, {
    title: "Equations", language, imageStorageDir: "/nonexistent",
    publicApiUrl: "https://example.test"
  }));
  const xml = await zip.file("word/document.xml")!.async("string");
  const tree = xml2js(xml, { compact: false, captureSpacesBetweenElements: true }) as Element;
  return { xml, tree, rels: await zip.file("word/_rels/document.xml.rels")!.async("string") };
}

function elements(root: Element, name: string): Element[] {
  return [...(root.name === name ? [root] : []), ...(root.elements ?? []).flatMap((child) => elements(child, name))];
}

function text(root: Element): string {
  return String(root.text ?? "") + (root.elements ?? []).map(text).join("");
}

describe("DOCX equations", () => {
  it("writes inline and display TeX as editable Word equations with surrounding prose intact", async () => {
    const { xml, tree } = await render(String.raw`Before $x_i^2$ and \(\phi(n)\) after.

\[
\frac{a+b}{c} = \sqrt[3]{d}
\]

$$a \equiv b \pmod n$$

Last sentence.`);
    expect(elements(tree, "m:oMath")).toHaveLength(4);
    expect(elements(tree, "m:oMathPara")).toHaveLength(2);
    expect(elements(tree, "m:sSubSup")).toHaveLength(1);
    expect(elements(tree, "m:f")).toHaveLength(1);
    expect(elements(tree, "m:rad")).toHaveLength(1);
    expect(text(tree)).toContain("Before xi2 and ϕ(n) after.");
    expect(text(tree)).toContain("Last sentence.");
    expect(xml).not.toMatch(/\\(?:frac|phi|sqrt|pmod)|WORDMATH|<undefined>/);
    expect(elements(tree, "w:drawing")).toHaveLength(0);
  });

  it("preserves matrix cells, alignment rows, sums and integral limits", async () => {
    const { tree } = await render(String.raw`$$\begin{pmatrix}a&b\\c&d\end{pmatrix}$$

$$\begin{aligned}x&=1\\y&=2\end{aligned}$$

$$\sum_{i=1}^{n}i = \int_0^1 x\,dx$$`);
    expect(elements(tree, "m:oMath")).toHaveLength(3);
    expect(elements(tree, "m:m")).toHaveLength(2);
    expect(elements(tree, "m:mr")).toHaveLength(4);
    expect(elements(tree, "m:d")).toHaveLength(1);
    expect(elements(tree, "m:grow").some((node) => node.attributes?.["m:val"] === "1")).toBe(true);
    expect(text(tree)).toContain("abcd");
    expect(text(tree)).toContain("x=1y=2");
    expect(text(tree)).toContain("i=1");
    expect(text(tree)).toContain("dx");
  });

  it("keeps modular operators and named functions visible in valid math text runs", async () => {
    const { tree } = await render(String.raw`$$c = m^e \bmod n$$

$\sin x + \log n$ and $\gcd(e,\phi(n))=1$`);
    const equations = elements(tree, "m:oMath");
    expect(equations).toHaveLength(3);
    expect(text(equations[0]!)).toBe("c=me mod n");
    expect(text(equations[1]!)).toBe("sin x+log n");
    expect(text(equations[2]!)).toBe("gcd (e,ϕ(n))=1");
    for (const runText of elements(tree, "m:t")) {
      expect(runText.elements?.every((child) => child.type === "text")).toBe(true);
    }
  });

  it("keeps equations in chapter headings and Contents without nesting hyperlinks", async () => {
    // The Word file prints a Contents only where the compiler printed one.
    const { tree, xml } = await render('<section class="book-contents">\n</section>\n' + String.raw`## The [totient $\phi(n)$](https://example.test)

First chapter.

## Fractions $\frac{a}{b}$

Second chapter.`);
    expect(elements(tree, "m:oMath")).toHaveLength(4);
    const contentsLinks = elements(tree, "w:hyperlink").filter((node) => node.attributes?.["w:anchor"]);
    expect(contentsLinks).toHaveLength(2);
    for (const link of contentsLinks) {
      expect(elements(link, "w:hyperlink")).toHaveLength(1);
      expect(elements(link, "m:oMath")).toHaveLength(1);
    }
    expect(xml).not.toMatch(/\\(?:frac|phi)|WORDMATH/);
  });

  it("renders math in emphasis, headings, lists, quotes, link labels and table cells without splitting TeX pipes", async () => {
    const { xml, tree, rels } = await render(String.raw`### Power $x^2$

**Strong $y_1$** and [a formula $z^3$](https://example.test).

- List $a^2$

> Quote \(b^2\).

| Name | Formula |
| --- | --- |
| Norm | $\lVert x \rVert + |y|$ |`);
    expect(elements(tree, "m:oMath")).toHaveLength(6);
    expect(elements(tree, "w:tc")).toHaveLength(4);
    expect(xml).toContain("Strong ");
    expect(xml).toContain("List ");
    expect(rels).toContain('Target="https://example.test/"');
  });

  it("leaves literal code, currency and hyperlink destinations unchanged", async () => {
    const { xml, tree, rels } = await render([
      "Pay $5 and $10; escaped \\$x\\$; inline `$x^2$`.",
      "", "```tex", String.raw`\(\frac{1}{2}\)`, "```", "",
      "> ```tex", "> $x_1$", "> ```", "",
      "    $indented$", "",
      "[direct](https://example.test/$x$/)", "",
      "[reference][r]", "", "[r]: https://example.test/$y$/"
    ].join("\n"));
    expect(elements(tree, "m:oMath")).toHaveLength(0);
    expect(text(tree)).toContain(String.raw`\(\frac{1}{2}\)`);
    for (const value of ["$x^2$", "$x_1$", "$indented$", "$5 and $10", "$x$"]) expect(text(tree)).toContain(value);
    expect(rels).toContain("https://example.test/$x$/");
    expect(rels).toContain("https://example.test/$y$/");
    expect(xml + rels).not.toContain("WORDMATH");
  });

  it("keeps invalid or unsupported TeX visible without losing its delimiters or following text", async () => {
    const { tree, xml } = await render(String.raw`Before \(\unknown{x_y}\) after.

$$\phantom{x}+y$$

Then $z^2$ and an unmatched $w.`);
    expect(text(tree)).toContain(String.raw`Before \(\unknown{x_y}\) after.`);
    expect(text(tree)).toContain(String.raw`$$\phantom{x}+y$$`);
    expect(text(tree)).toContain("an unmatched $w.");
    expect(elements(tree, "m:oMath")).toHaveLength(1);
    expect(xml).not.toContain("WORDMATH");
  });

  it("escapes XML text and never creates external resources from TeX commands", async () => {
    const { xml, tree, rels } = await render(String.raw`$1 < x < 3$ and $\text{A \& B}$.

$\text{<w:hyperlink>}$

$\href{javascript:alert(1)}{x}$

$\includegraphics{/etc/passwd}$`);
    expect(text(tree)).toContain("1<x<3");
    expect(text(tree).replaceAll("\u00a0", " ")).toContain("A & B");
    expect(xml).toContain("&lt;w:hyperlink&gt;");
    expect(elements(tree, "w:hyperlink")).toHaveLength(0);
    expect(rels).not.toMatch(/javascript|passwd|TargetMode="External"/);
  });

  it("keeps equations native inside right-to-left prose", async () => {
    const { tree, xml } = await render(String.raw`رابطه \(x^2 + y^2 = z^2\) برقرار است.`, "fa");
    expect(elements(tree, "m:oMath")).toHaveLength(1);
    expect(xml).toContain("<w:bidi/>");
    expect(text(tree)).toContain("رابطه ");
    expect(text(tree)).toContain(" برقرار است.");
  });
});
