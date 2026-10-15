import { describe, expect, it } from "vitest";
import { DOCX_TOMEZA_CREDIT_BOOKMARK, withoutDocxCompilerCredit } from "./docxBookMatter.js";
import { LINEAR_TIME_CEILING_MS } from "./ingestion/testing/linearTime.js";

function readMs(run: () => unknown): number {
  let best = Number.POSITIVE_INFINITY;
  for (let read = 0; read < 2; read += 1) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

/** What the function was before its ends were indexed: the answers it must keep. */
function searchingEachEnd(paragraph: string): string {
  let result = "";
  let offset = 0;
  for (const start of paragraph.matchAll(/<w:bookmarkStart\b[^>]*\/>/g)) {
    if (start.index < offset || start[0].match(/\bw:name=["']([^"']+)["']/)?.[1] !== DOCX_TOMEZA_CREDIT_BOOKMARK) continue;
    const id = start[0].match(/\bw:id=["'](\d+)["']/)?.[1];
    if (!id) continue;
    const from = start.index + start[0].length;
    const following = paragraph.slice(from);
    const end = following.search(new RegExp(`<w:bookmarkEnd\\b[^>]*\\bw:id=["']${id}["'][^>]*/>`));
    if (end < 0) continue;
    result += paragraph.slice(offset, from) + following.slice(0, end).replace(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>/g, "");
    offset = from + end;
  }
  return result + paragraph.slice(offset);
}

const start = (id: number | string, name = DOCX_TOMEZA_CREDIT_BOOKMARK) => `<w:bookmarkStart w:id="${id}" w:name="${name}"/>`;
const end = (id: number | string) => `<w:bookmarkEnd w:id="${id}"/>`;
const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;

const PARAGRAPHS = [
  `<w:p>${start(1)}${run("Made with Tomeza")}${end(1)}</w:p>`,
  `<w:p>${run("Before ")}${start(1)}${run("credit")}${end(1)}${run(" after")}</w:p>`,
  `<w:p>${start(1)}${run("unended credit")}</w:p>`,
  `<w:p>${start(2, "Other")}${run("kept")}${end(2)}</w:p>`,
  `<w:p>${start(1)}${run("a")}${end(2)}${run("b")}${end(1)}</w:p>`,
  `<w:p>${start(1)}${run("a")}${end(1)}${start(1)}${run("b")}${end(1)}</w:p>`,
  `<w:p>${start(3)}${start(4)}${run("x")}${end(4)}${run("y")}${end(3)}</w:p>`,
  `<w:p><w:bookmarkStart w:id='5' w:name='${DOCX_TOMEZA_CREDIT_BOOKMARK}'/><w:r><w:t>q</w:t><w:t>unclosed</w:r><w:bookmarkEnd w:id='5' /></w:p>`,
  `<w:p><w:bookmarkStart w:id="6" w:name="${DOCX_TOMEZA_CREDIT_BOOKMARK}">${run("not self-closing")}${end(6)}</w:p>`,
  `<w:p>${start(7)}${run("x")}<w:bookmarkEnd w:id="7">${run("y")}${end(7)}</w:p>`
];

describe("Word compiler credit", () => {
  it("removes exactly what the per-start search removed", () => {
    for (const paragraph of PARAGRAPHS) expect(withoutDocxCompilerCredit(paragraph), paragraph).toBe(searchingEachEnd(paragraph));
    expect(withoutDocxCompilerCredit(PARAGRAPHS[1]!)).toBe(
      `<w:p>${run("Before ")}${start(1)}<w:r></w:r>${end(1)}${run(" after")}</w:p>`
    );
  });

  it("indexes the ends once instead of searching the paragraph from every start", () => {
    // 48,000 unended credit starts took 6 s before; a 124 KB .docx held the API for 16.7 s.
    for (const starts of [4_800, 48_000]) {
      const unended = `<w:p>${start(1).repeat(starts)}</w:p>`;
      const unclosedRuns = `<w:p>${start(1)}${"<w:t>".repeat(starts)}${end(1)}</w:p>`;
      for (const [label, paragraph] of [["unended starts", unended], ["unclosed text runs", unclosedRuns]] as const) {
        const ms = readMs(() => withoutDocxCompilerCredit(paragraph));
        expect(ms, `${label} × ${starts}: ${ms.toFixed(1)} ms`).toBeLessThan(LINEAR_TIME_CEILING_MS);
      }
    }
  });
});
