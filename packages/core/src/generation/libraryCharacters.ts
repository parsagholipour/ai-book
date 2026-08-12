/**
 * User-defined library characters ("consistent characters").
 *
 * A character lives in the account-wide library (the `LibraryCharacter` table,
 * owned by apps/api). Books never reference it by id: at build time the
 * @-mentioned characters are snapshotted into `mediaSettings.mobile.characters`
 * as the plain shapes below, and a plan links back to one by carrying its name
 * verbatim. Deleting a library character therefore cannot break a book already
 * made from it — the snapshot is a copy, and a portrait file that has since
 * disappeared is simply skipped by the reference-sheet seeding.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";

const MAX_SNAPSHOT_CHARACTERS = 10;
const MAX_FIELDS_PER_CHARACTER = 12;
const MAX_NAME_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 2_000;
const MAX_FIELD_KEY_LENGTH = 40;
const MAX_FIELD_VALUE_LENGTH = 300;

/** How many characters one chat message may @-mention. */
export const LIBRARY_CHARACTER_MENTION_LIMIT = 10;

export type LibraryCharacterField = { key: string; value: string };

/**
 * Where a snapshot's reference image came from: a paid redraw, or the user's
 * own artwork adopted verbatim at upload. It changes only how the image is
 * described to the model — a drawn portrait is a *portrait of* the character,
 * while adopted artwork already *is* the character as its author drew them.
 */
export type LibraryCharacterPortraitSource = "generated" | "adopted_upload";

const PORTRAIT_SOURCES: readonly LibraryCharacterPortraitSource[] = ["generated", "adopted_upload"];

export type LibraryCharacterSnapshot = {
  id: string;
  name: string;
  description: string;
  fields: LibraryCharacterField[];
  /**
   * `<userId>/<filename>` relative to `IMAGE_STORAGE_DIR/characters/`. Present
   * only when the character had a READY reference image at snapshot time.
   * Never an absolute path: the storage root moves between deployments.
   */
  portraitFile?: string | undefined;
  /** Absent on snapshots written before adoption existed; read as "generated". */
  portraitSource?: LibraryCharacterPortraitSource | undefined;
};

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function boundedText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function snapshotFields(value: unknown): LibraryCharacterField[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const fields: LibraryCharacterField[] = [];
  for (const entry of value) {
    const record = jsonRecord(entry);
    const key = boundedText(record.key, MAX_FIELD_KEY_LENGTH);
    const fieldValue = boundedText(record.value, MAX_FIELD_VALUE_LENGTH);
    if (key && fieldValue) {
      fields.push({ key, value: fieldValue });
    }
    if (fields.length >= MAX_FIELDS_PER_CHARACTER) {
      break;
    }
  }
  return fields;
}

function snapshotFromUnknown(value: unknown): LibraryCharacterSnapshot | null {
  const record = jsonRecord(value);
  const id = boundedText(record.id, 64);
  const name = boundedText(record.name, MAX_NAME_LENGTH);
  if (!id || !name) {
    return null;
  }
  const portraitFile = boundedText(record.portraitFile, 200);
  // An allowlist rather than boundedText: this value picks a prompt, so an
  // unrecognised string must fall back to the default rather than travel.
  const portraitSource = PORTRAIT_SOURCES.find((source) => source === record.portraitSource);
  return {
    id,
    name,
    description: boundedText(record.description, MAX_DESCRIPTION_LENGTH),
    fields: snapshotFields(record.fields),
    ...(portraitFile ? { portraitFile } : {}),
    ...(portraitFile && portraitSource ? { portraitSource } : {})
  };
}

/**
 * The tolerant read for stored JSON: `mediaSettings.mobile.characters`, written
 * by the mobile build path and carried through every plan version's
 * inputSnapshot. Unknown shapes yield [] rather than throwing — rows written
 * before the feature existed have no key at all.
 */
