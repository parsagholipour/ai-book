import { markupElements, throughLastTag, type MarkupElementKind } from "./ingestion/markupScan.js";

/** Word provenance for the compiler's credit; its caption formatting stays unchanged. */
export const DOCX_TOMEZA_CREDIT_BOOKMARK = "TomezaMadeWithCredit";

/** `<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>`: one text run's words. */
const TEXT_RUN: readonly MarkupElementKind[] = [{ open: /<w:t(?:\s[^>]*)?>/g, close: "</w:t>" }];

/**
 * Only the bookmarked text is boilerplate. Keep the paragraph, hard page breaks,
 * and any reader text outside the bookmark so removing the credit loses no boundaries.
 * Older unmarked exports are ambiguous and deliberately retain their words.
 *
 * Each credit start used to search the rest of the paragraph for its own end,
 * and a paragraph of 48,000 starts with no end held the API for 16.7 s. The
 * ends are indexed once instead; a start still takes the first end after it
 * with its id, exactly as `<w:bookmarkEnd\b[^>]*\bw:id=["']ID["'][^>]*\/>` found it.
 */
export function withoutDocxCompilerCredit(paragraph: string): string {
  // Nearly every paragraph has no credit, and only a start named for it does anything.
  if (!paragraph.includes(DOCX_TOMEZA_CREDIT_BOOKMARK)) return paragraph;
  let ends: ReturnType<typeof bookmarkEnds> | undefined;
  let result = "";
  let offset = 0;
  // `<w:bookmarkStart\b[^>]*\/>`, read as the tag through its `>` that closes itself.
  for (const start of throughLastTag(paragraph).matchAll(/<w:bookmarkStart\b[^>]*>/g)) {
    if (start.index < offset || !start[0].endsWith("/>")) continue;
    if (start[0].match(/\bw:name=["']([^"']+)["']/)?.[1] !== DOCX_TOMEZA_CREDIT_BOOKMARK) continue;
    const id = start[0].match(/\bw:id=["'](\d+)["']/)?.[1];
    if (!id) continue;
    const from = start.index + start[0].length;
    ends ??= bookmarkEnds(paragraph);
    const end = ends.firstAtOrAfter(id, from);
    if (end === undefined) continue;
    result += paragraph.slice(offset, from) + withoutTextRuns(paragraph.slice(from, end));
    offset = end;
  }
  return result + paragraph.slice(offset);
}

/** Where each bookmark id ends, in order: every self-closing `<w:bookmarkEnd …/>` naming it. */
function bookmarkEnds(paragraph: string): { firstAtOrAfter(id: string, position: number): number | undefined } {
  const positions = new Map<string, number[]>();
  for (const tag of throughLastTag(paragraph).matchAll(/<w:bookmarkEnd\b[^>]*>/g)) {
    if (!tag[0].endsWith("/>")) continue;
    for (const id of new Set(Array.from(tag[0].matchAll(/\bw:id=["'](\d+)["']/g), (match) => match[1]!))) {
      const list = positions.get(id) ?? [];
      list.push(tag.index);
      positions.set(id, list);
    }
  }
  // Credit starts are read in order, so each id's cursor only moves forward.
  const cursors = new Map<string, number>();
  return {
    firstAtOrAfter(id, position) {
      const list = positions.get(id);
      if (!list) return undefined;
      let cursor = cursors.get(id) ?? 0;
      while (cursor < list.length && list[cursor]! < position) cursor += 1;
      cursors.set(id, cursor);
      return list[cursor];
    }
  };
}

function withoutTextRuns(span: string): string {
  let result = "";
  let copied = 0;
  for (const run of markupElements(span, TEXT_RUN)) {
    result += span.slice(copied, run.start);
    copied = run.end;
  }
  return result + span.slice(copied);
}
