/**
 * Text helpers for durable @mentions in library-character descriptions.
 *
 * The database owns identity; these helpers own only the visible token. They
 * deliberately operate on canonical names rather than trying to rediscover a
 * character from arbitrary prose.
 *
 * **Everything here is one whole-set scan.** A description is read once, left
 * to right, and every `@` is claimed by exactly one character out of the full
 * candidate list — longest name first, an exactly-spelled name beating a
 * case-insensitive one. Scanning a single name in isolation is what let
 * renaming "Luna" rewrite the "@Luna Vega" beside her into "@Nova Vega" and
 * leave that character's mention row pointing at a token the prose no longer
 * carries. So the rewrite, the strip, the survival check and the validation
 * all consume *claimed spans*, and each of them touches only the spans its own
 * character claimed.
 */

export type LibraryCharacterMentionName = { id: string; name: string };

export type LibraryCharacterMentionRange = {
  id: string;
  name: string;
  start: number;
  end: number;
};

export type LibraryCharacterMentionClaims = {
  /** The prose with every claimed token spelled the way its owner is. */
  description: string;
  /** The claimed spans in textual order; offsets hold for both spellings. */
  ranges: LibraryCharacterMentionRange[];
};

/**
 * What continues the word an `@token` sits in.
 *
 * ZWNJ and ZWJ are in here because Persian sets them **inside** words:
 * «علی‌رضا» is one name joined by U+200C, and with the joiner outside this
 * class a saved «علی» ended cleanly in front of it and claimed the first half
 * of somebody else's name — the sub-token scar `foldCharacterName` was written
 * for, reopened one package over. The apostrophes are deliberately *out*: a
 * possessive ends a token, so "@Luna's hat" is a mention of Luna, and refusing
 * it is how a tapped character reached the model as bare prose.
 */
const NAME_CHARACTER = /[\p{L}\p{N}\p{M}\p{Pc}\u200C\u200D]/u;

/**
 * Hyphens that join two words into one.
 *
 * A hyphen is ordinary punctuation at the end of a token ("@Luna - the rabbit")
 * and a word-joiner in front of one: "@Luna-Bear" is a single word naming
 * nobody, and binding the Luna inside it is how one reader's saved face landed
 * on a character they never saved.
 */
const WORD_JOINING_HYPHEN = /[-\u2010\u2011]/u;

/**
 * Whether the code unit at `index` continues a mention token.
 *
 * Lands on either half of a surrogate pair: a trailing low surrogate is the
 * second unit of an astral letter, and treating it as "not a name character"
 * is how `@Luna` after `𐐀` bound a saved face the composer had refused.
 */
export function isLibraryCharacterNameCharacterAt(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return false;
  let start = index;
  const unit = text.charCodeAt(index);
  if (unit >= 0xdc00 && unit <= 0xdfff && index > 0) {
    const previous = text.charCodeAt(index - 1);
    if (previous >= 0xd800 && previous <= 0xdbff) start -= 1;
  }
  const point = text.codePointAt(start);
  return point !== undefined && NAME_CHARACTER.test(String.fromCodePoint(point));
}

/** Whether a complete name match at `end` stops there rather than mid-word. */
export function libraryCharacterMentionTokenEndsAt(text: string, end: number): boolean {
  if (end >= text.length) return true;
  if (isLibraryCharacterNameCharacterAt(text, end)) return false;
  return !(
    WORD_JOINING_HYPHEN.test(text.charAt(end)) && isLibraryCharacterNameCharacterAt(text, end + 1)
  );
}

/**
 * Which character owns the token opening at `at`, or null when nobody does.
 *
 * Longest name wins, and a name spelled exactly as the prose spells it beats
 * one that only matches case-insensitively — that is what keeps the two rows
 * "Bram" and "bram" (the `[userId, name]` unique index is case-sensitive) from
 * claiming each other's tokens. Two names that differ only in case and neither
 * of which is spelled the way the prose spells it claim **nothing**: a wrong
 * owner is the unrecoverable half, exactly as it is for a typed mention.
 */
