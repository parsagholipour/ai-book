import { randomUUID } from "node:crypto";
import { renderToString } from "katex";
import { bookMatterSectionEnd } from "./bookMatterPages.js";
import { mathAt } from "./markdownMathSyntax.js";

/**
 * Protect TeX before Markdown consumes its backslashes and underscores, then
 * restore rendered MathML before HTML sanitization. Each renderer keeps its
 * existing Markdown parser. Native MathML needs neither scripts nor fonts
 * fetched by the PDF renderer or an EPUB reader.
 */
export function prepareMarkdownMath(markdown: string): { markdown: string; restore: (html: string) => string } {
  const prefix = `BOOKMATH${randomUUID().replaceAll("-", "")}X`;
  const rendered: string[] = [];
  const output = replaceMarkdownMath(markdown, (expression) => {
    const html = renderMathMl(expression);
    if (!html) return undefined;
    const placeholder = `${prefix}${rendered.length}END`;
    rendered.push(html);
    return placeholder;
  });
  return {
    markdown: output,
    restore: (html) => html.replace(new RegExp(`${prefix}(\\d+)END`, "g"), (placeholder, index: string) => rendered[Number(index)] ?? placeholder)
  };
}

export type MarkdownMath = { tex: string; display: boolean; raw: string };

/** A bounded, untrusted TeX render shared by the HTML and Word exporters. */
export function renderMathMl(expression: Pick<MarkdownMath, "tex" | "display">): string | undefined {
  try {
    return renderToString(expression.tex, {
      output: "mathml", displayMode: expression.display, trust: false,
      throwOnError: true, strict: "ignore", maxExpand: 200, maxSize: 20
    }).replace(/<annotation\b[^>]*>[\s\S]*?<\/annotation>/g, "");
  } catch {
    // Unknown TeX stays visible; a bad equation cannot fail the export or
    // swallow adjacent text. Macro state is local to this expression.
    return undefined;
  }
}

/** Replace prose math before Markdown can consume its escapes or table pipes. */
export function replaceMarkdownMath(markdown: string, replace: (expression: MarkdownMath) => string | undefined): string {
  let output = "";
  let at = 0;
  while (at < markdown.length) {
    const protectedEnd = literalEnd(markdown, at);
    if (protectedEnd > at) {
      output += markdown.slice(at, protectedEnd);
      at = protectedEnd;
      continue;
    }
    const expression = mathAt(markdown, at);
    if (expression) {
      const raw = markdown.slice(at, expression.end);
      output += replace({ tex: expression.tex, display: expression.display, raw }) ?? raw;
      at = expression.end;
    } else if (markdown[at] === "\\" && at + 1 < markdown.length) {
      output += markdown.slice(at, at + 2);
      at += 2;
    } else output += markdown[at++]!;
  }
  return output;
}

/**
 * Fences, code spans, HTML markup and link destinations are not prose math, and
 * neither is the title page or matter sheet the compiler wrote: every word in
 * them is the reader's, typed into a form, and a pen name of `$x$` is a name.
 */
function literalEnd(text: string, at: number): number {
  if (at === 0 || text[at - 1] === "\n") {
    const matter = bookMatterSectionEnd(text, at);
    if (matter !== undefined) return matter;
    const lineEnd = text.indexOf("\n", at);
    const line = text.slice(at, lineEnd < 0 ? text.length : lineEnd);
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const closing = new RegExp(`^ {0,3}${fence[1]![0]}{${fence[1]!.length},}[ \\t]*$`, "gm");
      closing.lastIndex = lineEnd < 0 ? text.length : lineEnd + 1;
      const end = closing.exec(text);
      return end ? end.index + end[0].length : text.length;
    }
    if (/^(?: {4}|\t)/.test(line)) return lineEnd < 0 ? text.length : lineEnd + 1;
  }
  if (text[at] === "`") {
    const delimiter = /^`+/.exec(text.slice(at))![0];
    let end = text.indexOf(delimiter, at + delimiter.length);
    while (end >= 0) {
      if (text[end - 1] !== "`" && text[end + delimiter.length] !== "`") return end + delimiter.length;
      end = text.indexOf(delimiter, end + delimiter.length);
    }
    return at + delimiter.length;
  }
  if (text[at] === "<") {
    const raw = /^<(pre|code|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/i.exec(text.slice(at));
    const tag = raw ?? /^(?:<!--[\s\S]*?-->|<[^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>)/.exec(text.slice(at));
    if (tag) return at + tag[0].length;
  }
  if (text.startsWith("](", at)) {
    let depth = 1;
    for (let cursor = at + 2; cursor < text.length; cursor += 1) {
      if (text[cursor] === "\\") cursor += 1;
      else if (text[cursor] === "(") depth += 1;
      else if (text[cursor] === ")" && --depth === 0) return cursor + 1;
      else if (text[cursor] === "\n") break;
    }
  }
  return at;
}
