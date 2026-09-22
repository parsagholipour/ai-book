import { describe, expect, it } from "vitest";
import { prepareMarkdownMath } from "./markdownMath.js";

const render = (markdown: string) => { const math = prepareMarkdownMath(markdown); return math.restore(math.markdown); };

describe("Markdown math boundaries", () => {
  it.each([
    "```js\nconst price = '$5';\n\nconst math = '$x^2$';\n```",
    "~~~~text\n$x^2$\n~~~\n$y^2$\n~~~~",
    "``a `$x$` example``", "`$x^2$`", "    $x^2$\n    \\(y\\)",
    "<code>$x^2$</code>", '<a href="https://example.test/$x$/">link</a>',
    "[link](https://example.test/$x$/)", "<!-- $x^2$ -->", String.raw`Prices: \$5, $10, $20–$30.`,
    "A price of $5 and a price of $10.", "An unmatched $x stays."
  ])("leaves literal text unchanged: %s", (markdown) => {
    expect(render(markdown)).toBe(markdown);
  });

  it("does not consume later equations when earlier dollars are currency", () => {
    const result = render("Pay $5 and $10, then compute $x^2$.");
    expect(result).toContain("Pay $5 and $10, then compute ");
    expect(result.match(/<math\b/g)).toHaveLength(1);
  });

  it("renders inequalities without mistaking their less-than sign for HTML", () => {
    expect(render(String.raw`$1 < e < \phi(n)$`)).toContain("<math");
  });

  it("keeps invalid TeX visible and does not carry macro definitions across expressions", () => {
    expect(render(String.raw`Before \(\unknown{2}\) after.`)).toBe(String.raw`Before \(\unknown{2}\) after.`);
    const result = render(String.raw`\(\gdef\privateMacro{42}1\) then \(\privateMacro\)`);
    expect(result).toContain(String.raw`then \(\privateMacro\)`);
  });

  it("never authorizes links, local files or HTML through TeX commands", () => {
    const result = render(String.raw`\(\href{javascript:alert(1)}{x}\) \(\includegraphics{/etc/passwd}\) \(\htmlId{bp-1}{x}\)`);
    expect(result).not.toContain("href=");
    expect(result).not.toContain("<img");
    expect(result).not.toContain('id="bp-1"');
  });
});
