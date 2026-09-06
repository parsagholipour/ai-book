import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Colours marked-up `<pre><code class="language-…">` listings with the same
 * highlight.js the PDF already uses. EPUB cannot go through md-to-pdf's
 * `getHtml` (that would pull this repo's marked@18 onto the typesetter), so
 * the look-decision lives here instead of in the packager.
 */
export function highlightHtmlCodeBlocks(html: string): string {
  return html.replace(
    /<pre><code(?: class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/gi,
    (full, language: string | undefined, escaped: string) => {
      if (!language) return full;
      const highlighted = highlightWithHljs(language, decodeXmlEntities(escaped));
      return highlighted === undefined ? full : `<pre><code class="hljs ${language}">${highlighted}</code></pre>`;
    }
  );
}

function highlightWithHljs(language: string, code: string): string | undefined {
  // Resolved through md-to-pdf's own require, not ours: it is md-to-pdf's copy
  // of highlight.js whose theme its `langPrefix: 'hljs '` class names match.
  const requireFromMdToPdf = createRequire(require.resolve("md-to-pdf"));
  const hljs = requireFromMdToPdf("highlight.js") as {
    getLanguage?: (name: string) => unknown;
    highlight: (first: string, second?: unknown) => { value?: string };
  };
  if (hljs.getLanguage && !hljs.getLanguage(language)) return undefined;
  try {
    const modern = hljs.highlight(code, { language });
    if (typeof modern.value === "string") return modern.value;
  } catch {
    // highlight.js 10 took (language, code)
  }
  try {
    const legacy = hljs.highlight(language, code);
    return typeof legacy.value === "string" ? legacy.value : undefined;
  } catch {
    return undefined;
  }
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
