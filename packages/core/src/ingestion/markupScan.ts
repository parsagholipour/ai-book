/**
 * Linear scans over uploaded markup (Word XML, EPUB XHTML, HTML).
 *
 * An upload is parsed on the API's one event loop before any quota is
 * claimed, so a pattern that rescans the rest of the file from every place it
 * could start is every user's outage. Two shapes did exactly that (measured
 * 2026-10-12): a lazy element, `<x\b[^>]*>[\s\S]*?</x>`, read to the end of
 * the file from every opening whose close never came — `"<w:p>"` repeated
 * 40,000 times took a second, and 48,000 unclosed bookmarks in a 124 KB .docx
 * held the thread for 16.7 s — and a tag's `[^>]*` read to the end of the file
 * from every `<` after the last `>`. These helpers return exactly what those
 * regexes returned, from one pass over the text.
 */

/** The text through its last `>`: no tag, and no element closed by a tag, can end after it. */
export function throughLastTag(text: string): string {
  const end = text.lastIndexOf(">") + 1;
  return end === text.length ? text : text.slice(0, end);
}

/**
 * `text.replace(tag, replacement)` for a global pattern that matches every
 * start it can through the first `>` after it (`/<[^>]+>/g`, `/<w:p\b[^>]*>/g`).
 * Such a pattern fails a start only past the last `>`, by reading to the end of
 * the text from it, so the part after the last `>` is kept as it stands.
 *
 * A test a tag must also pass — ending in `/>`, carrying an attribute —
 * belongs in `replace`, which hands back the tag it declines. In the pattern,
 * a start that failed it after reading to its `>` was retried from every `<`
 * inside the same tag, and every one of those fails it the same way.
 */
export function replaceTags(text: string, tag: RegExp, replace: string | ((tag: string) => string)): string {
  const scope = throughLastTag(text);
  const replaced = typeof replace === "string" ? scope.replace(tag, replace) : scope.replace(tag, (match: string) => replace(match));
  return scope.length === text.length ? replaced : replaced + text.slice(scope.length);
}

export type MarkupElementKind = {
  /**
   * The opening, as a pattern: a literal (`<!--`, `<script\b`), or a tag
   * matched through the first `>` after it (`<p\b[^>]*>`). The body starts
   * where the opening's match ends.
   */
  open: RegExp;
  /**
   * The literal that ends the element, compared ignoring case when `open` is
   * (as a `<\/\1>` backreference is). It has to end in `>`. Omitted, the
   * opening is the whole element.
   */
  close?: string;
  /**
   * A tag opening this declines is no element — and neither is an opening
   * inside its tag, which ends at the same `>` with a suffix of its text.
   */
  accepts?: (opening: RegExpExecArray) => boolean;
};

export type MarkupElement = {
  /** Which kind, by its position in the list. */
  kind: number;
  start: number;
  end: number;
  opening: RegExpExecArray;
  /** The span between the opening and the close. */
  bodyStart: number;
  bodyEnd: number;
};

/**
 * Every element the global alternation `OPEN₀[\s\S]*?CLOSE₀|OPEN₁[\s\S]*?CLOSE₁|…`
 * finds, in order; where two kinds open at the same place the earlier one in
 * the list wins, as the alternation's first branch does.
 *
 * The regex learned that an element never closes from each of its openings in
 * turn, reading to the end of the text every time. An opening whose close
 * does not come proves that no later opening of its kind closes either, so
 * that kind is finished the first time.
 */
export function* markupElements(text: string, kinds: readonly MarkupElementKind[]): Generator<MarkupElement> {
  const scope = throughLastTag(text);
  const live = kinds.map((kind, index) => ({
    index,
    ...compiled(kind),
    accepts: kind.accepts,
    next: undefined as RegExpExecArray | null | undefined
  }));
  let cursor = 0;
  for (;;) {
    let best: (typeof live)[number] | undefined;
    for (const kind of live) {
      if (kind.next === undefined || (kind.next !== null && kind.next.index < cursor)) {
        kind.open.lastIndex = cursor;
        kind.next = kind.open.exec(scope);
      }
      if (kind.next && (!best || kind.next.index < best.next!.index)) best = kind;
    }
    if (!best) return;
    const opening = best.next!;
    const bodyStart = opening.index + opening[0].length;
    if (best.accepts && !best.accepts(opening)) {
      best.open.lastIndex = Math.max(bodyStart, opening.index + 1);
      best.next = best.open.exec(scope);
      continue;
    }
    if (!best.close) {
      yield { kind: best.index, start: opening.index, end: bodyStart, opening, bodyStart, bodyEnd: bodyStart };
      cursor = Math.max(bodyStart, opening.index + 1);
      continue;
    }
    best.close.lastIndex = bodyStart;
    const close = best.close.exec(scope);
    if (!close) {
      live.splice(live.indexOf(best), 1);
      continue;
    }
    const end = close.index + close[0].length;
    yield { kind: best.index, start: opening.index, end, opening, bodyStart, bodyEnd: close.index };
    cursor = end;
  }
}

/** The first of {@link markupElements}, as a non-global `match` finds it. */
export function firstMarkupElement(text: string, kinds: readonly MarkupElementKind[]): MarkupElement | undefined {
  for (const element of markupElements(text, kinds)) return element;
  return undefined;
}

/** `text.replace` over {@link markupElements}: every element, or the first `limit` of them. */
export function replaceMarkupElements(
  text: string,
  kinds: readonly MarkupElementKind[],
  replace: (element: MarkupElement, whole: string) => string,
  limit = Number.POSITIVE_INFINITY
): string {
  let result = "";
  let copied = 0;
  let count = 0;
  for (const element of markupElements(text, kinds)) {
    if (count >= limit) break;
    result += text.slice(copied, element.start) + replace(element, text.slice(element.start, element.end));
    copied = element.end;
    count += 1;
  }
  return copied === 0 ? text : result + text.slice(copied);
}

/**
 * A kind's patterns, built once: a Word document is millions of paragraphs,
 * and building them per call cost more than the scan. Sharing them is safe
 * because every read sets `lastIndex` and executes with nothing in between.
 */
const COMPILED = new WeakMap<MarkupElementKind, { open: RegExp; close: RegExp | undefined }>();

function compiled(kind: MarkupElementKind): { open: RegExp; close: RegExp | undefined } {
  let patterns = COMPILED.get(kind);
  if (!patterns) {
    patterns = {
      open: kind.open.global ? kind.open : new RegExp(kind.open.source, `${kind.open.flags}g`),
      close: kind.close === undefined ? undefined : new RegExp(escapeRegExp(kind.close), kind.open.ignoreCase ? "gi" : "g")
    };
    COMPILED.set(kind, patterns);
  }
  return patterns;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
