/**
 * The one definition of what an exact replacement does.
 *
 * A book edit that is a literal find/replace needs no model: the result is
 * computable, so it can be previewed before the user approves it and applied
 * without a provider call. That only holds if the preview and the apply agree
 * exactly, and they run in different processes — the API quotes the edit, the
 * worker performs it. Hence one shared implementation here, in the leaf package
 * both can import, and hence `preserveCase` travelling *inside* the replacement
 * rather than beside it: the flag cannot get separated from the terms whose
 * meaning it changes.
 *
 * Plain string scanning, deliberately: no regex, no word boundaries. What the
 * preview shows is exactly what lands.
 */

export type ExactReplacement = {
  from: string;
  to: string;
  /**
   * Match without regard to case, and carry each occurrence's capitalization
   * over to the replacement.
   *
   * Off by default, so the ordinary path stays a byte-for-byte literal swap. It
   * is turned on only when the literal text appears nowhere but a
   * case-insensitive match does — a user who types "replace rabbit with fly"
   * about a book that writes "Rabbit" means that book, and the alternative is
   * silently falling back to regenerating every page.
   */
  preserveCase?: boolean | undefined;
};

export function applyExactReplacement(text: string, replacement: ExactReplacement): string {
  if (!replacement.from) {
    return text;
  }
  if (!replacement.preserveCase) {
    return text.split(replacement.from).join(replacement.to);
  }
  return mapOccurrences(text, replacement.from, (match) => matchCase(match, replacement.to)).text;
}

export function countExactMatches(text: string, replacement: ExactReplacement): number {
  if (!replacement.from) {
    return 0;
  }
  if (!replacement.preserveCase) {
    return text.split(replacement.from).length - 1;
  }
  return mapOccurrences(text, replacement.from, (match) => match).count;
}

export function hasExactMatch(text: string, replacement: ExactReplacement): boolean {
  return countExactMatches(text, replacement) > 0;
}

/**
 * The lines an exact replacement would change, as before/after pairs.
 *
 * Only lines that actually differ are returned, so a whole-book replacement of
 * one name yields the handful of lines that mention it rather than the book.
 * `limit` caps the result; the caller reports the true match count separately.
 */
export function exactReplacementLineDiff(
  text: string,
  replacement: ExactReplacement,
  limit = Number.POSITIVE_INFINITY
): Array<{ before: string; after: string }> {
  if (!replacement.from) {
    return [];
  }
  const changed: Array<{ before: string; after: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    if (changed.length >= limit) {
      break;
    }
    const after = applyExactReplacement(line, replacement);
    if (after !== line) {
      changed.push({ before: line, after });
    }
  }
  return changed;
}

/** Walks case-insensitive occurrences of `needle`, rewriting each through `render`. */
function mapOccurrences(
  text: string,
  needle: string,
  render: (match: string) => string
): { text: string; count: number } {
  // Lowercasing can change a string's *length* for some scripts — "İ" (U+0130)
  // lowercases to two UTF-16 units — so an index into the lowercased haystack
  // does not index the original text: every match after such a character lands
  // one unit off per occurrence and splices the page mid-word. The haystack is
  // therefore built per character alongside a map from each of its units back
  // to the original index, and every slice below goes through that map.
  const target = needle.toLowerCase();
  let haystack = "";
  const origin: number[] = [];
  for (let index = 0; index < text.length; ) {
    const character = String.fromCodePoint(text.codePointAt(index)!);
    const lower = character.toLowerCase();
    for (let unit = 0; unit < lower.length; unit += 1) {
      origin.push(index);
    }
    haystack += lower;
    index += character.length;
  }
  origin.push(text.length);

  let out = "";
  let cursor = 0;
  let emitted = 0;
  let count = 0;
  for (;;) {
    const found = haystack.indexOf(target, cursor);
    if (found === -1) {
      break;
    }
    const end = found + target.length;
    const textStart = origin[found]!;
    const textEnd = origin[end]!;
    // A hit that starts or ends inside one original character's lowercase
    // expansion matches a fragment no slice of the original can express
    // (e.g. the bare "i" inside İ's "i̇"). Skip it rather than guess.
    const startsMidCharacter = found > 0 && origin[found - 1] === textStart;
    const endsMidCharacter = end < haystack.length && origin[end - 1] === textEnd;
    if (startsMidCharacter || endsMidCharacter || textEnd <= textStart) {
      cursor = found + 1;
      continue;
    }
    out += text.slice(emitted, textStart) + render(text.slice(textStart, textEnd));
    emitted = textEnd;
    cursor = end;
    count += 1;
  }
  return { text: out + text.slice(emitted), count };
}

/**
 * Carries the capitalization of the replaced text onto its replacement, the way
 * a "preserve case" replace does in an editor: RABBIT → FLY, Rabbit → Fly,
 * rabbit → fly.
 */
function matchCase(match: string, replacement: string): string {
  if (!replacement) {
    return replacement;
  }
  const letters = [...match].filter((character) => character.toLowerCase() !== character.toUpperCase());
  if (letters.length > 1 && letters.every((character) => character === character.toUpperCase())) {
    return replacement.toUpperCase();
  }
  const first = letters[0];
  if (first && first === first.toUpperCase()) {
    return replacement[0]!.toUpperCase() + replacement.slice(1);
  }
  if (first && first === first.toLowerCase()) {
    return replacement[0]!.toLowerCase() + replacement.slice(1);
  }
  return replacement;
}
