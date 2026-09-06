import { describe, expect, it } from "vitest";

import { codeLanguageRequest, narrowCodeLanguageIntent, pageNeedsCodeLanguage } from "./bookEditCodeScope.js";
import type { BookEditIntent, BookEditPageContext } from "./bookEditIntent.js";
import { MODEL_PAGE_NUMBERING } from "./bookPageNumbering.js";

const page = (index: number, codeLanguages?: string[], codeBlocks = codeLanguages?.length ?? 0): BookEditPageContext => ({
  id: `p${index}`,
  index,
  title: `Page ${index}`,
  summary: "",
  previewText: "",
  codeBlocks,
  ...(codeLanguages ? { codeLanguages } : {})
});

/** The book as the 2026-09-06 request found it: two pages already converted, five still Python. */
const pages = [page(1, [], 0), page(2, ["javascript"]), page(3, ["javascript"]), page(4, ["python"]), page(5, ["python"]), page(6, ["python"]), page(7, ["python"]), page(8, ["python"])];

const rewrite = (affectedPageIndexes: number[], scope: BookEditIntent["scope"] = "explicit_pages"): BookEditIntent => ({
  kind: "page_rewrite",
  confidence: 0.9,
  reasoning: "",
  affectedPageIndexes,
  assistantMessage: "I'll update the code.",
  scope,
  impact: "style_rewrite",
  clarification: "none",
  editInstruction: "Rewrite the code in JavaScript."
});

const options = { stage: "complete" as const, numbering: MODEL_PAGE_NUMBERING, readerSelected: false };

describe("codeLanguageRequest", () => {
  it("names the one fence tag a code request asks for, under its aliases", () => {
    expect(codeLanguageRequest("Use JavaScript in the codes")).toBe("javascript");
    expect(codeLanguageRequest("write the snippets in JS")).toBe("javascript");
    expect(codeLanguageRequest("make the code examples C++")).toBe("cpp");
    expect(codeLanguageRequest("On pages 3 and 4, use Python in the codes instead of JavaScript")).toBeNull();
    expect(codeLanguageRequest("Add a JavaScript code example to every page")).toBeNull();
    expect(codeLanguageRequest("Make the examples warmer")).toBeNull();
    expect(codeLanguageRequest("Use JavaScript everywhere")).toBeNull();
  });

  it("reads a page's need off its fence tags, and assumes need when they are unknown", () => {
    expect(pageNeedsCodeLanguage(page(4, ["python"]), "javascript")).toBe(true);
    expect(pageNeedsCodeLanguage(page(2, ["javascript"]), "javascript")).toBe(false);
    expect(pageNeedsCodeLanguage(page(2, ["js"]), "javascript")).toBe(false);
    expect(pageNeedsCodeLanguage(page(9, ["javascript", "pseudocode"]), "javascript")).toBe(true);
    expect(pageNeedsCodeLanguage(page(1, [], 0), "javascript")).toBe(false);
    expect(pageNeedsCodeLanguage(page(5, undefined, 1), "javascript")).toBe(true);
  });
});

describe("narrowCodeLanguageIntent", () => {
  it("re-scopes a pageless request the router pinned to the previous turn's pages onto the pages that still need the change", () => {
    const narrowed = narrowCodeLanguageIntent(rewrite([2, 3]), "Use JavaScript in the codes", pages, options);

    expect(narrowed.kind).toBe("page_rewrite");
    expect(narrowed.affectedPageIndexes).toEqual([4, 5, 6, 7, 8]);
    expect(narrowed.scope).toBe("explicit_pages");
  });

  it("answers instead of pricing when every code page is already in the language", () => {
    const done = pages.map((entry) => (entry.codeBlocks ? page(entry.index, ["javascript"]) : entry));
    const answered = narrowCodeLanguageIntent(rewrite([], "all_pages"), "Use JavaScript in the codes", done, options);

    expect(answered.kind).toBe("answer");
    expect(answered.affectedPageIndexes).toEqual([]);
    expect(answered.assistantMessage).toBe("The code in this book is already in JavaScript, so there is nothing to change.");
  });

  it("keeps a request that names its own pages on those pages, dropping only the ones already converted", () => {
    const kept = narrowCodeLanguageIntent(rewrite([2, 4]), "Use JavaScript in the codes on pages 2 and 4", pages, options);
    expect(kept.affectedPageIndexes).toEqual([4]);

    const already = narrowCodeLanguageIntent(rewrite([2, 3]), "Use JavaScript in the code on pages 2 and 3", pages, options);
    expect(already.kind).toBe("answer");
    expect(already.assistantMessage).toBe("The code on page 2 and 3 is already in JavaScript, so there is nothing to change.");

    const selected = narrowCodeLanguageIntent(rewrite([4]), "Use JavaScript in this code", pages, { ...options, readerSelected: true });
    expect(selected.affectedPageIndexes).toEqual([4]);
  });

  it("leaves everything else alone: other kinds, other stages, requests naming no language, books with no features", () => {
    const patch: BookEditIntent = { ...rewrite([2, 3]), kind: "local_patch" };
    expect(narrowCodeLanguageIntent(patch, "Use JavaScript in the codes", pages, options)).toBe(patch);
    const intent = rewrite([2, 3]);
    expect(narrowCodeLanguageIntent(intent, "Use JavaScript in the codes", pages, { ...options, stage: "plan_ready" })).toBe(intent);
    expect(narrowCodeLanguageIntent(intent, "Make the code clearer", pages, options)).toBe(intent);
    const featureless = pages.map(({ codeBlocks: _blocks, codeLanguages: _languages, ...rest }) => rest);
    expect(narrowCodeLanguageIntent(intent, "Use JavaScript in the codes", featureless, options)).toBe(intent);
    expect(narrowCodeLanguageIntent(rewrite([4, 5, 6, 7, 8]), "Use JavaScript in the codes", pages, options)).toEqual(
      rewrite([4, 5, 6, 7, 8])
    );
  });

  it("drops per-page instructions for pages it no longer targets", () => {
    const withInstructions: BookEditIntent = {
      ...rewrite([2, 4]),
      perPageInstructions: [
        { pageIndex: 2, instruction: "Keep the helper name." },
        { pageIndex: 4, instruction: "Use const." }
      ]
    };
    const narrowed = narrowCodeLanguageIntent(withInstructions, "Use JavaScript in the codes on pages 2 and 4", pages, options);
    expect(narrowed.perPageInstructions).toEqual([{ pageIndex: 4, instruction: "Use const." }]);
  });
});
