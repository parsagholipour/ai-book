/**
 * Text primitives the deterministic checks share: words, sentences, paragraphs, shingles, fences,
 * tables and a match fold. Script-aware where it is cheap (Unicode letters and marks), and
 * deliberately simple — these are measurements, not the product's own counters.
 */

const WORD = /[\p{L}\p{M}\p{N}]+(?:['’-][\p{L}\p{M}\p{N}]+)*/gu;

export function words(text: string): string[] {
  return text.match(WORD) ?? [];
}

export function wordCount(text: string): number {
  return words(text).length;
}

/** Fold quotes, dashes, whitespace and case so a quotation matches its source. */
export function foldForMatch(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[​-‏⁠﻿]/g, "")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″«»]/g, "\"")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function paragraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

/** Sentence split good enough for diffing prose: terminal punctuation followed by space and a capital/quote/digit. */
export function sentences(text: string): string[] {
  const out: string[] = [];
  for (const paragraph of paragraphs(text)) {
    if (/^(```|\|)/.test(paragraph)) {
      out.push(paragraph);
      continue;
    }
    const flat = paragraph.replace(/\s+/g, " ");
    for (const piece of flat.split(/(?<=[.!?…]["”’)\]]?)\s+(?=["“‘([]?[\p{Lu}\p{N}])/u)) {
      const trimmed = piece.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

export function shingles(tokens: readonly string[], n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + n <= tokens.length; i += 1) out.push(tokens.slice(i, i + n).join(" "));
  return out;
}

export type Fence = { info: string; body: string; raw: string };

export function fences(text: string): Fence[] {
  const out: Fence[] = [];
  const pattern = /^```([^\n]*)\n([\s\S]*?)\n```[ \t]*$/gm;
  for (const match of text.matchAll(pattern)) out.push({ info: match[1]!.trim(), body: match[2]!, raw: match[0] });
  return out;
}

/** Markdown tables: runs of lines starting with `|` that include a separator row. */
export function tables(text: string): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length >= 2 && current.some((line) => /^\|?\s*:?-{3,}/.test(line.trim()))) out.push(current);
    current = [];
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.trim().startsWith("|")) current.push(line.trim());
    else flush();
  }
  flush();
  return out;
}

/** Remove fenced blocks (figures, code) from prose before counting words or sentences. */
export function withoutFences(text: string): string {
  return text.replace(/^```[^\n]*\n[\s\S]*?\n```[ \t]*$/gm, " ");
}

/** Strip a reply wrapped whole in one Markdown fence, as the product's `unfence` does. */
export function unwrapWholeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:markdown|md|text|plain(?:text)?|prose)?[ \t]*\r?\n([\s\S]*?)\n```\s*$/i);
  return fenced ? fenced[1]! : trimmed;
}

/** Parse a model's JSON reply, tolerating one wrapping fence. Returns undefined when it does not parse. */
export function parseJsonReply(text: string): unknown {
  const body = text.trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** First and last paragraph of a chapter, for the context a pair judge sees. */
export function edges(text: string, maxWords = 160): { head: string; tail: string } {
  const list = paragraphs(withoutFences(text)).filter((paragraph) => !paragraph.startsWith("#"));
  const clip = (paragraph: string, fromEnd: boolean) => {
    const tokens = paragraph.split(/\s+/);
    if (tokens.length <= maxWords) return paragraph;
    return fromEnd ? `… ${tokens.slice(-maxWords).join(" ")}` : `${tokens.slice(0, maxWords).join(" ")} …`;
  };
  return { head: list[0] ? clip(list[0], false) : "", tail: list.at(-1) ? clip(list.at(-1)!, true) : "" };
}
