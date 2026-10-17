/**
 * E1b's quote guard, a prototype of the product change it would specify (the eval keeps product code
 * read-only). Today's guard (core `quoteProvenance.ts`, run in `composedChaptersPass.ts`) checks quoted
 * spans of 8+ words against the chapter's dossier excerpts only, runs only when the chapter has excerpts,
 * and strips marks only from a miss whose paragraph names a dossier document; every other miss is left.
 *
 * This one checks every quotation of `minWords`+ words — curly, guillemet, straight quotes paired in order
 * within a paragraph, and blockquotes — against everything the compose call was given, folded with core
 * `foldQuoteText` and matched across ellipses with core `spanIsVerbatim`. A miss in a history/analytical
 * chapter loses its marks (a blockquote its `>`); in a toolkit chapter it loses them only when its own
 * sentence attributes it (an attribution verb and a dossier or facts person's surname, or a document's
 * full title), because a guide's quotation marks are mostly its own scripts and sample questions; every
 * other toolkit miss is flagged and left. Pure: the host analysis imports it as well as the container variant.
 */
import { foldQuoteText, spanIsVerbatim } from "../../../packages/core/src/generation/quoteProvenance.ts";
import { wordCount } from "../lib/text.ts";

export const GUARD_MIN_WORDS = 5;

export type GuardMode = "history" | "toolkit";
export type GuardSpanKind = "curly" | "guillemet" | "straight" | "blockquote";
export type GuardAction = "verbatim" | "stripped" | "flagged";

export type GuardSpan = {
  text: string;
  words: number;
  /** Offsets in the input: the opening mark to just past the closing mark (a blockquote: its paragraph). */
  start: number;
  end: number;
  kind: GuardSpanKind;
  action: GuardAction;
  /** For a toolkit strip: the document or person the paragraph names. */
  attributedTo?: string;
};

export type GuardDocument = { title?: string | undefined; people?: readonly string[] | undefined };

export type GuardReport = {
  markdown: string;
  spans: GuardSpan[];
  unverified: number;
  stripped: number;
  flagged: number;
  /** Paragraphs whose straight double quotes could not be paired (odd count): their straight quotes were skipped. */
  unpairedParagraphs: number;
};

type Range = [number, number];

