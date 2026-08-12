import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";

export const DEFAULT_PROJECT_LANGUAGE = "en";

const ENGLISH_LANGUAGE_VALUES = new Set(["en", "eng", "english", "en-us", "en-gb", "en_us", "en_gb"]);

/**
 * Every value a stored language can take, mapped to its English label. Must
 * stay a superset of {@link LANGUAGE_NAME_CODES}: a name the chat can request
 * but this table cannot label ends up passed to the model verbatim, which is
 * how `targetLanguageGenerationGuidance` once said "Target language: he".
 */
const COMMON_LANGUAGE_LABELS: Record<string, string> = {
  ar: "Arabic",
  arabic: "Arabic",
  da: "Danish",
  danish: "Danish",
  de: "German",
  german: "German",
  deutsch: "German",
  el: "Greek",
  greek: "Greek",
  es: "Spanish",
  spanish: "Spanish",
  "espanol": "Spanish",
  fa: "Persian",
  farsi: "Persian",
  persian: "Persian",
  fr: "French",
  french: "French",
  "francais": "French",
  he: "Hebrew",
  iw: "Hebrew",
  hebrew: "Hebrew",
  hi: "Hindi",
  hindi: "Hindi",
  it: "Italian",
  italian: "Italian",
  ja: "Japanese",
  japanese: "Japanese",
  ko: "Korean",
  korean: "Korean",
  nl: "Dutch",
  dutch: "Dutch",
  no: "Norwegian",
  norwegian: "Norwegian",
  pl: "Polish",
  polish: "Polish",
  pt: "Portuguese",
  portuguese: "Portuguese",
  ru: "Russian",
  russian: "Russian",
  sv: "Swedish",
  swedish: "Swedish",
  th: "Thai",
  thai: "Thai",
  tr: "Turkish",
  turkish: "Turkish",
  uk: "Ukrainian",
  ukrainian: "Ukrainian",
  ur: "Urdu",
  urdu: "Urdu",
  vi: "Vietnamese",
  vietnamese: "Vietnamese",
  zh: "Chinese",
  chinese: "Chinese",
  "zh-cn": "Chinese",
  "zh-tw": "Chinese"
};

/** Language names a user can name in chat, mapped to the code we store. */
export const LANGUAGE_NAME_CODES: Record<string, string> = {
  english: "en",
  spanish: "es",
  french: "fr",
  german: "de",
  italian: "it",
  portuguese: "pt",
  dutch: "nl",
  turkish: "tr",
  russian: "ru",
  arabic: "ar",
  farsi: "fa",
  persian: "fa",
  hindi: "hi",
  chinese: "zh",
  mandarin: "zh",
  japanese: "ja",
  korean: "ko",
  hebrew: "he",
  greek: "el",
  thai: "th",
  swedish: "sv",
  norwegian: "no",
  danish: "da",
  polish: "pl",
  ukrainian: "uk",
  vietnamese: "vi"
};

/** Alternation of every name in {@link LANGUAGE_NAME_CODES}, longest first. */
export function languageNamePattern(): string {
  return Object.keys(LANGUAGE_NAME_CODES)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
}

const LANGUAGE_NAMES = languageNamePattern();

// Words that can follow a language name without turning it into a modifier:
// "in Spanish, please" is an instruction, "in Spanish cinema" is not.
const LANGUAGE_TRAILERS =
  "please|thanks|thank\\s+you|only|instead|too|also|as\\s+well|now|ok|okay|" +
  "for|from|so|but|if|when|version|copy|edition|translation";

/**
 * Asserts that a language name ends its clause, which is what separates naming
 * the book's language from naming a subject. A name followed by a content word
 * is modifying a topic ("Chinese media", "Italian villages"); a name followed by
 * another language name is one item of a list about a topic ("in Japanese,
 * Korean, and Thai cuisine"). Append this after a captured name.
 */
export const LANGUAGE_CLAUSE_END_GUARD =
  `\\b(?!\\s*,?\\s*(?:and|or)?\\s*(?:${LANGUAGE_NAMES})\\b)` +
  `(?=\\s*$|\\s*[,.;:!?)"']|\\s+(?:${LANGUAGE_TRAILERS})\\b)`;

// Words that make a following "in <Lang>" an instruction about the book rather
// than a description of its subject.
const LANGUAGE_REQUEST_ANCHOR =
  "write|writes|written|writing|make|makes|made|generate|create|produce|translate|" +
  "translated|rewrite|regenerate|publish|render|say|convert|want|need|prefer|would\\s+like|" +
  "book|novel|story|text|pages?|chapters?";

const LANGUAGE_REQUEST_PATTERNS = [
  // "write it in Spanish", "I want the book in Chinese", "translate it into French"
  new RegExp(
    `\\b(?:${LANGUAGE_REQUEST_ANCHOR})\\b[^.!?]{0,60}?\\b(?:in|into|to)\\s+(${LANGUAGE_NAMES})${LANGUAGE_CLAUSE_END_GUARD}`,
    "iu"
  ),
  // "language: German", "the language should be Italian", "set the language to Korean"
  new RegExp(`\\blanguages?\\b\\s*(?:is|are|:|=|should\\s+be|to|into|as|in)?\\s*(${LANGUAGE_NAMES})\\b`, "iu"),
  // "use Japanese"
  new RegExp(`\\buse\\s+(${LANGUAGE_NAMES})${LANGUAGE_CLAUSE_END_GUARD}`, "iu"),
  // A message that is nothing but the request: "in Spanish please"
  new RegExp(`^\\W*(?:in|into)\\s+(${LANGUAGE_NAMES})${LANGUAGE_CLAUSE_END_GUARD}`, "iu")
];

