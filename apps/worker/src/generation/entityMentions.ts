/**
 * Does this prose name that entity?
 *
 * One question, asked from two directions: `entityState.ts` asks it of a page's
 * continuity notes against the cast, and `semanticRecall.ts` asks it of a
 * composed query against the plan's names to pick the trigram needles. Both
 * arrive with `foldCharacterName` (`@book-maker/core`) already applied to both
 * sides, because both check many names against a haystack they can fold once —
 * so what lives here is the one line that runs *after* the fold. The fold is
 * the whole of the answer, so the two callers were never allowed to disagree
 * about whether "علي" and "علی" are one name.
 */

/**
 * Whether folded prose names a folded entity. Both sides must already have gone
 * through `foldCharacterName` — the same fold the library-character matcher
 * learned to use — so a Persian name saved from one keyboard and written by the
 * model from another (Arabic kaf/yeh, ZWNJ, harakat, Arabic-Indic digits) still
 * matches instead of silently never updating the entity's state.
 *
 * Folding is the caller's job because it is the expensive half: an NFD
 * normalise plus eight passes over the whole string, and the haystack here is
 * note prose rather than a name. A caller checking many entities against many
 * notes folds each side once instead of once per pair.
 *
 * That fold deletes only the marks a name may or may not carry, and the
 * difference is load-bearing *here* rather than in the matcher: this side of it
 * is arbitrary note prose in whatever script the book is written in. While it
 * stripped every `\p{M}`, "मीरा" and "मारा" were both the consonant skeleton
 * "मर", so page 12's note about one of them was written onto the other's state
 * and `lexicalTermsForQuery` picked the wrong name as its trigram needle.
 */
export function foldedMentions(foldedNote: string, foldedName: string): boolean {
  return foldedName.length > 1 && foldedNote.includes(foldedName);
}