function fenceRanges(text: string): Range[] {
  const out: Range[] = [];
  for (const match of text.matchAll(/^(```|~~~)[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm)) out.push([match.index!, match.index! + match[0].length]);
  return out;
}

function paragraphRanges(text: string): Range[] {
  const out: Range[] = [];
  let start = 0;
  for (const match of text.matchAll(/\n[ \t]*\n\s*/g)) {
    if (match.index! > start) out.push([start, match.index!]);
    start = match.index! + match[0].length;
  }
  if (start < text.length) out.push([start, text.length]);
  return out;
}

/** Inline quotation spans of one paragraph, as [opener offset, closer offset] pairs (absolute). */
function inlineSpans(text: string, [from, to]: Range): { spans: Array<{ open: number; close: number; kind: GuardSpanKind }>; unpaired: boolean } {
  const spans: Array<{ open: number; close: number; kind: GuardSpanKind }> = [];
  const straight: number[] = [];
  let curlyOpen = -1;
  let guillemetOpen = -1;
  for (let index = from; index < to; index += 1) {
    const char = text[index];
    if (char === "“") {
      if (curlyOpen < 0) curlyOpen = index;
    } else if (char === "”") {
      if (curlyOpen >= 0) spans.push({ open: curlyOpen, close: index, kind: "curly" });
      curlyOpen = -1;
    } else if (char === "«") {
      if (guillemetOpen < 0) guillemetOpen = index;
    } else if (char === "»") {
      if (guillemetOpen >= 0) spans.push({ open: guillemetOpen, close: index, kind: "guillemet" });
      guillemetOpen = -1;
    } else if (char === "\"" && curlyOpen < 0 && guillemetOpen < 0) {
      straight.push(index);
    }
  }
  const unpaired = straight.length % 2 === 1;
  if (!unpaired) for (let index = 0; index + 1 < straight.length; index += 2) spans.push({ open: straight[index]!, close: straight[index + 1]!, kind: "straight" });
  return { spans: spans.sort((a, b) => a.open - b.open), unpaired };
}

/** Emphasis markers a writer may put inside a quotation; the source has none. */
const plain = (text: string) => text.replace(/[*_]+/g, "");

const ATTRIBUTION =
  /\b(?:said|says|wrote|writes|told|tells|declared|declares|stated|states|announced|recalled|remarked|insisted|argued|argues|asked|replied|noted|notes|observed|testified|warned|warns|called|calls|defined|defines|described|describes|put it|puts it|according to|in (?:his|her|their|its) words|quoted|reported|reports|explained|explains|concluded|concludes|recommended|recommends|advised|advises|reads|read)\b/i;

/** The quotation's own sentence: back to the previous sentence end or line break, on to the next. */
function sentenceAround(text: string, open: number, close: number): string {
  let start = open;
  while (start > 0 && !/[\n.!?]/.test(text[start - 1]!)) start -= 1;
  let end = close + 1;
  while (end < text.length && !/[\n.!?]/.test(text[end]!)) end += 1;
  return text.slice(start, end);
}

/** Surnames: the last capitalised word of each name in a "A, B and C" list. */
function surnames(people: readonly string[]): string[] {
  return people
    .flatMap((person) => person.split(/,|;|\s+and\s+|\(/))
    .map((name) => name.trim().split(/\s+/).filter((word) => /^\p{Lu}[\p{L}'’-]{2,}$/u.test(word)).at(-1))
    .filter((name): name is string => Boolean(name));
}

/**
 * The source a toolkit quotation is hung on: its own sentence carries an attribution verb and names a
 * dossier or facts person (case-sensitive surname) or a document's full title. A guide's subject words
 * ("feedback", "deforestation") recur in its document titles, so title words alone attribute nothing.
 */
function attribution(sentence: string, documents: readonly GuardDocument[]): string | undefined {
  if (!ATTRIBUTION.test(sentence)) return undefined;
  const folded = ` ${foldQuoteText(sentence)} `;
  for (const document of documents) {
    if (document.title && foldQuoteText(document.title).length >= 12 && folded.includes(` ${foldQuoteText(document.title)} `)) return document.title;
    const named = surnames(document.people ?? []).find((surname) => new RegExp(`(^|[^\\p{L}])${surname}([^\\p{L}]|$)`, "u").test(sentence));
    if (named) return named;
  }
  return undefined;
}

export function fidelityGuard(
  markdown: string,
  options: { material: readonly string[]; mode: GuardMode; documents?: readonly GuardDocument[]; minWords?: number }
): GuardReport {
  const minWords = options.minWords ?? GUARD_MIN_WORDS;
  const folded = options.material.map((text) => foldQuoteText(text)).filter(Boolean);
  const verbatim = (span: string) => spanIsVerbatim(plain(span), folded);
  const fences = fenceRanges(markdown);
  const spans: GuardSpan[] = [];
  // Edits as [offset, length to delete]; applied from the end.
  const deletions: Array<[number, number]> = [];
  let unpairedParagraphs = 0;
  const decide = (sentence: string): { action: GuardAction; attributedTo?: string } => {
    if (options.mode === "history") return { action: "stripped" };
    const named = attribution(sentence, options.documents ?? []);
    return named ? { action: "stripped", attributedTo: named } : { action: "flagged" };
  };
  for (const range of paragraphRanges(markdown)) {
    if (fences.some(([start, end]) => range[0] < end && range[1] > start)) continue;
    const paragraph = markdown.slice(range[0], range[1]);
    const lines = paragraph.split("\n");
    if (lines.every((line) => line.trim() === "" || /^\s*>/.test(line))) {
      const quoted = lines.map((line) => line.replace(/^\s*>\s?/, "").replace(/^[“"«]|[”"»]$/g, "").trim()).filter(Boolean);
      const checked = quoted.filter((line) => wordCount(line) >= minWords);
      if (checked.length === 0) continue;
      const missed = checked.some((line) => !verbatim(line));
      const decision = missed ? decide(paragraph) : { action: "verbatim" as const };
      spans.push({ text: quoted.join(" / "), words: wordCount(quoted.join(" ")), start: range[0], end: range[1], kind: "blockquote", ...decision });
      if (decision.action === "stripped") {
        let offset = range[0];
        for (const line of lines) {
          // The `>` and any quotation marks a writer also put at the line's edges.
          const marker = line.match(/^\s*>\s?[“"«]?/);
          if (marker) deletions.push([offset, marker[0].length]);
          const closer = line.match(/[”"»](?=[.,;:!?)\]]*\s*$)/);
          if (marker && closer && /[“"«]$/.test(marker[0])) deletions.push([offset + closer.index!, 1]);
          offset += line.length + 1;
        }
      }
      continue;
    }
    const { spans: found, unpaired } = inlineSpans(markdown, range);
    if (unpaired) unpairedParagraphs += 1;
    for (const { open, close, kind } of found) {
      const inner = markdown.slice(open + 1, close);
      const words = wordCount(inner);
      if (words < minWords) continue;
      const decision = verbatim(inner) ? { action: "verbatim" as const } : decide(sentenceAround(markdown, open, close));
      spans.push({ text: inner, words, start: open, end: close + 1, kind, ...decision });
      if (decision.action === "stripped") deletions.push([open, 1], [close, 1]);
    }
  }
  let text = markdown;
  for (const [offset, length] of deletions.sort((a, b) => b[0] - a[0])) text = `${text.slice(0, offset)}${text.slice(offset + length)}`;
  return {
    markdown: text,
    spans,
    unverified: spans.filter((span) => span.action !== "verbatim").length,
    stripped: spans.filter((span) => span.action === "stripped").length,
    flagged: spans.filter((span) => span.action === "flagged").length,
    unpairedParagraphs
  };
}

/** Every string a call was given: its system and user messages, and every string leaf of the parsed payload. */
export function suppliedMaterial(messages: ReadonlyArray<{ role: string; content: string }>, payload: unknown): string[] {
  const leaves: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") leaves.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(payload);
  return [...messages.filter((message) => message.role === "system").map((message) => message.content), ...leaves];
}

/** Dossier documents and the people a toolkit's facts and passages are attributed to. */
export function guardDocuments(payload: unknown): GuardDocument[] {
  const record = (payload ?? {}) as { dossier?: unknown; facts?: unknown };
  const out: GuardDocument[] = [];
  for (const entry of Array.isArray(record.dossier) ? (record.dossier as Array<Record<string, unknown>>) : []) {
    const people = [entry.author, entry.speaker, entry.source].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    out.push({ ...(typeof entry.document === "string" ? { title: entry.document } : {}), people });
  }
  for (const entry of Array.isArray(record.facts) ? (record.facts as Array<Record<string, unknown>>) : []) {
    if (typeof entry.from !== "string") continue;
    const [authors, ...title] = entry.from.split(",");
    out.push({ title: title.join(",").trim() || entry.from, people: (authors ?? "").split(/\s+and\s+|;\s*/).map((name) => name.trim()).filter(Boolean) });
  }
  return out;
}

/** History/analytical unless the prompt carries the toolkit's example-people or quotation rule. */
export function guardModeFor(system: string): GuardMode {
  return /this book's own examples, made up for it|Quotation marks around a real person's or a document's words/.test(system) ? "toolkit" : "history";
}
