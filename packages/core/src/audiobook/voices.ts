/**
 * Stable narrator personas shown to listeners. Provider voice names never leave
 * the worker, so switching narration backends does not change the request API.
 */
export type AudiobookNarratorVoice =
  | "Zephyr"
  | "Charon"
  | "Kore"
  | "Aoede"
  | "Enceladus"
  | "Schedar"
  | "Sulafat";

export type AudiobookSpeechProvider = "gemini_tts" | "openai_tts";
export type OpenAITtsVoiceName =
  | "alloy"
  | "ash"
  | "ballad"
  | "coral"
  | "echo"
  | "fable"
  | "marin"
  | "nova"
  | "onyx"
  | "sage"
  | "shimmer"
  | "verse"
  | "cedar";

export type AudiobookNarrator = {
  voice: AudiobookNarratorVoice;
  displayName: string;
  blurb: string;
  providerVoices: {
    gemini_tts: AudiobookNarratorVoice;
    openai_tts: OpenAITtsVoiceName;
  };
};

export const AUDIOBOOK_NARRATORS: readonly AudiobookNarrator[] = [
  {
    voice: "Zephyr",
    displayName: "Zephyr",
    blurb: "Bright and warm — an easy, welcoming read.",
    providerVoices: { gemini_tts: "Zephyr", openai_tts: "marin" }
  },
  {
    voice: "Charon",
    displayName: "Charon",
    blurb: "Deep and steady, with a documentary calm.",
    providerVoices: { gemini_tts: "Charon", openai_tts: "echo" }
  },
  {
    voice: "Kore",
    displayName: "Kore",
    blurb: "Clear and confident. Carries long chapters well.",
    providerVoices: { gemini_tts: "Kore", openai_tts: "coral" }
  },
  {
    voice: "Aoede",
    displayName: "Aoede",
    blurb: "Light and breezy, good company for lighter books.",
    providerVoices: { gemini_tts: "Aoede", openai_tts: "shimmer" }
  },
  {
    voice: "Enceladus",
    displayName: "Enceladus",
    blurb: "Hushed and unhurried — made for late nights.",
    providerVoices: { gemini_tts: "Enceladus", openai_tts: "ballad" }
  },
  {
    voice: "Schedar",
    displayName: "Schedar",
    blurb: "Even and measured. Disappears behind the story.",
    providerVoices: { gemini_tts: "Schedar", openai_tts: "alloy" }
  },
  {
    voice: "Sulafat",
    displayName: "Sulafat",
    blurb: "Mellow and rounded, with a storyteller's lilt.",
    providerVoices: { gemini_tts: "Sulafat", openai_tts: "cedar" }
  }
] as const;

export const DEFAULT_AUDIOBOOK_NARRATOR: AudiobookNarratorVoice = "Zephyr";

/** A fixed passage so listeners compare voices rather than sentences. */
export const AUDIOBOOK_SAMPLE_PASSAGE =
  "She opened the book at the window, and the first line held her still. " +
  "Somewhere below, a door closed; somewhere further off, the sea kept its own time. " +
  "She read on, and the room went quiet around her.";

export function isAudiobookNarratorVoice(value: unknown): value is AudiobookNarratorVoice {
  return typeof value === "string" && AUDIOBOOK_NARRATORS.some((narrator) => narrator.voice === value);
}

export function audiobookNarrator(voice: string): AudiobookNarrator | undefined {
  return AUDIOBOOK_NARRATORS.find((narrator) => narrator.voice === voice);
}

export function resolveAudiobookNarratorVoice(
  persona: string,
  provider: AudiobookSpeechProvider
): string {
  const narrator = audiobookNarrator(persona);
  if (!narrator) {
    throw new Error(`Unsupported audiobook narrator persona: ${persona}`);
  }
  return narrator.providerVoices[provider];
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