/**
 * Reads an explicit request to write the book in a named language, as a code
 * ("zh"). Deliberately high-precision: naming a language is overwhelmingly more
 * often a topic ("aliens in Chinese media") than an instruction, and a false
 * positive writes the whole book in the wrong language. Anything ambiguous
 * returns undefined and is left to the model, which is prompted to set it.
 */
export function explicitLanguageRequest(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  for (const pattern of LANGUAGE_REQUEST_PATTERNS) {
    const name = trimmed.match(pattern)?.[1]?.toLowerCase();
    const code = name ? LANGUAGE_NAME_CODES[name] : undefined;
    if (code) {
      return code;
    }
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const LANGUAGE_DETECTION_PROMPT_CHARS = 4000;

export const languageDetectionSchema = z.object({
  language: z.string().min(2).max(40),
  code: z.string().min(2).max(20).optional(),
  confidence: z.coerce.number().min(0).max(1).optional()
});

export type LanguageDetectionResult = z.infer<typeof languageDetectionSchema>;

export async function detectPromptLanguage(
  textModel: TextModelAdapter,
  prompt: string
): Promise<string> {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return DEFAULT_PROJECT_LANGUAGE;
  }

  const result = await textModel.generateJson({
    purpose: "detect-language",
    temperature: 0,
    maxTokens: 120,
    schema: languageDetectionSchema,
    messages: [
      {
        role: "system",
        content: [
          "Detect the dominant natural language of a user's first book prompt.",
          "Return only JSON with language, code, and confidence.",
          "If the prompt is English or primarily English, return language \"en\" and code \"en\".",
          "For non-English prompts, return the common English language name in language, such as Persian, Arabic, Spanish, or French.",
          "Do not translate, rewrite, summarize, or answer the prompt."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          prompt: trimmed.slice(0, LANGUAGE_DETECTION_PROMPT_CHARS),
          expectedShape: {
            language: "en | Persian | Arabic | Spanish | ...",
            code: "BCP-47 or ISO language code",
            confidence: 0.0
          }
        })
      }
    ]
  });

  return normalizeDetectedLanguage(result.data);
}

export function normalizeProjectLanguage(language: string | null | undefined): string {
  const normalized = normalizeLanguageValue(language);
  if (!normalized || isEnglishLanguage(normalized)) {
    return DEFAULT_PROJECT_LANGUAGE;
  }
  return languageLabel(normalized);
}

export function isEnglishLanguage(language: string | null | undefined): boolean {
  const normalized = normalizeLanguageValue(language);
  return !normalized || ENGLISH_LANGUAGE_VALUES.has(normalized) || normalized.startsWith("en-") || normalized.startsWith("english");
}

export function targetLanguageGenerationGuidance(language: string | null | undefined): string[] {
  if (isEnglishLanguage(language)) {
    return [];
  }
  const targetLanguage = languageLabel(language);
  return [
    `Target language: ${targetLanguage}.`,
    `Write all book-facing string values in ${targetLanguage}, including titles, chapter summaries, planning questions, page titles, Markdown prose, summaries, and continuity notes.`,
    // The exemption exists because a name the user supplied is an identifier,
    // not book-facing text. A saved library character is linked to their
    // portrait by nothing but their name matched letter for letter, so
    // translating or transliterating it into the target language silently
    // unseeds them — the book keeps a character who reads like theirs and is
    // drawn as a stranger. This rule is deliberately narrow: only names the
    // user wrote themselves, never names the model invented.
    "Proper names the user supplied are identifiers, not text to translate: keep every character, place, brand, and title name they wrote exactly as they wrote it, in its own script, and never translate, transliterate, localize, or re-spell one.",
    "Keep JSON field names exactly as requested; translate only the human-readable string values."
  ];
}

export function targetLanguageReviewGuidance(language: string | null | undefined): string[] {
  if (isEnglishLanguage(language)) {
    return [];
  }
  const targetLanguage = languageLabel(language);
  return [
    `The book's target language is ${targetLanguage}.`,
    `Reject reader-facing prose that is mostly not in ${targetLanguage}.`,
    "Keep JSON field names exactly as requested."
  ];
}

export function targetLanguagePayload(language: string | null | undefined): { targetLanguage: string } | undefined {
  return isEnglishLanguage(language) ? undefined : { targetLanguage: languageLabel(language) };
}

export function languageLabel(language: string | null | undefined): string {
  const clean = cleanLanguageValue(language);
  if (!clean || isEnglishLanguage(clean)) {
    return DEFAULT_PROJECT_LANGUAGE;
  }

  const normalized = normalizeLanguageValue(clean);
  const commonLabel = COMMON_LANGUAGE_LABELS[normalized];
  if (commonLabel) {
    return commonLabel;
  }

  return clean.slice(0, 40);
}

function normalizeDetectedLanguage(result: LanguageDetectionResult): string {
  if (isEnglishLanguage(result.language)) {
    return DEFAULT_PROJECT_LANGUAGE;
  }
  return normalizeProjectLanguage(result.language || result.code);
}

function cleanLanguageValue(language: string | null | undefined): string {
  return language?.replace(/\s+/g, " ").trim() ?? "";
}

function normalizeLanguageValue(language: string | null | undefined): string {
  return cleanLanguageValue(language)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[()]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 40);
}
