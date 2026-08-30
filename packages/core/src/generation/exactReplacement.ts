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
 * Plain string scanning, deliberately: the needle is user text and is never
 * compiled into a pattern. What the preview shows is exactly what lands.
 *
 * It scans at **word boundaries** though, and that is the property the free
 * path rests on. A split/join is a substring swap, so "change he to she" wrote
 * "Tshe little rabbit", "replace a with b" wrote "rbbbit sbt wbs", and nothing
 * downstream could catch it: the worker takes the local patch whenever the
 * terms match, marks the page approved itself, and `reviewAppliedBookEdit`
 * re-derives the same substitution and calls it satisfied. A boundary-free
 * replacement is not "computable enough to skip the model", it is a splice
 * inside words the reader never named.
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

const REPLACEMENT_VERB = /^(?:replace|change|rename|swap|switch|turn)\b/i;
const REPLACEMENT_CONNECTOR = /^(?:with|to|into|as|by)\b/i;
// Unquoted terms are accepted only when their boundaries are self-evident.
// A space creates a noun phrase whose determiner/role/content boundary cannot
// be recovered mechanically ("the hero Rabbit" is not the name "hero
// Rabbit"). Multiword and punctuated terms remain available through quotes.
const UNQUOTED_ATOMIC_TERM = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}_'’-]*$/u;
const UNQUOTED_RESIDUAL =
  /\b(?:also|and|but|while|plus|then|except|unless|without|make|making|keep|preserve|ensure|add|remove|rewrite|use|darken|shorten|expand|foreshadow|mention|explain|reveal|tone|style|voice|mood|feel|vibe|page|chapter)\b/i;
const UNQUOTED_CONNECTOR = /\b(?:with|to|into|as|by)\b/i;
// "Harmless" means the scope changes nothing about the replacement: it restates
// that the swap is book-wide, which is what this function already returns. A
// scope that *narrows* is not harmless and cannot be discarded — the parse
// carries only `from`/`to`, so "change Bob to Rob in chapter 3" came back as a
// clean book-wide rename with the chapter silently dropped, and the worker
// applies the fast path to every page the operation holds. Those requests fail
// closed into the ordinary rewrite, which is scoped by the operation instead.
const HARMLESS_SCOPE =
  /^(?:everywhere|globally|(?:throughout|across|in|over)\s+(?:the\s+)?(?:(?:whole|entire|full)\s+)?(?:book|story|manuscript|all\s+pages?)|on\s+(?:all|every)\s+pages?|for\s+(?:all|every)\s+occurrences?)$/i;
/**
 * Closed-class words no find/replace may swap on the free path.
 *
 * Word boundaries stop the splicing; they do not make every whole-word swap a
 * mechanical edit. Grammar lives in the words *around* a function word —
 * "change he to she" leaves every "him", "his" and "himself" behind, "replace a
 * with b" leaves "b rabbit sat" — so these requests are prose rewrites wearing
 * find/replace syntax, and a free, self-approving path must refuse them into
 * the paid one rather than deliver a half-done edit nothing reviews. The list
 * is English because the whole parser is: `REPLACEMENT_VERB` and
 * `REPLACEMENT_CONNECTOR` are English, so no other language reaches here.
 *
 * It is checked on both terms and only when the term *is* one bare word, so a
 * phrase that merely contains one ("the red rabbit") is untouched. Modals that
 * double as names are in deliberately: accepting "rename Will to William"
 * rewrites every "will" in the book, and refusing it only costs the reader a
 * paid rewrite that performs the same rename correctly.
 */
const GRAMMATICAL_TERMS = new Set([
  // Pronouns and possessives.
  "i", "me", "my", "mine", "myself",
  "you", "your", "yours", "yourself", "yourselves",
  "he", "him", "his", "himself",
  "she", "her", "hers", "herself",
  "it", "its", "itself",
  "we", "us", "our", "ours", "ourselves",
  "they", "them", "their", "theirs", "themselves",
  "who", "whom", "whose", "which", "what",
  "this", "that", "these", "those",
  // Articles and determiners.
  "a", "an", "the", "some", "any", "each", "every", "no", "none", "both",
  "either", "neither", "another", "such",
  // Prepositions.
  "of", "in", "on", "at", "to", "for", "with", "by", "from", "into", "onto",
  "over", "under", "above", "below", "between", "through", "during", "before",
  "after", "about", "against", "without", "within", "across", "toward",
  "towards", "upon", "off", "out", "up", "down", "near",
  // Conjunctions and subordinators.
  "and", "or", "but", "nor", "so", "yet", "if", "because", "although",
  "though", "while", "whereas", "unless", "until", "since", "than", "as",
  "when", "where",
  // Auxiliary and copular verbs, modals included.
  "be", "am", "is", "are", "was", "were", "been", "being",
  "do", "does", "did", "done",
  "have", "has", "had", "having",
  "will", "would", "shall", "should", "can", "could", "may", "might", "must",
  // Negation.
  "not"
]);

