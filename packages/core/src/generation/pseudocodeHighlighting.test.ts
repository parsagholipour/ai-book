import { describe, expect, it } from "vitest";
import { buildBookPdfDocument } from "./pdfDocument.js";
import { scriptProfileForLanguage } from "../prompting/script.js";

// The regenerated algorithms book's binary-search listing is explicitly
// pseudocode, so it must keep that label while still gaining token colours.
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
  it("colours the regenerated book's pseudocode in the PDF document", async () => {
    const html = await buildBookPdfDocument({ markdown: listing, css: "", profile: scriptProfileForLanguage("en") });
    const block = html.match(/<pre><code[^>]*>[\s\S]*?<\/code><\/pre>/)?.[0];
    expect(block).toContain('class="hljs pseudocode"');
    expect(block).toContain('<span class="hljs-keyword">while</span>');
    expect(block).toContain('<span class="hljs-number">0</span>');
  });
});