function claimAt(
  text: string,
  at: number,
  candidates: readonly LibraryCharacterMentionName[]
): LibraryCharacterMentionName | null {
  let best: { mention: LibraryCharacterMentionName; exact: boolean } | null = null;
  let contested = false;
  for (const mention of candidates) {
    const end = at + 1 + mention.name.length;
    const spelling = text.slice(at + 1, end);
    if (spelling.length !== mention.name.length) continue;
    const exact = spelling === mention.name;
    if (!exact && spelling.toLowerCase() !== mention.name.toLowerCase()) continue;
    if (!libraryCharacterMentionTokenEndsAt(text, end)) continue;
    if (!best) {
      best = { mention, exact };
      contested = false;
      continue;
    }
    if (best.mention.id === mention.id) continue;
    const longer = mention.name.length - best.mention.name.length;
    if (longer > 0 || (longer === 0 && exact && !best.exact)) {
      best = { mention, exact };
      contested = false;
    } else if (longer === 0 && exact === best.exact) {
      contested = true;
    }
  }
  return best && !contested ? best.mention : null;
}

/** Every whole `@Name` token, each claimed by exactly one of `mentions`. */
export function libraryCharacterMentionRanges(
  description: string,
  mentions: readonly LibraryCharacterMentionName[]
): LibraryCharacterMentionRange[] {
  const candidates = mentions.filter((mention) => mention.id.trim() && mention.name.trim());
  const ranges: LibraryCharacterMentionRange[] = [];
  if (candidates.length === 0) return ranges;

  for (let at = description.indexOf("@"); at >= 0; ) {
    let resume = at + 1;
    if (!isLibraryCharacterNameCharacterAt(description, at - 1)) {
      const owner = claimAt(description, at, candidates);
      if (owner) {
        const end = at + 1 + owner.name.length;
        ranges.push({ id: owner.id, name: owner.name, start: at, end });
        resume = end;
      }
    }
    at = description.indexOf("@", resume);
  }
  return ranges;
}

function replaceRanges(
  description: string,
  ranges: readonly LibraryCharacterMentionRange[],
  replacement: (range: LibraryCharacterMentionRange) => string
): string {
  let result = description;
  for (const range of [...ranges].sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, range.start)}${replacement(range)}${result.slice(range.end)}`;
  }
  return result;
}

/**
 * Rewrites the tokens `mention` claims to `nextName`, leaving every other
 * character's alone.
 *
 * `siblings` are the other names competing for those spans — without them a
 * rename of "Luna" eats the "@Luna Vega" beside her.
 */
export function rewriteLibraryCharacterMention(
  description: string,
  mention: LibraryCharacterMentionName,
  nextName: string,
  siblings: readonly LibraryCharacterMentionName[] = []
): string {
  const claimed = libraryCharacterMentionRanges(description, [mention, ...siblings]).filter(
    (range) => range.id === mention.id
  );
  return replaceRanges(description, claimed, () => `@${nextName}`);
}

/**
 * Removes UI-only `@` markers while retaining the names as ordinary prose.
 *
 * The marker goes and the spelling stays: this runs over stored descriptions on
 * the delete path, where re-casing a reader's own prose is not this function's
 * business. `siblings` again names the characters whose tokens must survive.
 */
export function stripLibraryCharacterMentionMarkers(
  description: string,
  mentions: readonly LibraryCharacterMentionName[],
  siblings: readonly LibraryCharacterMentionName[] = []
): string {
  const stripped = new Set(mentions.map((mention) => mention.id));
  const claimed = libraryCharacterMentionRanges(description, [...mentions, ...siblings]).filter(
    (range) => stripped.has(range.id)
  );
  return replaceRanges(description, claimed, (range) =>
    description.slice(range.start + 1, range.end)
  );
}

/**
 * The prose to store beside a link set: every claimed token spelled the way its
 * owner is, and the spans that claim survived on.
 *
 * Canonicalizing per character used to mean one unconditional case-insensitive
 * rewrite each, so "@Bram met @bram." with both rows selected converted both
 * tokens to one name and then to the other, and the save died on a validation
 * that could never pass. One scan settles both spans at once, and a spelling
 * that differs only in case is the same length — which is what lets the ranges
 * describe the returned prose as well as the given prose.
 */
export function canonicalizeLibraryCharacterMentions(
  description: string,
  mentions: readonly LibraryCharacterMentionName[]
): LibraryCharacterMentionClaims {
  const ranges = libraryCharacterMentionRanges(description, mentions);
  return {
    description: replaceRanges(description, ranges, (range) => `@${range.name}`),
    ranges
  };
}
