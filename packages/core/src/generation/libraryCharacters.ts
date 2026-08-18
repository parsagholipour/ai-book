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
import { jsonRecord } from "../schemas/jsonCoercion.js";

const MAX_SNAPSHOT_CHARACTERS = 10;
const MAX_FIELDS_PER_CHARACTER = 12;
const MAX_NAME_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 2_000;
export const MAX_APPEARANCE_LENGTH = 600;
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
  /**
   * What the character LOOKS like, in words — absent until one has been read
   * from their picture or written by hand.
   *
   * `description` is who they are ("she's a great wife and future mother") and
   * routinely carries no appearance at all; the look lives in the portrait's
   * pixels, which the planner never sees. Without this the planner invents a
   * look for the character it was told to reuse, writes it into every
   * illustration prompt, and that text beats the reference images attached
   * beside it — the reader gets a stranger wearing their character's name.
   */
  appearance?: string | undefined;
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
  const appearance = boundedText(record.appearance, MAX_APPEARANCE_LENGTH);
  return {
    id,
    name,
    description: boundedText(record.description, MAX_DESCRIPTION_LENGTH),
    ...(appearance ? { appearance } : {}),
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

/**
 * The comparison form of a character name.
 *
 * Every step here is a case that silently unseeded a book. NFD-then-strip-marks
 * makes NFC "José" and its decomposed twin the same string, and takes Arabic
 * diacritics (a shadda the planner echoed back) with it. The kaf/yeh folds are
 * the Arabic and Persian codepoints for letters that render identically and are
 * typed interchangeably — a name saved from a Persian keyboard and echoed by a
 * model trained on Arabic text is otherwise two different names. ZWNJ and ZWJ
 * are *removed* rather than treated as separators, which is the whole reason
 * "علی‌رضا" stopped matching a library "علی": they are Cf, so the old boundary
 * class `[^\p{L}\p{N}]` accepted one as a word break and seeded an unrelated
 * character with the reader's saved face.
 */
export function foldCharacterName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu, "")
    .replace(/\p{M}+/gu, "")
    .replace(/ك/gu, "ک")
    .replace(/[يى]/gu, "ی")
    .replace(/[٠-٩]/gu, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/gu, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

/**
 * Whole space-separated tokens, each stripped of leading and trailing
 * punctuation so "Mr." and "Mr" are one token. Internal punctuation is kept on
 * purpose: it is what keeps "Sam's" from being the token "Sam".
 */
function nameTokens(folded: string): string[] {
  return folded
    .split(" ")
    .map((token) => token.replace(/^\p{P}+|\p{P}+$/gu, ""))
    .filter(Boolean);
}

/** Whether `outer`'s tokens contain `inner`'s as a contiguous whole-token run. */
function containsTokenRun(outer: readonly string[], inner: readonly string[]): boolean {
  if (inner.length === 0 || inner.length > outer.length) {
    return false;
  }
  return outer.some((_token, start) =>
    inner.every((wanted, offset) => outer[start + offset] === wanted)
  );
}

/**
 * Links a plan character back to the library character it came from. The name
 * is the whole link — the plan schema strips unknown keys, so an id cannot ride
 * through the model.
 *
 * Folded equality wins. Failing that, containment covers the planner writing
 * "Captain Luna Vega" for a library "Luna" or trimming an honorific off — but
 * only as a run of *whole tokens*, because sub-token containment is how one
 * portrait ended up on somebody else: "Sam" seeded "Sam's Mother", "Luna"
 * seeded "Luna-Bear". An ambiguous containment resolves to null rather than to
 * a guess. A missing seed is a character drawn from prose; a wrong one is a
 * stranger wearing the reader's saved face, and only one of those is recoverable
 * by reading the book.
 */
export function matchLibraryCharacter(
  planCharacterName: string,
  snapshots: readonly LibraryCharacterSnapshot[]
): LibraryCharacterSnapshot | null {
  const planName = foldCharacterName(planCharacterName);
  if (!planName) {
    return null;
  }
  const exact = snapshots.find((snapshot) => foldCharacterName(snapshot.name) === planName);
  if (exact) {
    return exact;
  }
  const planTokens = nameTokens(planName);
  const contained = snapshots.filter((snapshot) => {
    const snapshotTokens = nameTokens(foldCharacterName(snapshot.name));
    return (
      containsTokenRun(planTokens, snapshotTokens) || containsTokenRun(snapshotTokens, planTokens)
    );
  });
  return contained.length === 1 ? (contained[0] ?? null) : null;
}

function fieldsSentence(fields: readonly LibraryCharacterField[]): string {
  return fields.map((field) => `${field.key}: ${field.value}`).join("; ");
}

/**
 * The portrait prompt, from the character sheet alone or stylizing an uploaded
 * photo. Modeled on `buildCharacterProfileImagePrompt` (voice characters): a
 * text-free square avatar with a readable silhouette.
 *
 * `appearance` is what makes a *redraw* land on the same person. Without a
 * photo attached the design source used to be `description` alone — the field
 * that carries who the character is and routinely nothing about how they look —
 * so re-running the portrait produced a stranger, and that stranger then became
 * the authority every page render was seeded from.
 */
export function buildLibraryCharacterPortraitPrompt(
  character: Pick<LibraryCharacterSnapshot, "name" | "description" | "fields" | "appearance">,
  options: { fromPhoto: boolean }
): string {
  const appearance = character.appearance?.trim();
  return [
    "Text-free square profile portrait of a story character, for a character library avatar.",
    `Character name: ${character.name}.`,
    character.description ? `Description: ${character.description}.` : "",
    appearance ? `Appearance (match exactly): ${appearance}.` : "",
    character.fields.length ? `Character details: ${fieldsSentence(character.fields)}.` : "",
    options.fromPhoto
      ? "Stylize the person in the attached reference photo as this character: preserve their identity, face shape, skin tone, hair, and distinctive features while rendering them as a warm storybook illustration."
      : appearance
        ? "Draw the character exactly as the appearance above describes; take only what it leaves open from the description and details."
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
 * The appearance gets a budget of its own rather than sharing the line's.
 *
 * Truncation here is not a shorter sentence, it is a licence to invent: a look
 * cut off at "long dark hair, wearing a…" leaves the model to finish the outfit,
 * and whatever it finishes with is what the illustration prompts carry. So the
 * appearance is capped separately and the biography is what gives way.
 */
const PROMPT_BLOCK_APPEARANCE_BUDGET = 240;

function capped(value: string, budget: number): string {
  return value.length > budget ? `${value.slice(0, budget - 1).trimEnd()}…` : value;
}

/**
 * The bounded context block shared by the planner prompt and the edit chat's
 * stored request. One line per character, each hard-capped, so ten characters
 * with essay-length descriptions cannot crowd out the transcript budget the
 * caller carved this from.
 *
 * Appearance is labelled and comes first because it is the half a model is
 * otherwise happy to supply for itself. Everything else on the line is
 * biography, which it may freely build on.
 */
export function libraryCharacterPromptBlock(
  snapshots: readonly LibraryCharacterSnapshot[],
  options: { perCharacterBudget?: number | undefined } = {}
): string {
  const budget = options.perCharacterBudget ?? PROMPT_BLOCK_CHARACTER_BUDGET;
  return snapshots
    .slice(0, MAX_SNAPSHOT_CHARACTERS)
    .map((snapshot) => {
      const details = [snapshot.description, fieldsSentence(snapshot.fields)]
        .filter(Boolean)
        .join(" — ");
      const line = details ? `${snapshot.name}: ${details}` : snapshot.name;
      const appearance = snapshot.appearance?.trim();
      return appearance
        ? `- ${capped(line, budget)}\n  Appearance (fixed — use verbatim, do not invent or alter): ${capped(appearance, PROMPT_BLOCK_APPEARANCE_BUDGET)}`
        : `- ${capped(line, budget)}`;
    })
    .join("\n");
}

/**
 * The line that tells a model what it may and may not decide about a saved
 * character's look.
 *
 * Two different sentences, because the honest instruction differs. With an
 * appearance recorded there is a right answer and the model's job is to repeat
 * it. Without one there is no right answer anywhere in text — the look exists
 * only in a portrait that is attached to the *image* calls and invisible here —
 * so the only safe instruction is to describe no appearance at all and let the
 * reference images speak. Saying "invent something consistent" instead is what
 * produced a hijab-wearing woman rendered as a bare-headed child: the invented
 * sentence travels into every illustration prompt, and scene text outranks the
 * reference image sitting beside it.
 */
export function libraryCharacterAppearanceRule(
  snapshots: readonly LibraryCharacterSnapshot[]
): string {
  if (snapshots.length === 0) {
    return "";
  }
  const described = snapshots.filter((snapshot) => snapshot.appearance?.trim());
  const undescribed = snapshots.filter((snapshot) => !snapshot.appearance?.trim());
  return [
    described.length
      ? `For ${described.map((snapshot) => `"${snapshot.name}"`).join(", ")}, the Appearance line above is the character's real, already-drawn look: reuse it word for word in visualRules and in every illustration prompt, and never write a physical detail that contradicts it.`
      : "",
    undescribed.length
      ? `For ${undescribed.map((snapshot) => `"${snapshot.name}"`).join(", ")}, no appearance is recorded and their real picture is attached to the illustration calls, which you cannot see. Leave their visualRules empty and describe no hair, skin, age, build, headwear, or clothing for them anywhere — refer to them by name only and let the attached reference decide how they look.`
      : ""
  ]
    .filter(Boolean)
    .join(" ");
}
