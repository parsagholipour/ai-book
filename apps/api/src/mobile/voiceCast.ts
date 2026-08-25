import { libraryCharacterPortraitUrl } from "./characterSerializer.js";
import { type MobileVoiceCharacterDto, type MobileVoiceCharacterStatus } from "./dto.js";
import { serializeImage } from "./projectArtifactSerializers.js";
import {
  buildRealtimeBookCastInstructions,
  reinforceRealtimeCharacterRoleplay,
  type RealtimeBookCastMember
} from "@book-maker/core";
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
  planVersionId: string | null;
  libraryCharacterId: string | null;
  name: string;
  role: string;
  description: string;
  traits: unknown;
  status: string;
  persona: unknown;
  profileImageAssetId: string | null;
};

export async function loadVoiceCast(projectId: string): Promise<MobileVoiceCharacterDto[]> {
  // The owner and the live plan in one read: the first scopes which library
  // portraits may be served, the second which cast this book currently has.
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { userId: true, currentPlanId: true }
  });
  const currentPlanId = project?.currentPlanId ?? null;

  const [characters, profileImages] = await Promise.all([
    prisma.voiceCharacter.findMany({
      where: {
        projectId,
        status: { not: "REJECTED" },
        // A cast is never deleted: `replaceProjectPlanReferenceRecords` clears
        // Character/Location/ResearchSource on a replan and nothing anywhere
        // deletes a VoiceCharacter, while a continuation approves a brand new
        // PlanVersion whose compile prepares a whole second cast. Unscoped,
        // every one of those books listed each character twice, with two
        // descriptions and two faces. A project with no current plan has no
        // book either, so there is nothing to scope by and nothing to hide.
        ...(currentPlanId ? { OR: [{ planVersionId: currentPlanId }, { planVersionId: null }] } : {})
      },
      orderBy: [{ createdAt: "asc" }],
      select: voiceCharacterSelect
    }),
    prisma.imageAsset.findMany({
      where: { projectId, type: "CHARACTER_PROFILE" },
      orderBy: { createdAt: "desc" },
      select: { id: true, projectId: true, pageId: true, type: true, path: true, metadata: true }
    })
  ]);

  const cast = castForCurrentPlan(characters, currentPlanId);
  const portraitUrls = await libraryPortraitUrls(cast, project?.userId ?? null);
  const imagesByCharacterId = new Map(
    profileImages.flatMap((image) => {
      const voiceCharacterId = characterIdFromMetadata(image.metadata);
      return voiceCharacterId ? [[voiceCharacterId, image] as const] : [];
    })
  );

  return cast.map((character) => {
    const image =
      profileImages.find((candidate) => candidate.id === character.profileImageAssetId) ??
      imagesByCharacterId.get(character.id) ??
      null;
    const status = mobileVoiceCharacterStatus(character.status);
    const libraryCharacterId = character.libraryCharacterId ?? null;
    return {
      id: character.id,
      projectId: character.projectId,
      name: character.name,
      role: character.role,
      description: character.description,
      traits: traitList(character.traits),
      status,
      needsPreparation: character.status === "CANDIDATE" || character.status === "FAILED",
      image: serializeImage(image, "character", `Portrait of ${character.name}`),
      // Reported verbatim even when the library row has since been deleted:
      // the link is a fact about how this book was made, and deleting a saved
      // character is required to change no book state. Only the portrait URL —
      // a promise about bytes the app will go and fetch — is checked against
      // the row behind it.
      libraryCharacterId,
      libraryPortraitUrl: (libraryCharacterId && portraitUrls.get(libraryCharacterId)) || null
    } satisfies MobileVoiceCharacterDto;
  });
}

/**
 * The pre-column rows are a fallback, not a second cast to merge in.
 *
 * A book made before `planVersionId` existed carries a cast of nulls; one made
 * since carries the plan's. A book that is both — old, then continued — would
 * otherwise show the current plan's cast *and* the original's, which is the
 * duplication this scoping exists to remove. So the current plan's rows win
 * outright wherever there are any.
 */
function castForCurrentPlan<T extends { planVersionId: string | null }>(
  characters: T[],
  currentPlanId: string | null
): T[] {
  if (!currentPlanId) {
    return characters;
  }
  const currentPlanCast = characters.filter((character) => character.planVersionId === currentPlanId);
  return currentPlanCast.length > 0 ? currentPlanCast : characters;
}

/**
 * The saved characters' own portraits, by library character id.
 *
 * Same authenticated path `serializeLibraryCharacter` publishes, and the same
 * condition behind it — a portrait exists only when the file is on the row and
 * the drawing finished, which is also exactly what
 * `libraryCharacterSnapshotsForBuild` requires before a character reaches a
 * book at all. The lookup is scoped to the book's owner because that is who the
 * `/api/mobile/characters/:id/portrait` route will serve: an id that has been
 * reassigned or never belonged to them must yield no URL rather than a link
 * that 404s.
 */
async function libraryPortraitUrls(
  characters: Array<{ libraryCharacterId: string | null }>,
  userId: string | null
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(characters.flatMap((character) => (character.libraryCharacterId ? [character.libraryCharacterId] : [])))
  ];
  if (ids.length === 0 || !userId) {
    return new Map();
  }
  const libraryCharacters = await prisma.libraryCharacter.findMany({
    where: { id: { in: ids }, userId },
    select: { id: true, portraitPath: true, portraitStatus: true }
  });
  return new Map(
    libraryCharacters.flatMap((character) => {
      // Shared with `serializeLibraryCharacter`: one rule for "is there a
      // portrait to fetch", so the cast sheet can never offer a URL the
      // character screen would call absent.
      const url = libraryCharacterPortraitUrl(character);
      return url ? [[character.id, url] as const] : [];
    })
  );
}

export const voiceCharacterSelect = {
  id: true,
  projectId: true,
  planVersionId: true,
  libraryCharacterId: true,
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
  bookCast?: RealtimeBookCastMember[] | undefined;
  readerPage?: { index: number; title: string; excerpt: string } | undefined;
  history?: string | undefined;
}): string {
  const persona = personaInstructions(options.character);
  const base = buildRealtimeBookCastInstructions(
    reinforceRealtimeCharacterRoleplay(persona, options.character.name),
    options.character.name,
    options.bookCast ?? []
  );
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
