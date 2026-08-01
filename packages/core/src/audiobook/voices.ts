import type { GeminiTtsVoiceName } from "../voiceConversations.js";

/**
 * The narrators offered in the app.
 *
 * The provider exposes thirty voices; most of them are tuned for conversation
 * and wear thin over a two-hour reading. These seven were picked to span the
 * range a listener actually chooses between — bright/deep, warm/cool, brisk/calm
 * — so the picker is a real choice rather than a wall of names.
 *
 * `voice` is the provider's identifier; `displayName` is what the app shows.
 * They are the same word today, and both are safe to ship to clients: a voice
 * name is a narrator, not a model.
 */

export type AudiobookNarrator = {
  voice: GeminiTtsVoiceName;
  displayName: string;
  blurb: string;
};

export const AUDIOBOOK_NARRATORS: readonly AudiobookNarrator[] = [
  { voice: "Zephyr", displayName: "Zephyr", blurb: "Bright and warm — an easy, welcoming read." },
  { voice: "Charon", displayName: "Charon", blurb: "Deep and steady, with a documentary calm." },
  { voice: "Kore", displayName: "Kore", blurb: "Clear and confident. Carries long chapters well." },
  { voice: "Aoede", displayName: "Aoede", blurb: "Light and breezy, good company for lighter books." },
  { voice: "Enceladus", displayName: "Enceladus", blurb: "Hushed and unhurried — made for late nights." },
  { voice: "Schedar", displayName: "Schedar", blurb: "Even and measured. Disappears behind the story." },
  { voice: "Sulafat", displayName: "Sulafat", blurb: "Mellow and rounded, with a storyteller's lilt." }
] as const;

export const DEFAULT_AUDIOBOOK_NARRATOR: GeminiTtsVoiceName = "Zephyr";

/**
 * One fixed passage, read by every narrator, so a listener compares voices
 * rather than sentences. Deliberately generic: samples are cached once per voice
 * and shared across every book.
 */
export const AUDIOBOOK_SAMPLE_PASSAGE =
  "She opened the book at the window, and the first line held her still. " +
  "Somewhere below, a door closed; somewhere further off, the sea kept its own time. " +
  "She read on, and the room went quiet around her.";

export function isAudiobookNarratorVoice(value: unknown): value is GeminiTtsVoiceName {
  return typeof value === "string" && AUDIOBOOK_NARRATORS.some((narrator) => narrator.voice === value);
}

export function audiobookNarrator(voice: string): AudiobookNarrator | undefined {
  return AUDIOBOOK_NARRATORS.find((narrator) => narrator.voice === voice);
}

/** Performance direction sent with every narration request. */
export function narrationStylePrompt(options: { language?: string | null | undefined } = {}): string {
  const language = options.language?.trim();
  return [
    "Read this aloud as an audiobook narrator: warm, unhurried, and natural, with sentence-level phrasing.",
    "Do not announce anything, do not add words, and do not read punctuation or formatting aloud.",
    language ? `The text is in ${language}; keep the accent and pronunciation native to it.` : ""
  ]
    .filter(Boolean)
    .join(" ");
}