export function libraryCharactersFromMediaSettings(mediaSettings: unknown): LibraryCharacterSnapshot[] {
  const mobile = jsonRecord(jsonRecord(mediaSettings).mobile);
  if (!Array.isArray(mobile.characters)) {
    return [];
  }
  const snapshots: LibraryCharacterSnapshot[] = [];
  for (const entry of mobile.characters) {
    const snapshot = snapshotFromUnknown(entry);
    if (snapshot) {
      snapshots.push(snapshot);
    }
    if (snapshots.length >= MAX_SNAPSHOT_CHARACTERS) {
      break;
    }
  }
  return snapshots;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nameMentioned(haystack: string, name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) {
    return false;
  }
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(trimmed)}([^\\p{L}\\p{N}]|$)`, "iu").test(haystack);
}

/**
 * Links a plan character back to the library character it came from. The name
 * is the whole link — the plan schema strips unknown keys, so an id cannot ride
 * through the model. Exact (case-insensitive) equality wins; containment in
 * either direction covers the planner writing "Captain Luna Vega" for a library
 * "Luna", or trimming an honorific off.
 */
export function matchLibraryCharacter(
  planCharacterName: string,
  snapshots: readonly LibraryCharacterSnapshot[]
): LibraryCharacterSnapshot | null {
  const planName = planCharacterName.trim();
  if (!planName) {
    return null;
  }
  const lowered = planName.toLowerCase();
  const exact = snapshots.find((snapshot) => snapshot.name.trim().toLowerCase() === lowered);
  if (exact) {
    return exact;
  }
  return (
    snapshots.find(
      (snapshot) => nameMentioned(planName, snapshot.name) || nameMentioned(snapshot.name, planName)
    ) ?? null
  );
}

function fieldsSentence(fields: readonly LibraryCharacterField[]): string {
  return fields.map((field) => `${field.key}: ${field.value}`).join("; ");
}

/**
 * The portrait prompt, from the character sheet alone or stylizing an uploaded
 * photo. Modeled on `buildCharacterProfileImagePrompt` (voice characters): a
 * text-free square avatar with a readable silhouette.
 */
export function buildLibraryCharacterPortraitPrompt(
  character: Pick<LibraryCharacterSnapshot, "name" | "description" | "fields">,
  options: { fromPhoto: boolean }
): string {
  return [
    "Text-free square profile portrait of a story character, for a character library avatar.",
    `Character name: ${character.name}.`,
    character.description ? `Description: ${character.description}.` : "",
    character.fields.length ? `Character details: ${fieldsSentence(character.fields)}.` : "",
    options.fromPhoto
      ? "Stylize the person in the attached reference photo as this character: preserve their identity, face shape, skin tone, hair, and distinctive features while rendering them as a warm storybook illustration."
      : "Design the character's appearance from the description and details above.",
    "Show one character from shoulders up, facing camera, friendly and expressive.",
    "Warm illustrated style with a clean background and strong readable silhouette.",
    "Do not include readable text, labels, captions, watermarks, logos, UI, speech bubbles, or multiple characters."
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * What to say about a library character's reference image when rendering that
 * character's per-book reference sheet.
 *
 * The two sources are not the same claim. A generated portrait was drawn *from*
 * the user's photo and is a likeness to extend; adopted artwork is the
 * character as its author already drew them, so the sheet is a re-pose rather
 * than an interpretation and the design itself must survive it.
 */
export function characterReferenceSeedInstruction(
  source: LibraryCharacterPortraitSource = "generated"
): string {
  return source === "adopted_upload"
    ? [
        "The attached image is this character's existing, approved artwork — it is the character, not a suggestion.",
        "Reproduce its face, hairstyle, colours, outfit and every distinctive detail exactly; change only the pose and framing to make a full-body reference.",
        "Do not restyle, redesign, age, or reinterpret the character."
      ].join(" ")
    : [
        "Use the attached portrait as the authoritative source for this character's face, identity, and distinctive features;",
        "extend it to the full-body reference pose in the book's art style."
      ].join(" ");
}

/**
 * The extra sentence a page or cover render gets when the character's own
 * library reference travels alongside the per-book sheets.
 *
 * The sheet is a redraw, so it is one generation removed from the face the
 * reader recognises; attaching the library image itself is what stops that
 * drift compounding across a book. It is named as the *face* authority
 * specifically, because the sheet is still the authority on pose, outfit and
 * the book's art style — which a shoulders-up avatar cannot supply.
 */
export function libraryCharacterFaceInstruction(names: readonly string[]): string {
  if (names.length === 0) {
    return "";
  }
  const subject = names.length === 1 ? `${names[0]}` : names.join(" and ");
  return [
    `The last ${names.length === 1 ? "reference image is" : `${names.length} reference images are`} the reader's own saved artwork for ${subject}.`,
    "Treat it as the final authority on their face, hair, skin tone and distinctive features — match it exactly, and take pose, outfit and art style from the other references."
  ].join(" ");
}

