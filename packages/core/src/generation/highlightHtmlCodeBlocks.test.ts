import { describe, expect, it } from "vitest";
import { highlightHtmlCodeBlocks } from "./highlightHtmlCodeBlocks.js";

describe("highlightHtmlCodeBlocks", () => {
  it("colours a language-python listing with hljs class names", () => {
    const html = "<pre><code class=\"language-python\">while True:\n    pass</code></pre>";
    const coloured = highlightHtmlCodeBlocks(html);
    expect(coloured).toContain('class="hljs python"');
    expect(coloured).toContain('<span class="hljs-keyword">');
  });

  it("leaves a language-text listing unmarked", () => {
    const html = "<pre><code class=\"language-text\">while True:\n    pass</code></pre>";
    const coloured = highlightHtmlCodeBlocks(html);
    // highlight.js maps `text` to plaintext: the wrapper becomes `hljs text`,
    // but no keyword spans are applied.
    expect(coloured).not.toContain("hljs-keyword");
    expect(coloured).not.toMatch(/class="hljs python"/);
  });

  it("leaves an unknown language unmarked", () => {
    const html = "<pre><code class=\"language-not-a-language\">const x = 1;</code></pre>";
    expect(highlightHtmlCodeBlocks(html)).toBe(html);
  });

  it("leaves a code block with no language class unmarked", () => {
    const html = "<pre><code>const x = 1;</code></pre>";
    expect(highlightHtmlCodeBlocks(html)).toBe(html);
  });
});
