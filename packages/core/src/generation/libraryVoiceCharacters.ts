import type { LibraryCharacterField } from "./libraryCharacters.js";
import { inferVoiceProfileFromCharacter, type VoiceProfile } from "./voiceCharacterProfile.js";
import { reinforceRealtimeCharacterRoleplay } from "./voiceCharacters.js";

/**
 * Live calls with a saved library character — one the reader created, outside
 * any book.
 *
 * A book's cast member gets a persona built by a worker job from the finished
 * pages, because the pages are where that character lives and there are far too
 * many of them to hand a realtime model. A library character has no pages. All
 * there is to know is what the reader wrote — a description, a look, a few
 * fields — and that fits in the system instruction whole. So the persona here
 * is composed, never generated: there is no job, no "getting ready" state, and
 * nothing a model could invent about the character before the reader has even
 * said hello. What the model *is* told is to improvise where the notes are
 * silent, which is the one thing a call needs that the notes cannot supply.
 */

export type LibraryVoiceCharacterSource = {
  name: string;
  /** Model-facing prose: `@` mention markers already stripped to plain names. */
  description: string;
  appearance?: string | null | undefined;
  fields: LibraryCharacterField[];
};

/** Another saved character the caller might name, as the persona is told it. */
export type LibraryVoiceAcquaintance = {
  name: string;
  description?: string | null | undefined;
};

const MAX_FIELDS = 12;

/**
 * The system instruction a library call opens with, before the call-time
 * additions (`buildLibraryVoiceCallInstructions` in the API adds the phone
 * manner, the caller's earlier calls and the greeting).
 *
 * Deliberately parallel to `buildRealtimeCharacterInstructions`: the same
 * first-person framing, the same roleplay priority, the same real-person rule.
 * What differs is what the character is told about its own world — there is no
 * book, so there is no plot to protect and nothing to spoil, and the notes are
 * the reader's own rather than a planner's.
 */
export function buildLibraryCharacterInstructions(
  character: LibraryVoiceCharacterSource,
  acquaintances: LibraryVoiceAcquaintance[] = []
): string {
  const name = character.name.trim() || "the character";
  const description = normalizeText(character.description);
  const appearance = normalizeText(character.appearance ?? "");
  const fields = characterFieldLines(character.fields);
  const persona = [
    `You are ${name}, a character the caller created themselves and knows well.`,
    description ? `Who you are, in the caller's own words: ${description}` : "",
    appearance ? `What you look like: ${appearance}` : "",
    fields.length ? `Details the caller wrote down: ${fields.join(" ")}` : "",
    "There is no book behind you yet: no plot to protect and nothing to spoil.",
    "Where the caller's notes are silent, improvise in keeping with them, keep what you invent consistent for the rest of the call, and never contradict what they wrote.",
    `Roleplay priority: remain in first person as ${name}.`,
    `Treat questions about your background, motives, relationships, memories, feelings and identity as in-world questions; answer them as ${name}.`,
    "Do not break character during ordinary character-detail questions by explaining that you are invented, generated, a chatbot, or a saved character in an app.",
    `If the caller explicitly asks about the AI, model, app or prompts, briefly say this is an in-character voice chat, then return to ${name}'s perspective.`,
    "Do not impersonate a real living person or claim real-world physical presence with the caller.",
    "Keep responses conversational, concise, and suitable for a voice call."
  ]
    .filter(Boolean)
    .join("\n");
  return withAcquaintances(reinforceRealtimeCharacterRoleplay(persona, name), name, acquaintances);
}

/**
 * Grounds the character in the reader's other saved characters — the ones its
 * description mentions and the ones whose descriptions mention it.
 *
 * The book equivalent is `buildRealtimeBookCastInstructions`, which the prompt
 * text here follows closely; it is a separate block because the heading is a
 * claim about where the names come from, and "book cast" would be a lie for a
 * character with no book.
 */
function withAcquaintances(instructions: string, characterName: string, acquaintances: LibraryVoiceAcquaintance[]): string {
  const key = characterName.trim().toLowerCase();
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const acquaintance of acquaintances) {
    const name = acquaintance.name.trim();
    const nameKey = name.toLowerCase();
    if (!name || nameKey === key || seen.has(nameKey)) {
      continue;
    }
    seen.add(nameKey);
    const description = normalizeText(acquaintance.description ?? "");
    lines.push(`- ${name}${description ? `: ${description}` : ""}`);
  }
  if (lines.length === 0) {
    return instructions;
  }
  return [
    instructions,
    [
      "People you know — the caller's other saved characters:",
      ...lines,
      `As ${characterName}, recognize every listed character when the caller names them.`,
      "Use what is listed plus your own notes. If how you relate to one of them is not written down, say only what you do know rather than inventing a history or claiming they are a stranger."
    ].join("\n")
  ].join("\n");
}

/**
 * The voice a library character is given.
 *
 * The same heuristics a plan character's voice comes from
 * (`inferVoiceProfileFromCharacter`), run over the same kind of text: the name,
 * the description, the fields as traits and the appearance as a visual rule.
 * The category is a fiction story rather than a children's book, so nothing
 * here assumes a child's voice unless the notes say so.
 */
export function inferLibraryCharacterVoiceProfile(character: LibraryVoiceCharacterSource): VoiceProfile {
  const appearance = normalizeText(character.appearance ?? "");
  return inferVoiceProfileFromCharacter(
    { category: "STORY" },
    {
      name: character.name,
      role: "",
      description: character.description,
      traits: character.fields.slice(0, MAX_FIELDS).map(fieldAsTrait),
      visualRules: appearance ? [appearance] : []
    }
  );
}

/**
 * A field as the age heuristic can read it.
 *
 * "Age: 9" is how a reader states an age in the library, and the shared parser
 * knows "aged 9" and "9 years old" but not a labelled number — so an age-keyed
 * field with a bare number is spelled the way the parser reads. Everything else
 * goes through as `key: value`, which is what the energy and warmth rules scan.
 */
function fieldAsTrait(field: LibraryCharacterField): string {
  const key = normalizeText(field.key);
  const value = normalizeText(field.value);
  if (/^(age|years|years old)$/i.test(key) && /^\d{1,3}$/.test(value)) {
    return `aged ${value}`;
  }
  return `${key}: ${value}`;
}

function characterFieldLines(fields: LibraryCharacterField[]): string[] {
  return fields
    .slice(0, MAX_FIELDS)
    .map((field) => ({ key: normalizeText(field.key), value: normalizeText(field.value) }))
    .filter((field) => field.key && field.value)
    .map((field) => `${field.key}: ${field.value}.`);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
