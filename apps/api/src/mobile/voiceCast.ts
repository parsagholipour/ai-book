import { type MobileVoiceCharacterDto, type MobileVoiceCharacterStatus } from "./dto.js";
import { serializeImage } from "./projectSerializers.js";
import { reinforceRealtimeCharacterRoleplay } from "@book-maker/core";
import { prisma } from "@book-maker/db";

/**
 * The cast of a finished book, as the app sees it, and the instructions a call
 * to one of them opens with.
 *
 * The operator console exposes the full character record — provider, model,
 * voice id, persona JSON, approve/reject workflow. None of that is product
 * surface. What a reader gets is a name, a face, and a phone number.
 */

export type VoiceCharacterRow = {
  id: string;
  projectId: string;
  name: string;
  role: string;
  description: string;
  traits: unknown;
  status: string;
  persona: unknown;
  profileImageAssetId: string | null;
};

export async function loadVoiceCast(projectId: string): Promise<MobileVoiceCharacterDto[]> {
  const [characters, profileImages] = await Promise.all([
    prisma.voiceCharacter.findMany({
      where: { projectId, status: { not: "REJECTED" } },
      orderBy: [{ createdAt: "asc" }],
      select: voiceCharacterSelect
    }),
    prisma.imageAsset.findMany({
      where: { projectId, type: "CHARACTER_PROFILE" },
      orderBy: { createdAt: "desc" },
      select: { id: true, projectId: true, pageId: true, type: true, path: true, metadata: true }
    })
  ]);

  const imagesByCharacterId = new Map(
    profileImages.flatMap((image) => {
      const voiceCharacterId = characterIdFromMetadata(image.metadata);
      return voiceCharacterId ? [[voiceCharacterId, image] as const] : [];
    })
  );

  return characters.map((character) => {
    const image =
      profileImages.find((candidate) => candidate.id === character.profileImageAssetId) ??
      imagesByCharacterId.get(character.id) ??
      null;
    const status = mobileVoiceCharacterStatus(character.status);
    return {
      id: character.id,
      projectId: character.projectId,
      name: character.name,
      role: character.role,
      description: character.description,
      traits: traitList(character.traits),
      status,
      needsPreparation: character.status === "CANDIDATE" || character.status === "FAILED",
      image: serializeImage(image, "character", `Portrait of ${character.name}`)
    } satisfies MobileVoiceCharacterDto;
  });
}

export const voiceCharacterSelect = {
  id: true,
  projectId: true,
  name: true,
  role: true,
  description: true,
  traits: true,
  status: true,
  persona: true,
  profileImageAssetId: true
} as const;

/**
 * `FAILED` reads as `ready` on purpose: a failed persona build is retried by
 * the next call, so the honest thing to show is a character you can still ring
 * rather than one the app has written off.
 */
export function mobileVoiceCharacterStatus(status: string): MobileVoiceCharacterStatus {
  if (status === "READY") {
    return "ready";
  }
  if (status === "APPROVED" || status === "BUILDING") {
    return "preparing";
  }
  if (status === "CANDIDATE" || status === "FAILED") {
    return "ready";
  }
  return "unavailable";
}

/**
 * The system instructions a call opens with.
 *
 * When the call comes from the reader, `readerPage` carries where they had got
 * to. Telling the character to stay behind that line is what makes calling a
 * character mid-book safe: without it, asking "what happens to you?" spoils the
 * ending of the book the user is still reading.
 *
 * `history` is what earlier calls with this reader left behind, already written
 * as instructions by `formatVoiceCallHistory`. It goes in ahead of the reader's
 * page so the spoiler guard is the last word — remembered talk is still talk
 * about the book, and a call placed further back than the last one must not be
 * where the ending leaks out.
 */
export function buildVoiceCallInstructions(options: {
  character: Pick<VoiceCharacterRow, "name" | "role" | "description" | "persona">;
  bookTitle: string;
  readerPage?: { index: number; title: string; excerpt: string } | undefined;
  history?: string | undefined;
}): string {
  const persona = personaInstructions(options.character);
  const base = reinforceRealtimeCharacterRoleplay(persona, options.character.name);
  const opening = [
    "This is a live phone call with a reader of the book.",
    "Speak the way a person on a phone does: short turns, one thought at a time, and let them talk.",
    options.history
      ? "Open with a brief greeting in character, as someone picking up to a familiar voice, and then wait for them."
      : "Open with a brief greeting in character and then wait for them."
  ].join(" ");

  const history = options.history?.trim() ?? "";
  const readerPage = options.readerPage;
  if (!readerPage) {
    return [base, opening, history].filter(Boolean).join("\n\n");
  }

  return [
    base,
    opening,
    history,
    [
      `The reader is currently on page ${readerPage.index + 1} of "${options.bookTitle}"${
        readerPage.title ? `, "${readerPage.title}"` : ""
      }.`,
      "Treat everything after that point as not yet happened for them: do not reveal, hint at, or react to later events unless they bring it up first.",
      history ? "That holds for anything you remember from an earlier call too." : "",
      readerPage.excerpt ? `What is on their page right now:\n${readerPage.excerpt}` : ""
    ]
      .filter(Boolean)
      .join(" ")
  ]
    .filter(Boolean)
    .join("\n\n");
}

const READER_PAGE_EXCERPT_CHARS = 900;

export async function loadReaderPageContext(
  projectId: string,
  pageIndex: number | undefined
): Promise<{ index: number; title: string; excerpt: string } | undefined> {
  if (pageIndex === undefined) {
    return undefined;
  }
  const page = await prisma.page.findFirst({
    where: { projectId, index: pageIndex },
    select: { index: true, title: true, markdown: true }
  });
  if (!page) {
    return undefined;
  }
  return {
    index: page.index,
    title: page.title ?? "",
    excerpt: page.markdown.replace(/\s+/g, " ").trim().slice(0, READER_PAGE_EXCERPT_CHARS)
  };
}

function personaInstructions(character: Pick<VoiceCharacterRow, "name" | "role" | "description" | "persona">): string {
  const persona = character.persona;
  if (persona && typeof persona === "object" && !Array.isArray(persona)) {
    const instructions = (persona as Record<string, unknown>).instructions;
    if (typeof instructions === "string" && instructions.trim()) {
      return instructions;
    }
  }
  return [
    `You are ${character.name}, speaking from inside this finished book.`,
    `Role: ${character.role}.`,
    `Description: ${character.description}.`,
    "Keep responses conversational, concise, and suitable for a voice call."
  ].join("\n");
}

function traitList(traits: unknown): string[] {
  if (!Array.isArray(traits)) {
    return [];
  }
  return traits.filter((trait): trait is string => typeof trait === "string" && trait.trim().length > 0).slice(0, 6);
}

function characterIdFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>).voiceCharacterId;
  return typeof value === "string" && value ? value : null;
}
