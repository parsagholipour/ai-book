/** Replay the exact missing-OCR symptom using public metadata captured from the failed run. */
import { readFileSync } from "node:fs";
import { fetchPrimaryText } from "../../../../../packages/core/src/generation/primarySources.js";

const metadata = JSON.parse(readFileSync(new URL("./the-casement-report-metadata.json", import.meta.url), "utf8"));
const identifier = metadata.identifier as string;
const file = metadata.files.find((entry: { format?: string; name?: string }) => entry.format === "DjVuTXT");
if (!file?.name) throw new Error("Fixture has no public OCR file; it cannot reproduce this failure.");
const textUrl = `https://archive.org/download/${identifier}/${encodeURIComponent(file.name)}`;
const requested: string[] = [];
const body = "The commissioner recorded the testimony and reported the conduct of the officials. ".repeat(40);
const candidate = { host: "archive" as const, title: "The Casement Report", author: "Roger Casement", year: "1904", url: `https://archive.org/details/${identifier}`, textUrl: `https://archive.org/download/${identifier}/${identifier}_djvu.txt` };
const actual = await fetchPrimaryText(candidate, async (url) => {
  requested.push(url);
  if (url === `https://archive.org/metadata/${identifier}`) return { status: 200, text: JSON.stringify(metadata) };
  if (url === textUrl) return { status: 200, text: body };
  return { status: 404, text: "" };
});
console.log(JSON.stringify({ identifier, expectedFile: file.name, retrievedWords: actual.split(/\s+/).filter(Boolean).length, requested }, null, 2));
if (actual.length === 0) throw new Error("Available source text was lost: the archive item ID differs from its OCR filename.");
