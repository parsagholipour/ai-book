import {
  buildLibraryCharacterInstructions,
  inferLibraryCharacterVoiceProfile,
  type LibraryVoiceAcquaintance,
  type LibraryVoiceCharacterSource,
  type VoiceProfile
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import {
  generationDescription,
  libraryMentionCharacterRefs,
  libraryMentionInclude,
  type LibraryCharacterWithMentions
} from "@book-maker/db/libraryMentions";
import { fieldsFromJson, libraryCharacterPortraitUrl } from "./characterSerializer.js";
import type { MobileVoiceCharacterDto } from "./dto.js";

/**
 * The reader's saved characters as people to call, and the instructions a call
 * to one of them opens with.
 *
 * The book twin is `voiceCast.ts`. Everything a book cast member needs — a
 * persona built from the pages, an avatar drawn for the book, a plan version to
 * be scoped to — a library character either already has in its own row or does
 * not need: the persona is composed from the reader's notes at call time
 * (`buildLibraryCharacterInstructions`), the picture is the one on the profile,
 * and there is no book. So every one of them is `ready`, always.
 */

/** How many other saved characters a call is told about. */
const ACQUAINTANCE_LIMIT = 12;

export async function loadLibraryVoiceCast(userId: string): Promise<MobileVoiceCharacterDto[]> {
  const characters = await prisma.libraryCharacter.findMany({
    where: { userId },
    orderBy: [{ createdAt: "asc" }],
    include: libraryMentionInclude
  });
  const pictures = await mainPictureUrls(userId, characters);
  return characters.map((character) => libraryVoiceCharacterDto(character, pictures.get(character.id) ?? null));
}

/** One saved character with the links its description carries, or null. */
export async function loadLibraryVoiceCharacter(
  characterId: string,
  userId: string
): Promise<LibraryCharacterWithMentions | null> {
  return prisma.libraryCharacter.findFirst({
    where: { id: characterId, userId },
    include: libraryMentionInclude
  });
}

/**
 * The cast-sheet shape for a saved character.
 *
 * `id` is the library id, and `libraryCharacterId` repeats it so the app's one
 * rule for drawing a face — the book's own image, else the library portrait —
 * lands on the library portrait without a second code path.
 */
export function libraryVoiceCharacterDto(
  character: LibraryCharacterWithMentions,
  pictureUrl: string | null
): MobileVoiceCharacterDto {
  const fields = fieldsFromJson(character.fields);
  return {
    id: character.id,
    projectId: null,
    name: character.name,
    role: "",
    // The model-facing prose: an `@` is a UI token the reader typed, not a
    // name the character would say.
    description: generationDescription(character),
    traits: fields.map((field) => `${field.key}: ${field.value}`).slice(0, 6),
    status: "ready",
    needsPreparation: false,
    image: null,
    libraryCharacterId: character.id,
    libraryPortraitUrl: pictureUrl
  };
}

/**
 * What the call opens with, before the call-time additions the route makes.
 *
 * Mirrors `buildVoiceCallInstructions` for a book: the composed persona, the
 * phone manner, and any earlier calls — which go last, as the character's own
 * memory. There is no reader page and no spoiler guard, because there is no
 * book for either to be about.
 */
export function buildLibraryVoiceCallInstructions(options: {
  character: LibraryCharacterWithMentions;
  acquaintances: LibraryVoiceAcquaintance[];
  history?: string | undefined;
}): string {
  const base = buildLibraryCharacterInstructions(voiceSource(options.character), options.acquaintances);
  const opening = [
    "This is a live phone call with the person who created you.",
    "Speak the way a person on a phone does: short turns, one thought at a time, and let them talk.",
    options.history
      ? "Open with a brief greeting in character, as someone picking up to a familiar voice, and then wait for them."
      : "Open with a brief greeting in character and then wait for them."
  ].join(" ");
  return [base, opening, options.history?.trim() ?? ""].filter(Boolean).join("\n\n");
}

/** The voice a saved character speaks in, inferred from the reader's notes. */
export function libraryVoiceProfile(character: LibraryCharacterWithMentions): VoiceProfile {
  return inferLibraryCharacterVoiceProfile(voiceSource(character));
}

/**
 * The reader's other saved characters this one is connected to: everyone its
 * description mentions, then everyone whose description mentions it.
 *
 * Both directions, because a link is written on one side only — Mina's page
 * says "@Bram is my cousin" and Bram's says nothing — and the caller will name
 * either of them to the other. Read through the same include every character
 * read takes, so each acquaintance's own description reaches the prompt with
 * its markers stripped rather than as `@`-tokens the character would read out.
 */
export async function loadLibraryAcquaintances(
  character: LibraryCharacterWithMentions
): Promise<LibraryVoiceAcquaintance[]> {
  const outgoingIds = libraryMentionCharacterRefs(character).map((ref) => ref.id);
  const incoming = await prisma.libraryMention.findMany({
    where: { targetCharacterId: character.id, targetKind: "CHARACTER" },
    select: { sourceCharacterId: true }
  });
  const ids = [
    ...new Set([...outgoingIds, ...incoming.map((mention) => mention.sourceCharacterId)])
  ].filter((id) => id !== character.id);
  if (ids.length === 0) {
    return [];
  }
  const rows = await prisma.libraryCharacter.findMany({
    where: { id: { in: ids.slice(0, ACQUAINTANCE_LIMIT) }, userId: character.userId },
    include: libraryMentionInclude
  });
  // Mention order first — the order the reader wrote them in — then the rest
  // by name, so the list is the same on every call.
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  const ordered = [
    ...outgoingIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
    ...rows
      .filter((row) => !outgoingIds.includes(row.id))
      .sort((left, right) => left.name.localeCompare(right.name))
  ];
  return ordered.map((row) => ({ name: row.name, description: generationDescription(row) }));
}

function voiceSource(character: LibraryCharacterWithMentions): LibraryVoiceCharacterSource {
  return {
    name: character.name,
    description: generationDescription(character),
    appearance: character.appearance,
    fields: fieldsFromJson(character.fields)
  };
}

/**
 * The picture the profile shows, as an immutable URL where one exists.
 *
 * The profile's own rule — the reference if there is one, else the photo —
 * but served through the retained-picture route rather than the two alias
 * paths, because the call avatar loads with no cache-buster and an alias URL
 * whose bytes changed would draw the picture the reader just replaced. A row
 * from before pictures were retained has no image id, and falls back to the
 * alias the profile also uses.
 */
async function mainPictureUrls(
  userId: string,
  characters: Array<Pick<LibraryCharacterWithMentions, "id" | "photoPath" | "portraitPath" | "portraitStatus">>
): Promise<Map<string, string>> {
  const wanted = new Map<string, string>();
  for (const character of characters) {
    const fileName = mainPictureFile(character);
    if (fileName) {
      wanted.set(character.id, fileName);
    }
  }
  if (wanted.size === 0) {
    return new Map();
  }
  const images = await prisma.libraryCharacterImage.findMany({
    where: { userId, characterId: { in: [...wanted.keys()] }, fileName: { in: [...new Set(wanted.values())] } },
    select: { id: true, characterId: true, fileName: true }
  });
  const urls = new Map<string, string>();
  for (const image of images) {
    if (wanted.get(image.characterId) === image.fileName) {
      urls.set(
        image.characterId,
        `/api/mobile/characters/${encodeURIComponent(image.characterId)}/images/${encodeURIComponent(image.id)}`
      );
    }
  }
  for (const character of characters) {
    if (urls.has(character.id) || !wanted.has(character.id)) {
      continue;
    }
    const alias =
      libraryCharacterPortraitUrl(character) ??
      (character.photoPath ? `/api/mobile/characters/${encodeURIComponent(character.id)}/photo` : null);
    if (alias) {
      urls.set(character.id, alias);
    }
  }
  return urls;
}

function mainPictureFile(
  character: Pick<LibraryCharacterWithMentions, "photoPath" | "portraitPath" | "portraitStatus">
): string | null {
  if (character.portraitPath !== null && character.portraitStatus === "READY") {
    return character.portraitPath;
  }
  return character.photoPath;
}