/**
 * Where library-character files live: `IMAGE_STORAGE_DIR/characters/<userId>/`.
 * Chosen over ATTACHMENT_STORAGE_DIR because attachments are swept after their
 * retention window and a character lives until deleted; and deliberately
 * outside any `<projectId>/` directory, so the project asset route, the render
 * allowlist, and the export sweeps can never reach it.
 */
export const LIBRARY_CHARACTER_STORAGE_SUBDIR = "characters";

const SAFE_DIR_SEGMENT = /^[a-zA-Z0-9_-]{1,64}$/;
const SAFE_FILE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/;

/**
 * A per-write token, so no two versions of one character's picture can share a
 * name.
 *
 * The name used to be derived from the character id alone, which is exactly
 * what made a re-upload or a redraw truncate the previous file in place. With a
 * retained history an image id is a permanent cache key and the app is told it
 * may hold those bytes forever — which only holds while one name means one set
 * of bytes for good.
 */
export function libraryCharacterFileToken(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

/**
 * `<characterId>-<kind>-<token>.<ext>`, inside
 * `IMAGE_STORAGE_DIR/characters/<userId>/`.
 *
 * `token` is required rather than defaulted so the compiler names every writer:
 * a caller that forgets it is a caller that would have overwritten a retained
 * version. Files written before history existed keep their old two-part names
 * and are read back through the name stored on their row — renaming them would
 * silently unseed every book whose `PlanVersion.inputSnapshot` holds the old
 * string, because `libraryPortraitSeedForName` skips a missing file in silence.
 *
 * Length: a 25-character cuid plus `-portrait-`, 12 and `.jpeg` is ~52, well
 * inside `SAFE_FILE_SEGMENT`'s 181 and inside the 200-character cap the plan
 * snapshot applies to `portraitFile`.
 */
export function libraryCharacterFileName(
  characterId: string,
  kind: "photo" | "portrait",
  extension: string,
  token: string
): string {
  return `${characterId}-${kind}-${token}.${extension}`;
}

/** The storage-relative handle persisted in snapshots and DB columns. */
export function libraryCharacterRelativeFile(userId: string, fileName: string): string {
  return `${userId}/${fileName}`;
}

/**
 * Resolves a stored `<userId>/<fileName>` handle to a disk path, or null for
 * anything that is not exactly that shape — stored JSON is reachable from user
 * flows, so a handle naming `..`, an absolute path, or extra segments must
 * resolve to nothing rather than to a file outside the characters tree.
 */
export function libraryCharacterDiskPath(imageStorageDir: string, relativeFile: string): string | null {
  const segments = relativeFile.split("/");
  if (segments.length !== 2) {
    return null;
  }
  const [userDir, fileName] = segments;
  if (!userDir || !fileName || !SAFE_DIR_SEGMENT.test(userDir) || !SAFE_FILE_SEGMENT.test(fileName)) {
    return null;
  }
  return join(imageStorageDir, LIBRARY_CHARACTER_STORAGE_SUBDIR, userDir, fileName);
}

const PROMPT_BLOCK_CHARACTER_BUDGET = 220;

/**
 * The bounded context block shared by the planner prompt and the edit chat's
 * stored request. One line per character, each hard-capped, so ten characters
 * with essay-length descriptions cannot crowd out the transcript budget the
 * caller carved this from.
 */
export function libraryCharacterPromptBlock(
  snapshots: readonly LibraryCharacterSnapshot[],
  options: { perCharacterBudget?: number | undefined } = {}
): string {
  const budget = options.perCharacterBudget ?? PROMPT_BLOCK_CHARACTER_BUDGET;
  return snapshots
    .slice(0, MAX_SNAPSHOT_CHARACTERS)
    .map((snapshot) => {
      const details = [snapshot.description, fieldsSentence(snapshot.fields)].filter(Boolean).join(" — ");
      const line = details ? `${snapshot.name}: ${details}` : snapshot.name;
      return `- ${line.length > budget ? `${line.slice(0, budget - 1).trimEnd()}…` : line}`;
    })
    .join("\n");
}
