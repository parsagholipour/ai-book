/**
 * Text helpers for durable @mentions in library-item descriptions.
 *
 * The database owns identity; these helpers own only the visible token. They
 * deliberately operate on canonical names rather than trying to rediscover a
 * library item from arbitrary prose.
 *
 * **Everything here is one whole-set scan.** A description is read once, left
 * to right, and every `@` is claimed by exactly one item out of the full
 * candidate list — longest name first, an exactly-spelled name beating a
 * case-insensitive one. Scanning a single name in isolation is what let
 * renaming "Luna" rewrite the "@Luna Vega" beside her into "@Nova Vega" and
 * leave that item's mention row pointing at a token the prose no longer
 * carries. So the rewrite, the strip, the survival check and the validation
 * all consume *claimed spans*, and each of them touches only the spans its own
 * item claimed.
 */

export type LibraryMentionName = { id: string; name: string };

export type LibraryMentionRange = {
  id: string;
  name: string;
  start: number;
  end: number;
};

export type LibraryMentionClaims = {
  /** The prose with every claimed token spelled the way its owner is. */
  description: string;
  /** The claimed spans in textual order; offsets hold for both spellings. */
  ranges: LibraryMentionRange[];
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
export function isLibraryMentionNameCharacterAt(text: string, index: number): boolean {
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
export function libraryMentionTokenEndsAt(text: string, end: number): boolean {
  if (end >= text.length) return true;
  if (isLibraryMentionNameCharacterAt(text, end)) return false;
  return !(
    WORD_JOINING_HYPHEN.test(text.charAt(end)) && isLibraryMentionNameCharacterAt(text, end + 1)
  );
}

/**
 * Who is in the running for the token opening at `at`, and whether they tie.
 *
 * Longest name wins, and a name spelled exactly as the prose spells it beats
 * one that only matches case-insensitively — that is what keeps the two rows
 * "Bram" and "bram" (the `[userId, name]` unique index is case-sensitive) from
 * claiming each other's tokens. Two names that differ only in case and neither
 * of which is spelled the way the prose spells it claim **nothing**: a wrong
 * owner is the unrecoverable half, exactly as it is for a typed mention.
 *
 * **A tie is reported rather than swallowed, because it is not the same answer
 * as nobody matching.** A span nobody matched is prose. A contested one is a
 * span the candidate list *did* reach and could not name, and the two callers
 * below want opposite things from it: an owner is what a rewrite needs and a
 * tie has none, while a strip only ever deletes the `@` — an edit every tied
 * candidate agrees on — so it can settle a span identity cannot. Folded into
 * one `null`, `@BRAM` beside the rows "Bram" and "bram" reached the planner
 * brief and `buildLibraryCharacterPortraitPrompt` with its marker standing.
 */
function claimAt(
  text: string,
  at: number,
  candidates: readonly LibraryMentionName[]
): { mention: LibraryMentionName; contested: boolean } | null {
  let best: { mention: LibraryMentionName; exact: boolean } | null = null;
  let contested = false;
  for (const mention of candidates) {
    const end = at + 1 + mention.name.length;
    const spelling = text.slice(at + 1, end);
    if (spelling.length !== mention.name.length) continue;
    const exact = spelling === mention.name;
    if (!exact && spelling.toLowerCase() !== mention.name.toLowerCase()) continue;
    if (!libraryMentionTokenEndsAt(text, end)) continue;
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
  return best ? { mention: best.mention, contested } : null;
}

/**
 * One left-to-right pass: the spans an item owns, and the marker positions the
 * list reached without being able to name.
 *
 * The scan resumes at `at + 1` for a contested span exactly as it does for one
 * nobody matched, so the claimed half of this answer is the same set
 * `libraryMentionRanges` has always returned — a tie is extra information about
 * a pass whose verdicts are otherwise untouched. Only the `@`'s position is
 * kept for a tie: every reader of it deletes that one character, and the span's
 * extent is a fact about a name none of them may assume is the right one.
 */
function scanLibraryMentions(
  description: string,
  mentions: readonly LibraryMentionName[]
): { ranges: LibraryMentionRange[]; contested: number[] } {
  const candidates = mentions.filter((mention) => mention.id.trim() && mention.name.trim());
  const ranges: LibraryMentionRange[] = [];
  const contested: number[] = [];
  if (candidates.length === 0) return { ranges, contested };

  for (let at = description.indexOf("@"); at >= 0; ) {
    let resume = at + 1;
    if (!isLibraryMentionNameCharacterAt(description, at - 1)) {
      const claim = claimAt(description, at, candidates);
      if (claim?.contested) {
        contested.push(at);
      } else if (claim) {
        const end = at + 1 + claim.mention.name.length;
        ranges.push({ id: claim.mention.id, name: claim.mention.name, start: at, end });
        resume = end;
      }
    }
    at = description.indexOf("@", resume);
  }
  return { ranges, contested };
}

/** Every whole `@Name` token, each claimed by exactly one of `mentions`. */
export function libraryMentionRanges(
  description: string,
  mentions: readonly LibraryMentionName[]
): LibraryMentionRange[] {
  return scanLibraryMentions(description, mentions).ranges;
}

/**
 * Rewrites claimed spans from the highest offset down, so every offset still
 * ahead of the cursor keeps describing the prose it was measured against.
 *
 * The spans may arrive in any order — this sorts its own copy — and they never
 * overlap, because `libraryMentionRanges` resumes its scan at the end of the
 * claim it just made. `deleteCharactersAt` below is the same ordering rule over
 * bare positions, and the note there is why the two are not one function.
 */
function replaceRanges(
  description: string,
  ranges: readonly LibraryMentionRange[],
  replacement: (range: LibraryMentionRange) => string
): string {
  let result = description;
  for (const range of [...ranges].sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, range.start)}${replacement(range)}${result.slice(range.end)}`;
  }
  return result;
}

/**
 * Rewrites the tokens `mention` claims to `nextName`, leaving every other
 * item's alone.
 *
 * `siblings` are the other names competing for those spans — without them a
 * rename of "Luna" eats the "@Luna Vega" beside her.
 */
export function rewriteLibraryMention(
  description: string,
  mention: LibraryMentionName,
  nextName: string,
  siblings: readonly LibraryMentionName[] = []
): string {
  const claimed = libraryMentionRanges(description, [mention, ...siblings]).filter(
    (range) => range.id === mention.id
  );
  return replaceRanges(description, claimed, () => `@${nextName}`);
}

/**
 * Removes UI-only `@` markers while retaining the names as ordinary prose.
 *
 * The marker goes and the spelling stays: this runs over stored descriptions on
 * the delete path, where re-casing a reader's own prose is not this function's
 * business. `siblings` again names the items whose tokens must survive.
 *
 * **An `@` no name in the list claims is left standing**, because it is the
 * reader's own text — which is the right answer only when the list is the whole
 * of what the prose is bound to. A caller holding a link it cannot name wants
 * `stripEveryLibraryMentionMarker` below instead.
 */
export function stripLibraryMentionMarkers(
  description: string,
  mentions: readonly LibraryMentionName[],
  siblings: readonly LibraryMentionName[] = []
): string {
  const stripped = new Set(mentions.map((mention) => mention.id));
  const claimed = libraryMentionRanges(description, [...mentions, ...siblings]).filter((range) =>
    stripped.has(range.id)
  );
  return replaceRanges(description, claimed, (range) =>
    description.slice(range.start + 1, range.end)
  );
}

/**
 * The strip for a caller whose list is **the whole of what the prose is bound
 * to**: what an item claims, plus what the list reached and could not name.
 *
 * `stripLibraryMentionMarkers` above answers a narrower question and has to —
 * it takes `siblings`, so a span two of its candidates tie over may belong to
 * one that is surviving, and dropping that `@` would leave a stored row
 * pointing at a token the prose no longer carries. Nothing here has a surviving
 * sibling: every name given is one whose marker is going, so a tie costs
 * nothing to settle — both answers are the same deletion.
 *
 * That is the gap `generationDescription` (`@book-maker/db/libraryMentions`)
 * fell into. It picks between the narrow strip and
 * `stripEveryLibraryMentionMarker` on whether every *row* can be named, and two
 * rows differing only in case are both perfectly nameable — so the narrow strip
 * ran, `claimAt` refused `@BRAM` as contested, and a UI token reached the
 * planner brief and `buildLibraryCharacterPortraitPrompt`. The broad strip is
 * not the answer to it either: it exists for a list that cannot enumerate what
 * the prose carries and pays for that by taking the reader's own `@handle` with
 * it, which is a price only that case is worth paying.
 *
 * An `@` no candidate matched at all is still the reader's own text and still
 * stands, exactly as it does above — **unless the marker in front of it is one
 * this strip is deleting.** A marker is a deletion, so a run of them is not
 * what the `@` before it opens: `@@Bram` claimed its span at offset 1, dropped
 * that one `@` and answered `@Bram` — the same UI token, in the same planner
 * brief (`creationBuild.ts`) and the same
 * `buildLibraryCharacterPortraitPrompt`, one deletion later. `@@BRAM` beside
 * the rows "Bram" and "bram" leaked identically through the contested half.
 * Neither is theoretical: `libraryMentionQueryAt` opens a mention query on an
 * `@` whose left neighbour is an `@`, because an `@` is not a name character,
 * so typing `@@` and tapping the suggestion chip stores `@@Bram` with a live
 * CHARACTER row bound to the span at offset 1. Hence `indexAfterMarkers` and a
 * right-to-left scan, borrowed from `stripEveryLibraryMentionMarker` below, and
 * hence a guarantee of the same shape but narrower: **no `@` this returns
 * stands where a deleted one stood.** It cannot promise that nothing it returns
 * opens a word — an unclaimed `@Ghost` opening one is the whole of what this
 * branch is for.
 *
 * **The `tokenEnds` half of that scan is deliberately not borrowed with it.**
 * There, an `@` opening a word right where a claimed span ended
 * (`@Bram@Harbor`) is a marker whose only evidence is the token in front of it,
 * and the broad strip exists to remove markers it cannot name. Here there are
 * none to remove: the list is the whole of what the prose is bound to, so
 * `@Harbor` is the reader's text and stays it, sitting against a claimed token
 * or inside an address alike. Inheriting that exemption is how this branch
 * would start paying the `@handle` price that is only worth paying over there.
 */
export function stripBoundLibraryMentionMarkers(
  description: string,
  mentions: readonly LibraryMentionName[]
): string {
  const { ranges, contested } = scanLibraryMentions(description, mentions);
  // A claimed span is stripped by dropping its `@` and keeping the prose's
  // spelling verbatim, which is one deletion — the same edit a tie earns — so
  // the two sets are one position list rather than a replace and a delete.
  const markers = new Set([...ranges.map((range) => range.start), ...contested]);
  for (
    let at = description.lastIndexOf("@");
    at >= 0;
    at = at > 0 ? description.lastIndexOf("@", at - 1) : -1
  ) {
    // A run of deletions and nothing else: this `@` earns its own deletion only
    // by standing immediately in front of one, which is a fact about the edits
    // already decided rather than a guess about the prose. Right to left, so
    // that neighbour's verdict is in before this one asks.
    if (markers.has(at) || !markers.has(at + 1)) continue;
    // An `@` inside the reader's own word is not a marker here any more than it
    // is in the broad strip: `bram@@Bram` keeps the one sitting inside `bram@`,
    // because deleting it welds two of the reader's words into `bramBram`.
    if (isLibraryMentionNameCharacterAt(description, at - 1)) continue;
    if (!isLibraryMentionNameCharacterAt(description, indexAfterMarkers(at, markers))) continue;
    markers.add(at);
  }
  return deleteCharactersAt(description, [...markers]);
}

/**
 * Deletes single characters, right to left, so earlier offsets keep holding.
 *
 * `replaceRanges` above is that same ordering rule over claimed spans, and the
 * two stay apart deliberately: a `LibraryMentionRange` names the item that owns
 * the span, and these positions are exactly the ones no item could name — the
 * whole reason `stripEveryLibraryMentionMarker` exists. Folding them together
 * costs either a blank id, a shape `libraryMentionRanges` itself refuses, or a
 * generic on the helper every claimed rewrite runs through.
 *
 * The sort is load-bearing rather than defensive: the caller's set is the
 * claimed starts followed by the unclaimed ones, so an unclaimed `@Harbor` in
 * front of a claimed `@Luna` arrives as `[22, 9]`.
 */
function deleteCharactersAt(description: string, positions: readonly number[]): string {
  let result = description;
  for (const at of [...positions].sort((left, right) => right - left)) {
    result = `${result.slice(0, at)}${result.slice(at + 1)}`;
  }
  return result;
}

/**
 * The first position after `at` that outlives the strip.
 *
 * Every entry in `markers` is a deletion, so a run of them is not what the `@`
 * in front of it stands against — whatever the run points at is. Both strips
 * that ask run right to left for exactly this: a marker's own verdict is
 * already in by the time the `@` before it asks what it opens.
 */
function indexAfterMarkers(at: number, markers: ReadonlySet<number>): number {
  let next = at + 1;
  while (markers.has(next)) next += 1;
  return next;
}

/**
 * The same strip for a caller that cannot enumerate what the prose is bound to:
 * every token-opening `@` goes, named or not.
 *
 * `stripLibraryMentionMarkers` decides what is a marker by asking which item
 * claims it, and answers "the reader typed that" for everything else. That
 * answer is only as good as the list — a caller whose link set holds a row it
 * cannot put a name to (a mention kind with no table to join to yet, a row read
 * through a `select` that dropped the join) knows a marker is bound and cannot
 * say which span it sits on. Guessing wrong in *that* direction is the one
 * failure this whole module exists to prevent: an `@` is a UI token, and a
 * description headed for a model must not carry one.
 *
 * So the rule flips: what an item claims is stripped by name, and every
 * remaining `@` that **opens a word** is stripped as well. What that costs is
 * the reader's own `@handle` in the same description, spelled as prose without
 * its `@`; what it buys is that no marker can survive by being unnameable. The
 * word test is the scanner's own — an `@` inside a word is not a marker
 * (`bram@example.com` keeps its `@`), and neither is one with nothing after it
 * ("meet @ the docks").
 *
 * **The word that test reads is the one this strip is leaving behind, not the
 * one it was handed**, and answering off the given prose let the marker back
 * through twice. A claimed span is a whole word — `libraryMentionRanges` opens
 * a claim only at a boundary and refuses one that runs into the next word — so
 * the letters in front of an `@` standing at a claim's `end` are a mention
 * token rather than prose it is embedded in, and `@Bram@Harbor` answered
 * `Bram@Harbor`: the unnameable marker this branch exists for, saved by leaning
 * against a nameable one. And a marker is a deletion, so a run of them is not
 * what the `@` before it opens — `@@Harbor` answered `@Harbor`, the same UI
 * token in the same prompt one deletion later. Hence `indexAfterMarkers` and a
 * right-to-left scan, and hence the guarantee is a fixed point: nothing that
 * survives opens a word in what comes back.
 *
 * A claim is *evidence* that the letters before a marker are a token, and the
 * strip chains off that and never off its own guess: with nobody named,
 * `Bram@Harbor` is the shape an address has and keeps its `@`.
 *
 * Deleting the marker is the whole edit in both halves, which is why one pass
 * over one position set covers them: a claimed span is stripped by dropping its
 * `@` and keeping the prose's spelling verbatim, exactly as above.
 */
export function stripEveryLibraryMentionMarker(
  description: string,
  mentions: readonly LibraryMentionName[] = []
): string {
  const claimed = libraryMentionRanges(description, mentions);
  const markers = new Set(claimed.map((range) => range.start));
  const tokenEnds = new Set(claimed.map((range) => range.end));
  for (
    let at = description.lastIndexOf("@");
    at >= 0;
    at = at > 0 ? description.lastIndexOf("@", at - 1) : -1
  ) {
    if (markers.has(at)) continue;
    if (isLibraryMentionNameCharacterAt(description, at - 1) && !tokenEnds.has(at)) continue;
    if (!isLibraryMentionNameCharacterAt(description, indexAfterMarkers(at, markers))) continue;
    markers.add(at);
  }
  return deleteCharactersAt(description, [...markers]);
}

/**
 * The prose to store beside a link set: every claimed token spelled the way its
 * owner is, and the spans that claim survived on.
 *
 * Canonicalizing per item used to mean one unconditional case-insensitive
 * rewrite each, so "@Bram met @bram." with both rows selected converted both
 * tokens to one name and then to the other, and the save died on a validation
 * that could never pass. One scan settles both spans at once, and a spelling
 * that differs only in case is the same length — which is what lets the ranges
 * describe the returned prose as well as the given prose.
 */
export function canonicalizeLibraryMentions(
  description: string,
  mentions: readonly LibraryMentionName[]
): LibraryMentionClaims {
  const ranges = libraryMentionRanges(description, mentions);
  return {
    description: replaceRanges(description, ranges, (range) => `@${range.name}`),
    ranges
  };
}
