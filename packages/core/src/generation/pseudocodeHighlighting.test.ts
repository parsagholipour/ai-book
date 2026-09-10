import { describe, expect, it } from "vitest";
import { buildBookPdfDocument } from "./pdfDocument.js";
import { scriptProfileForLanguage } from "../prompting/script.js";

// The regenerated algorithms book's binary-search listing is explicitly
// pseudocode, so it keeps that label and stays plaintext (generation/CLAUDE.md).
const listing = [
  "```pseudocode",
  "binarySearch(items, target):",
  "    low = 0",
  "    high = length(items) - 1",
  "    while low <= high:",
  "        middle = low + (high - low) // 2",
  "        if items[middle] == target:",
  "            return middle",
  "    return not_found",
  "```"
].join("\n");

describe("pseudocode highlighting in book exports", () => {
  it("preserves explicitly tagged pseudocode as plaintext in the PDF document", async () => {
    const html = await buildBookPdfDocument({ markdown: listing, css: "", profile: scriptProfileForLanguage("en") });
    const block = html.match(/<pre><code[^>]*>[\s\S]*?<\/code><\/pre>/)?.[0];
    expect(block).toContain('class="hljs pseudocode"');
    expect(block).toContain("while low &lt;= high:");
    expect(block).toContain("    low = 0");
    expect(block).not.toContain('<span class="hljs-');
  });
});
