import { foldCharacterName, safePathPart } from "@book-maker/core";
import { createHash } from "node:crypto";

/**
 * What a character reference sheet is called on disk, and the form two
 * character names are compared in.
 *
 * The pure half of `characterReferences.ts`: no row, no file, no provider — so
 * the rules below can be read and tested as the string rules they are. The two
 * filename promises are different promises and they fail differently. Within
 * one cast, two characters sharing a stem is one file written twice and a book
 * whose whole cast wears one face. Across render *passes*, two passes sharing a
 * stem is a published sheet's bytes replaced by a render nobody kept.
 */

/**
 * The comparison form of a plan character's name: the one string both sides of
 * "does this cast have an answer for this character" are folded to.
 *
 * The *stored* side has always trimmed on the way out —
 * `characterNameFromAssetMetadata` and `parseCharacterReferenceRefusals` both do
 * — while the plan side was compared raw, and nothing canonicalises a name
 * between the planner and that comparison. So a cast member the model spelled
 * `"Ada "` could never be answered for: its sheet's metadata and its recorded
 * refusal both read back as `"ada"`, `characterReferenceSetIsSettled` asked for
 * `"ada "`, and the set stayed unsettled for the life of the plan version.
 * Which is the unbounded bill that check exists to prevent — every illustrated
 * page's image job and the cover job take the advisory lock, delete the sheets
 * and render the whole cast again, the refusal paid for once per page.
 *
 * It is deliberately *not* `foldCharacterName`. That fold answers "are these two
 * spellings the same person", and is right for seeding a book from the library;
 * here two plan characters the planner wrote as two people must stay two
 * answers, or a cast with one sheet between them settles with one of them never
 * drawn. This one only removes what nothing ever meant to be part of a name.
 *
 * `characterSlug` starts from it for the same reason it is here: a padded name
 * and its trimmed twin are one character, so they are one file.
 */
export function characterReferenceNameKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The filename-safe stem for one character's reference sheet.
 *
 * The ASCII path is deliberately byte-for-byte what it always was, so no
 * existing book's files move. What it could not do is name a character whose
 * name holds no ASCII at all: every Persian, Cyrillic, Hebrew or CJK name
 * emptied out and `safePathPart`'s own fallback turned the empty string into
 * the literal "unknown", so a Persian book's entire cast wrote to
 * `character-reference-unknown.jpg` — one file, several concurrent writers, and
 * every character afterwards drawn from whichever render happened to land last.
 * Nothing rebuilt it either: `characterReferenceSetIsSettled` compares names, so
 * the set looked complete for the life of the plan.
 *
 * The fallback hashes the *folded* name, so the two spellings of one Persian
 * name (an Arabic kaf against a Persian one, a stray ZWNJ, a diacritic the
 * planner echoed back) still resolve to the same file rather than to two.
 */
export function characterSlug(value: string): string {
  const ascii = characterReferenceNameKey(value).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (ascii) {
    return safePathPart(ascii);
  }
  return `char-${createHash("sha256").update(foldCharacterName(value)).digest("hex").slice(0, 10)}`;
}

/**
 * One filename stem per plan character: unique within the cast, and unique to
 * the render pass that asked for it.
 *
 * `characterSlug` is per-name and so cannot promise the first on its own: a name
 * that is mostly non-Latin still yields an ASCII slug from whatever Latin it
 * does contain, so "Ada بهرام" and "Ada کیوان" both reduce to `ada`. Uniqueness
 * is a property of the cast, not of a name, and it has to hold before the
 * renders start — they run concurrently into a single project directory.
 *
 * `renderId` is the second promise, and it is what the advisory lock used to
 * be. The renders no longer sit inside it (see `characterReferenceRenderLease.ts`),
 * so two passes over one cast can overlap: a lease that expired under a slow
 * render, or two plan versions of a book, whose leases are separate rows while
 * this directory is shared. Named from the cast alone, every one of those is one
 * path with two writers, and the loser's `writeFile` is the dangerous half: it
 * truncates in place under a page render reading the same path, and it lands on
 * bytes the winner has already published an `ImageAsset` for, leaving the row
 * describing a picture that is no longer there. Per pass, the loser leaves an
 * orphan file instead — storage noise, exactly the trade `applyImageInsertion`
 * and `generateImage` already make for the same reason.
 */
export function characterReferenceFileStems(names: readonly string[], renderId: string): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    const base = `character-reference-${characterSlug(name)}`;
    let stem = base;
    for (let suffix = 2; taken.has(stem); suffix += 1) {
      stem = `${base}-${suffix}`;
    }
    taken.add(stem);
    return `${stem}-${renderId}`;
  });
}