/**
 * Parses an instruction only when its complete semantic contract is one exact
 * replacement. This is deliberately narrower than an intent recognizer: a
 * recognizer may use the first two quotes to find pages for a compound edit,
 * while this function controls whether both generation and adherence review
 * may be skipped. Any text it cannot prove to be syntax or scope fails closed.
 */
export function exactReplacementFromInstruction(instruction: string): ExactReplacement | null {
  const body = stripPolitePrefix(instruction.trim());
  const verb = body.match(REPLACEMENT_VERB);
  if (!verb) {
    return null;
  }
  let remainder = body.slice(verb[0].length).trimStart();
  remainder = remainder.replace(/^(?:the\s+)?(?:(?:all|every|each)\s+)?occurrences?\s+of\s+/i, "");
  remainder = remainder.replace(/^(?:all|every|each)\s+/i, "");

  const quotedFrom = readQuotedTerm(remainder);
  if (quotedFrom) {
    const connector = quotedFrom.rest.trimStart().match(REPLACEMENT_CONNECTOR);
    if (!connector) {
      return null;
    }
    const quotedTo = readQuotedTerm(quotedFrom.rest.trimStart().slice(connector[0].length).trimStart());
    if (!quotedTo || !isHarmlessReplacementTail(quotedTo.rest)) {
      return null;
    }
    return exactTerms(quotedFrom.value, quotedTo.value, false);
  }

  const withoutTail = removeHarmlessReplacementTail(remainder);
  if (withoutTail === null) {
    return null;
  }
  const unquoted = withoutTail.match(/^(.{1,160}?)\s+(?:with|to|into|as|by)\s+(.{1,220})$/i);
  if (!unquoted) {
    return null;
  }
  const from = unquoted[1]!;
  const to = unquoted[2]!;
  if (
    !UNQUOTED_ATOMIC_TERM.test(from) ||
    !UNQUOTED_ATOMIC_TERM.test(to) ||
    UNQUOTED_RESIDUAL.test(from) ||
    UNQUOTED_RESIDUAL.test(to) ||
    UNQUOTED_CONNECTOR.test(to) ||
    /[;:\n]|[.!?]\s|,\s/.test(from) ||
    /[;:\n]|[.!?]\s|,\s/.test(to)
  ) {
    return null;
  }
  return exactTerms(from, to, false);
}

/** The queue object is only trusted when it says exactly what the instruction says. */
export function exactReplacementInstructionMatches(
  instruction: string,
  replacement: ExactReplacement
): boolean {
  if (typeof replacement.from !== "string" || typeof replacement.to !== "string") {
    return false;
  }
  const parsed = exactReplacementFromInstruction(instruction);
  return parsed !== null && parsed.from === replacement.from && parsed.to === replacement.to;
}

export function applyExactReplacement(text: string, replacement: ExactReplacement): string {
  if (!replacement.from) {
    return text;
  }
  return mapOccurrences(text, replacement.from, Boolean(replacement.preserveCase), (match) =>
    replacement.preserveCase ? matchCase(match, replacement.to) : replacement.to
  ).text;
}

export function countExactMatches(text: string, replacement: ExactReplacement): number {
  if (!replacement.from) {
    return 0;
  }
  return mapOccurrences(text, replacement.from, Boolean(replacement.preserveCase), (match) => match).count;
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

/**
 * Whether a character continues a word.
 *
 * Apostrophes and hyphens are deliberately **out**: "Rabbit's" and
 * "Rabbit-hole" are two orthographic words each, so a rename reaches both and
 * still produces well-formed prose. That is the opposite of
 * `isLibraryMentionNameCharacterAt`'s trailing-hyphen rule one file over, and
 * both are right — a hyphenated *name* is likely somebody else's, while a
 * hyphenated compound is the term the reader renamed plus a second word.
 * Combining marks and ZWNJ/ZWJ are in, for the reason that scanner keeps them:
 * they belong to the letter beside them, so "मीर" must not fire inside "मीरा"
 * and "علی" must not fire inside "علی‌رضا".
 *
 * A script that writes without spaces therefore has no whole-word match at all
 * — "猫" inside "熊猫" is a letter beside a letter — and the request lands on
 * the paid rewrite instead. That is the rule working rather than a gap in it:
 * the free path may skip the model only where the match is *provably* a whole
 * word, and 熊猫 → 熊狗 is the same splice as "scattered" → "sdogtered". The
 * model rewrite still performs the rename, and it knows what a word is.
 */
const WORD_CHARACTER = /[\p{L}\p{N}\p{M}\p{Pc}\u200C\u200D]/u;

/** Lands on either half of a surrogate pair, so an astral letter reads as one. */
function isWordCharacterAt(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) {
    return false;
  }
  let start = index;
  const unit = text.charCodeAt(index);
  if (unit >= 0xdc00 && unit <= 0xdfff && index > 0) {
    const previous = text.charCodeAt(index - 1);
    if (previous >= 0xd800 && previous <= 0xdbff) start -= 1;
  }
  const point = text.codePointAt(start);
  return point !== undefined && WORD_CHARACTER.test(String.fromCodePoint(point));
}

