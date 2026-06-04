import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";

export const DEFAULT_PROJECT_LANGUAGE = "en";

const ENGLISH_LANGUAGE_VALUES = new Set(["en", "eng", "english", "en-us", "en-gb", "en_us", "en_gb"]);

const COMMON_LANGUAGE_LABELS: Record<string, string> = {
  ar: "Arabic",
  arabic: "Arabic",
  de: "German",
  german: "German",
  deutsch: "German",
  es: "Spanish",
  spanish: "Spanish",
  "espanol": "Spanish",
  fa: "Persian",
  farsi: "Persian",
  persian: "Persian",
  fr: "French",
  french: "French",
  "francais": "French",
  hi: "Hindi",
  hindi: "Hindi",
  it: "Italian",
  italian: "Italian",
  ja: "Japanese",
  japanese: "Japanese",
  ko: "Korean",
  korean: "Korean",
  pt: "Portuguese",
  portuguese: "Portuguese",
  ru: "Russian",
  russian: "Russian",
  tr: "Turkish",
  turkish: "Turkish",
  ur: "Urdu",
  urdu: "Urdu",
  zh: "Chinese",
  chinese: "Chinese",
  "zh-cn": "Chinese",
  "zh-tw": "Chinese"
};

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
