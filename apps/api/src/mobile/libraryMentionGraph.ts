import { LIBRARY_MENTION_LIMIT } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import {
  libraryMentionCharacterRefs,
  libraryMentionInclude,
  type LibraryCharacterWithMentions
} from "@book-maker/db/libraryMentions";
import { uniqueIds } from "./libraryMentionRows.js";

/**
 * The library read by id, and the mention graph behind whoever was named.
 *
 * A file of its own because it is the only side of mentions that reads the
 * *library* rather than one row's links: one character with its links, many
 * characters by id, and the breadth-first walk outward from an explicit cast.
 * Its callers are the two chat surfaces and the build sweep, which never write
 * a link — so nothing here takes a transaction, and **nothing borrows from
 * here**: importing this module opens a Prisma client, so the pure helpers the
 * write lanes wanted (`orderedCharacterRefs`, `uniqueIds`) live in
 * `libraryMentionRows.ts` and this module imports one of them like anyone else.
 * They sat here once, and `libraryMentionLinks.ts` reaching for two array
 * functions dragged the client and the whole graph walk into every write lane
 * and every suite that touches one — the same dependency edge
 * `routes/characters.ts` was moved off this module to drop.
 */

/**
 * The stored shape and its two readings live in `@book-maker/db`, because the
 * worker's portrait handler builds a prompt off the same rows and used to keep
 * a copy of all three — without the `targetKind` filter.
 *
 * **Only the model-facing reading is re-exported, and only because its callers
 * are this module's callers.** `generationDescription` is what the two chat
 * surfaces and the build sweep turn an expanded graph into, so it arrives with
 * `expandLibraryCharacterGraph` in one import. `libraryMentionInclude` and
 * `LibraryCharacterWithMentions` used to ride along and did the opposite: one
 * name became importable from three places, and `routes/characters.ts` reached
 * a module that opens `prisma` and walks the library to borrow a plain Prisma
 * include it walks nothing with — the dependency edge the docblock above says
 * this module does not have. Both are taken straight from
 * `@book-maker/db/libraryMentions` at each use site now.
 */
export { generationDescription } from "@book-maker/db/libraryMentions";

export async function ownedCharacterWithMentions(
  id: string,
  userId: string
): Promise<LibraryCharacterWithMentions | null> {
  return prisma.libraryCharacter.findFirst({
    where: { id, userId },
    include: libraryMentionInclude
  });
}

async function charactersByIds(
  userId: string,
  ids: readonly string[]
): Promise<LibraryCharacterWithMentions[]> {
  if (ids.length === 0) return [];
  return prisma.libraryCharacter.findMany({
    where: { id: { in: [...ids] }, userId },
    include: libraryMentionInclude
  });
}

export type LibraryCharacterGraph = {
  /** Every explicit root that exists, in caller order, then the links behind them. */
  characters: LibraryCharacterWithMentions[];
  /** Explicit ids that are not this user's, or no longer in the library. */
  missingIds: string[];
};

/**
 * Explicit characters first, then their directed links breadth-first.
 *
 * **Every explicit root reaches the caller.** The cap bounds the *expansion*
 * and nothing else — a graph of `limit` characters or fewer comes back exactly
 * as it always did, and a cast bigger than the cap comes back whole with no
 * linked characters behind it. Filling the cap with roots first silently
 * dropped the eleventh character a chat branch had tapped, while the turn's
 * own system prompt promises the model every selected sheet; a sheet nobody
 * can see missing is how a book gets written about a stranger.
 *
 * **`limit` is the caller's own total, and nothing here narrows it.** It bounds
 * roots plus expansion together, and the default is the door the two chat
 * callers come through: one message may @-mention `LIBRARY_MENTION_LIMIT`
 * characters, so the default reads "the cast, and no expansion once the cast
 * has filled it". The build sweep names its own instead
 * (`BUILD_CHARACTER_SNAPSHOT_LIMIT`, the total its payload schema accepts), and
 * a `Math.min` here used to clamp that back to the default. The two numbers are
 * equal today, so the clamp changed nothing and said nothing — raise the
 * build's constant and the sweep would still have been handed ten, with the
 * extra sheets missing from the book and no call site able to show why. A cap
 * stated by its owner and re-applied by whatever it is handed to is the same
 * silent narrowing the `restructure_pages` caps forbid upstream. No safety
 * ceiling went with it: `seen` holds ids from one account's library, which caps
 * at `LIBRARY_CHARACTER_LIMIT_PER_USER`, so a limit above that buys nothing but
 * its own arithmetic and every level is still one id-scoped query.
 *
 * **The cost scales with the mentioned set, not with the library.** Roots are
 * fetched by id and each level fetches only the target ids it has not seen, so
 * the ordinary message — whose characters link to nothing — is one scoped
 * query. Reading the whole account library instead put 100 rows (three queries,
 * through the include) on every chat message, session start and build, and
 * threw all of them away.
 *
 * `missingIds` is the completeness check the mention routes answer 404 with:
 * an id this user does not own is reported rather than silently skipped, so
 * nothing has to re-query the same rows to find that out.
 */
