import {
  LIBRARY_CHARACTER_MENTION_LIMIT,
  canonicalizeLibraryCharacterMentions,
  libraryCharacterMentionRanges,
  rewriteLibraryCharacterMention,
  stripLibraryCharacterMentionMarkers,
  type LibraryCharacterMentionName
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { LIBRARY_CHARACTER_DESCRIPTION_MAX } from "./characterSchemas.js";
import { CharacterRowMovedError, claimCharacterRow } from "./characterWriteConflicts.js";

/** One description and one chat message share the existing cast limit. */
export const LIBRARY_CHARACTER_DESCRIPTION_MENTION_LIMIT = LIBRARY_CHARACTER_MENTION_LIMIT;

export const libraryCharacterMentionInclude = {
  outgoingMentions: {
    orderBy: { sortOrder: "asc" as const },
    include: { targetCharacter: { select: { id: true, name: true } } }
  }
} as const;

export type LibraryCharacterWithMentions = Prisma.LibraryCharacterGetPayload<{
  include: typeof libraryCharacterMentionInclude;
}>;

type CharacterTransaction = Prisma.TransactionClient;

export class CharacterMentionError extends Error {
  constructor(
    readonly code: "INVALID_CHARACTER_MENTION" | "CHARACTER_NOT_FOUND" | "CHARACTER_MENTION_TOO_LONG",
    message: string
  ) {
    super(message);
    this.name = "CharacterMentionError";
  }
}

export function characterMentionRefs(
  character: Partial<Pick<LibraryCharacterWithMentions, "outgoingMentions">>
): Array<{ id: string; name: string }> {
  return (character.outgoingMentions ?? []).map((mention) => mention.targetCharacter);
}

/** Restores caller order after a database `IN` query. */
export function orderedCharacterRefs(
  ids: readonly string[],
  characters: readonly { id: string; name: string }[]
): Array<{ id: string; name: string }> {
  const byId = new Map(characters.map((character) => [character.id, character]));
  return ids.flatMap((id) => {
    const character = byId.get(id);
    return character ? [{ id: character.id, name: character.name }] : [];
  });
}

/** The description models see: relationship names remain, UI-only @ markers do not. */
export function generationDescription(
  character: Pick<LibraryCharacterWithMentions, "description" | "outgoingMentions">
): string {
  return stripLibraryCharacterMentionMarkers(character.description, characterMentionRefs(character));
}

export async function ownedCharacterWithMentions(
  id: string,
  userId: string
): Promise<LibraryCharacterWithMentions | null> {
  return prisma.libraryCharacter.findFirst({
    where: { id, userId },
    include: libraryCharacterMentionInclude
  });
}

async function charactersByIds(
  userId: string,
  ids: readonly string[]
): Promise<LibraryCharacterWithMentions[]> {
  if (ids.length === 0) return [];
  return prisma.libraryCharacter.findMany({
    where: { id: { in: [...ids] }, userId },
    include: libraryCharacterMentionInclude
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
  limit = LIBRARY_CHARACTER_MENTION_LIMIT
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

  // What is left of the cap once the roots are in. Negative means a cast that
  // already exceeds it, which buys no expansion and costs no query.
  let budget = Math.min(limit, LIBRARY_CHARACTER_MENTION_LIMIT) - characters.length;
  let frontier = [...characters];
  while (budget > 0 && frontier.length > 0) {
    const candidates: string[] = [];
    for (const source of frontier) {
      for (const mention of source.outgoingMentions ?? []) {
        if (seen.has(mention.targetCharacterId)) continue;
        seen.add(mention.targetCharacterId);
        candidates.push(mention.targetCharacterId);
      }
    }
    // Trimmed before the fetch, so the cap bounds what is read and not just
    // what is returned; the order is the one the descriptions are written in.
    const wanted = candidates.slice(0, budget);
    if (wanted.length === 0) break;
    const rows = new Map(
      (await charactersByIds(userId, wanted)).map((character) => [character.id, character])
    );
    const level = wanted.flatMap((id) => {
      const character = rows.get(id);
      return character ? [character] : [];
    });
    characters.push(...level);
    budget -= level.length;
    frontier = level;
  }
  return { characters, missingIds };
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Every name competing for the tokens in one character's description.
 *
 * A span in a description belongs to whichever character the reader linked it
 * to, so the source's own outgoing links *are* the candidate set — plus the
 * source's own name, which is prose here (a character cannot mention itself)
 * and must not lose its token to a shorter name nested inside it.
 */
function claimingNames(source: {
  id: string;
  name: string;
  outgoingMentions?: readonly { targetCharacter: { id: string; name: string } }[] | undefined;
}): LibraryCharacterMentionName[] {
  return [
    { id: source.id, name: source.name },
    ...(source.outgoingMentions ?? []).map((mention) => mention.targetCharacter)
  ].filter((candidate) => (candidate.name ?? "").trim().length > 0);
}

/** Sources of the incoming links, with everything a claiming scan needs. */
const incomingSourceSelect = {
  id: true,
  userId: true,
  name: true,
  description: true,
  outgoingMentions: { select: { targetCharacter: { select: { id: true, name: true } } } }
} as const;

const incomingMentionInclude = {
  sourceCharacter: {
    select: incomingSourceSelect
  }
} as const;

type MentionSource = Prisma.LibraryCharacterGetPayload<{ select: typeof incomingSourceSelect }>;

/**
 * The mentioning character as it is now, under the same claim PATCH/DELETE
 * take on the character they were built from.
 *
 * The mention list's `sourceCharacter` is a snapshot from before this
 * transaction touched anyone. A concurrent PATCH of that source can commit
 * while we wait for its row lock; rewriting the snapshot would then overwrite
 * the new description with a strip of the old one. Claiming first, then
 * reading, is what makes the rewrite a function of what the claim found.
 */
async function claimedMentionSource(
  tx: CharacterTransaction,
  snapshot: MentionSource
): Promise<MentionSource> {
  if (
    !(await claimCharacterRow(tx, {
      id: snapshot.id,
      userId: snapshot.userId,
      name: snapshot.name
    }))
  ) {
    throw new CharacterRowMovedError();
  }
  const live = await tx.libraryCharacter.findFirst({
    where: { id: snapshot.id, userId: snapshot.userId },
    select: incomingSourceSelect
  });
  if (!live) {
    throw new CharacterRowMovedError();
  }
  return live;
}

async function mentionedTargets(
  tx: CharacterTransaction,
  userId: string,
  ids: readonly string[]
): Promise<Array<{ id: string; name: string }>> {
  const orderedIds = uniqueIds(ids);
  if (orderedIds.length > LIBRARY_CHARACTER_DESCRIPTION_MENTION_LIMIT) {
    throw new CharacterMentionError(
      "INVALID_CHARACTER_MENTION",
      `A description can mention up to ${LIBRARY_CHARACTER_DESCRIPTION_MENTION_LIMIT} characters.`
    );
  }
  const rows = orderedIds.length
    ? await tx.libraryCharacter.findMany({
        where: { id: { in: orderedIds }, userId },
        select: { id: true, name: true }
      })
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (rows.length !== orderedIds.length) {
    throw new CharacterMentionError(
      "CHARACTER_NOT_FOUND",
      "A mentioned character is no longer in your library."
    );
  }
  return orderedIds.map((id) => byId.get(id)!);
}

/**
 * Canonicalizes selected @tokens and writes the complete outgoing link set.
 * Returns the prose that must be stored beside those links.
 */
export async function replaceCharacterMentions(
  tx: CharacterTransaction,
  options: {
    sourceCharacterId: string;
    userId: string;
    description: string;
    mentionedCharacterIds: readonly string[];
  }
): Promise<string> {
  const targets = await mentionedTargets(tx, options.userId, options.mentionedCharacterIds);
  if (targets.some((target) => target.id === options.sourceCharacterId)) {
    throw new CharacterMentionError(
      "INVALID_CHARACTER_MENTION",
      "A character cannot mention themselves in their own description."
    );
  }

  // One scan settles the whole set: every token is claimed by exactly one of
  // the selected characters, and each claim is respelled to its owner's own
  // name. Canonicalizing one target at a time meant one unconditional
  // case-insensitive rewrite each, so "@Bram met @bram." with both rows
  // selected converted both tokens to "@Bram" and then both back to "@bram" —
  // the validation below then found one id, and on create the 400 rolled the
  // whole transaction back and lost the character with it.
  //
  // The candidate set is exactly the ids being written, never the wider
  // library: the app resolves its picks against the whole library and longest
  // name first, so it sends the same set this would compute — while an old
  // client that under-reports gets its links written rather than a 400 for a
  // token it never claimed to own. It is also what keeps this and
  // `survivingMentionIds` (which has no library to read) answering alike.
  const claims = canonicalizeLibraryCharacterMentions(options.description, targets);
  const firstPosition = new Map<string, number>();
  for (const range of claims.ranges) {
    if (!firstPosition.has(range.id)) firstPosition.set(range.id, range.start);
  }
  const missing = targets.find((target) => !firstPosition.has(target.id));
  if (missing) {
    throw new CharacterMentionError(
      "INVALID_CHARACTER_MENTION",
      `The description no longer contains @${missing.name}.`
    );
  }
  const description = claims.description;
  const ordered = [...targets].sort(
    (left, right) => firstPosition.get(left.id)! - firstPosition.get(right.id)!
  );

  await tx.libraryCharacterMention.deleteMany({ where: { sourceCharacterId: options.sourceCharacterId } });
  if (ordered.length > 0) {
    await tx.libraryCharacterMention.createMany({
      data: ordered.map((target, sortOrder) => ({
        sourceCharacterId: options.sourceCharacterId,
        targetCharacterId: target.id,
        sortOrder
      }))
    });
  }
  return description;
}

/**
 * Old clients preserve only the links whose canonical tokens survive their edit.
 *
 * Whole-set, for the same reason everything else here is: asked one link at a
 * time, a short name "survived" on the occurrence nested inside a longer linked
 * name — "Only @Luna Vega appears now." kept Luna — and the id set that came
 * back then failed `replaceCharacterMentions`, so an ordinary prose edit could
 * not be saved at all.
 */
export function survivingMentionIds(
  description: string,
  mentions: readonly LibraryCharacterMentionName[]
): string[] {
  const claimed = new Set(
    libraryCharacterMentionRanges(description, mentions).map((range) => range.id)
  );
  return mentions.filter((mention) => claimed.has(mention.id)).map((mention) => mention.id);
}

/** Rewrite every incoming description before a target's name changes. */
export async function rewriteIncomingCharacterMentions(
  tx: CharacterTransaction,
  targetCharacterId: string,
  oldName: string,
  newName: string
): Promise<void> {
  if (oldName === newName) return;
  const incoming = await tx.libraryCharacterMention.findMany({
    where: { targetCharacterId },
    include: incomingMentionInclude
  });
  for (const mention of incoming) {
    const source = await claimedMentionSource(tx, mention.sourceCharacter);
    // The old name is passed rather than read back, because the target's row
    // may already carry the new one; the siblings decide which spans are the
    // target's at all, so renaming Luna cannot eat the "@Luna Vega" beside her.
    const description = rewriteLibraryCharacterMention(
      source.description,
      { id: targetCharacterId, name: oldName },
      newName,
      claimingNames(source)
    );
    if (description === source.description) continue;
    if (description.length > LIBRARY_CHARACTER_DESCRIPTION_MAX) {
      // The blocker is somebody else's description, so the message has to name
      // them: the reader is renaming this character and cannot act on a cuid.
      throw new CharacterMentionError(
        "CHARACTER_MENTION_TOO_LONG",
        `That name is too long for ${source.name}'s description, which mentions this character. ` +
          `Shorten ${source.name}'s description first, or pick a shorter name.`
      );
    }
    await tx.libraryCharacter.update({ where: { id: source.id }, data: { description } });
  }
}

/** Turn incoming @Name tokens into ordinary names before the target is deleted. */
export async function unlinkIncomingCharacterMentions(
  tx: CharacterTransaction,
  targetCharacterId: string,
  name: string
): Promise<void> {
  const incoming = await tx.libraryCharacterMention.findMany({
    where: { targetCharacterId },
    include: incomingMentionInclude
  });
  for (const mention of incoming) {
    const source = await claimedMentionSource(tx, mention.sourceCharacter);
    const description = stripLibraryCharacterMentionMarkers(
      source.description,
      [{ id: targetCharacterId, name }],
      claimingNames(source)
    );
    if (description === source.description) continue;
    await tx.libraryCharacter.update({ where: { id: source.id }, data: { description } });
  }
}