/**
 * Whether `needle` filling `[start, end)` of `text` stops at word boundaries.
 *
 * `\b` semantics, without building a regex out of user text: the constraint
 * applies only on a side where the needle's *own* edge is a word character. So
 * a phrase keeps its interior spaces, a needle of "." or "$5.00 (net)" matches
 * wherever it appears, and a bare word only ever replaces a whole word.
 */
function stopsAtWordBoundaries(text: string, start: number, end: number, needle: string): boolean {
  if (isWordCharacterAt(needle, 0) && isWordCharacterAt(text, start - 1)) {
    return false;
  }
  if (isWordCharacterAt(needle, needle.length - 1) && isWordCharacterAt(text, end)) {
    return false;
  }
  return true;
}

/**
 * Walks whole-word occurrences of `needle`, rewriting each through `render`.
 *
 * One scanner for both modes, so `applyExactReplacement` and
 * `countExactMatches` cannot disagree about what a match is — the count on the
 * preview card and the text the worker writes are the same walk.
 */
function mapOccurrences(
  text: string,
  needle: string,
  fold: boolean,
  render: (match: string) => string
): { text: string; count: number } {
  // Lowercasing can change a string's *length* for some scripts — "İ" (U+0130)
  // lowercases to two UTF-16 units — so an index into the lowercased haystack
  // does not index the original text: every match after such a character lands
  // one unit off per occurrence and splices the page mid-word. The haystack is
  // therefore built per character alongside a map from each of its units back
  // to the original index, and every slice below goes through that map. A
  // literal walk needs neither, and indexes the text directly.
  const target = fold ? needle.toLowerCase() : needle;
  let haystack = text;
  let origin: number[] | null = null;
  if (fold) {
    haystack = "";
    origin = [];
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
  }

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
    const textStart = origin ? origin[found]! : found;
    const textEnd = origin ? origin[end]! : end;
    // A hit that starts or ends inside one original character's lowercase
    // expansion matches a fragment no slice of the original can express
    // (e.g. the bare "i" inside İ's "i̇"). Skip it rather than guess.
    if (origin) {
      const startsMidCharacter = found > 0 && origin[found - 1] === textStart;
      const endsMidCharacter = end < haystack.length && origin[end - 1] === textEnd;
      if (startsMidCharacter || endsMidCharacter || textEnd <= textStart) {
        cursor = found + 1;
        continue;
      }
    }
    if (!stopsAtWordBoundaries(text, textStart, textEnd, needle)) {
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

type QuotedTerm = { value: string; rest: string };

function readQuotedTerm(text: string): QuotedTerm | null {
  const closing = text[0] === "\"" ? "\"" : text[0] === "“" ? "”" : text[0] === "‘" ? "’" : text[0] === "'" ? "'" : null;
  if (!closing) {
    return null;
  }
  const end = text.indexOf(closing, 1);
  if (end < 1) {
    return null;
  }
  const value = text.slice(1, end).trim();
  return value ? { value, rest: text.slice(end + 1) } : null;
}

function exactTerms(fromValue: string, toValue: string, collapseWhitespace: boolean): ExactReplacement | null {
  const clean = (value: string) => {
    const trimmed = value.trim();
    return collapseWhitespace ? trimmed.replace(/\s+/g, " ") : trimmed;
  };
  const from = clean(fromValue);
  const to = clean(toValue);
  if (!from || !to || from.length > 500 || to.length > 500) {
    return null;
  }
  if (isGrammaticalTerm(from) || isGrammaticalTerm(to)) {
    return null;
  }
  return { from, to };
}

/** A term that *is* one closed-class word — quotes around it change nothing. */
function isGrammaticalTerm(value: string): boolean {
  return UNQUOTED_ATOMIC_TERM.test(value) && GRAMMATICAL_TERMS.has(value.toLowerCase());
}

function stripPolitePrefix(value: string): string {
  let result = value;
  for (;;) {
    const stripped = result.replace(
      /^(?:please\s+|(?:can|could|would|will)\s+you\s+|i(?:'d|\s+would)\s+like\s+you\s+to\s+|i\s+want\s+you\s+to\s+)/i,
      ""
    );
    if (stripped === result) {
      return result;
    }
    result = stripped.trimStart();
  }
}

function removeHarmlessReplacementTail(value: string): string | null {
  let clean = value.trim().replace(/\s*(?:please\s*)?[.!?]+$/i, "").trim();
  clean = clean.replace(/\s*,\s*please$/i, "").trim();
  for (let split = clean.length - 1; split >= 0; split -= 1) {
    if (!/[\s,]/.test(clean[split]!)) {
      continue;
    }
    const tail = clean.slice(split + 1).trim();
    if (HARMLESS_SCOPE.test(tail)) {
      return clean.slice(0, split).replace(/,\s*$/, "").trim();
    }
  }
  return clean;
}

function isHarmlessReplacementTail(value: string): boolean {
  const tail = value.trim();
  if (/^[,.!?]*$/.test(tail) || /^,?\s*please\s*[.!?]*$/i.test(tail)) {
    return true;
  }
  const scoped = tail.match(/^,?\s*(.*?)\s*(?:,?\s*please)?\s*[.!?]*$/i);
  return Boolean(scoped && HARMLESS_SCOPE.test(scoped[1]!));
}