export async function expandLibraryCharacterGraph(
  userId: string,
  explicitIds: readonly string[],
  limit = LIBRARY_MENTION_LIMIT
): Promise<LibraryCharacterGraph> {
  const rootIds = uniqueIds(explicitIds);
  if (rootIds.length === 0) {
    return { characters: [], missingIds: [] };
  }
  const roots = await charactersByIds(userId, rootIds);
  const rootsById = new Map(roots.map((character) => [character.id, character]));
  const characters: LibraryCharacterWithMentions[] = [];
  const missingIds: string[] = [];
  const seen = new Set<string>();
  for (const id of rootIds) {
    const character = rootsById.get(id);
    if (!character) {
      missingIds.push(id);
      continue;
    }
    seen.add(id);
    characters.push(character);
  }

  // What is left of the caller's total once the roots are in. Negative means a
  // cast that already exceeds it, which buys no expansion and costs no query.
  let budget = limit - characters.length;

  // Every candidate discovered so far, in the order the descriptions name
  // them, minus the ones already taken. It **outlives the level that found
  // it**: a level is trimmed to the budget before it is fetched, and a fetch
  // that comes back short — a character deleted between the mention read and
  // the query — hands budget back. Marking the whole level seen and keeping
  // only the head made those returned slots unspendable, because a candidate
  // in `seen` is reachable from no later level, so a cast entitled to ten came
  // back with nine and a linked character the prose names was silently absent.
  const pending: string[] = [];
  const discover = (source: LibraryCharacterWithMentions) => {
    // The kind decides who is in the cast, and it decides it in one spelling:
    // this reads through the predicate every other reader of these rows uses
    // rather than asking the same question again here. The two had already
    // drifted on the row that carries no kind at all —
    // `libraryMentionCharacterRefs` read it as a character and this read it as
    // neither, so a link the app draws reached no sheet the model was given.
    // Both refuse it now, and closed is the right direction for a row nobody
    // can vouch for: refused, a linked character is missing a sheet; accepted,
    // the same reading takes a LOCATION row that arrived without its kind, and
    // that row enters the expansion, gets a reference sheet built for it, and
    // reaches the planner as a person. Nothing writes LOCATION or OTHER rows
    // yet — `REPLACED_MENTION_KINDS` (`libraryMentionLinks.ts`) is
    // `["CHARACTER"]` — so this is a hole being closed before it opens rather
    // than one anything has fallen in.
    for (const target of libraryMentionCharacterRefs(source)) {
      if (seen.has(target.id)) continue;
      seen.add(target.id);
      pending.push(target.id);
    }
  };
  // Seeded only while there is budget to spend what it finds. The loop below is
  // the sole reader of both things `discover` writes, so a cast that has
  // already met the cap must walk no mention list at all — it used to walk
  // every root's, queueing candidates nothing would ever fetch. The condition
  // is the loop's own: a cast exactly at the cap is as spent as one over it.
  if (budget > 0) {
    for (const character of characters) discover(character);
  }

  while (budget > 0 && pending.length > 0) {
    // Trimmed before the fetch, so the cap bounds what is read and not just
    // what is returned; the tail stays queued at the front of the next level.
    const wanted = pending.splice(0, budget);
    const rows = new Map(
      (await charactersByIds(userId, wanted)).map((character) => [character.id, character])
    );
    const level = wanted.flatMap((id) => {
      const character = rows.get(id);
      return character ? [character] : [];
    });
    characters.push(...level);
    budget -= level.length;
    // The same condition the seeding sweep above is gated on, one level down,
    // and for the same reason: this loop is the only reader of what `discover`
    // writes, so a level that has just spent the last of the budget must walk
    // no mention list either. It walked every one of them — up to
    // `level.length * LIBRARY_MENTION_LIMIT` ids pushed into `pending` and
    // `seen` for a `while` that is about to stop reading both. Invisible in the
    // query log and in the graph, which is why the guard had to be written
    // twice rather than noticed once.
    if (budget > 0) {
      for (const character of level) discover(character);
    }
  }
  return { characters, missingIds };
}
