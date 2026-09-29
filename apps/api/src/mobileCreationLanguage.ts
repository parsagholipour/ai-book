import {
  LANGUAGE_NAME_CODES,
  languageDetectionSchema,
  normalizeProjectLanguage,
  type TextModelAdapter
} from "@book-maker/core";
import type { MobileCreationTurnRequest } from "./mobileCreationTurn.js";

/** Resolve the language from user-authored text before the creative model runs.
 * Assistant guesses, generated briefs, sources and character nationalities are
 * deliberately absent: none of them can establish a language preference.
 */
export async function resolveCreationBookLanguage(
  textModel: TextModelAdapter,
  request: MobileCreationTurnRequest
): Promise<string> {
  const messages = request.messages.filter((message) => message.role === "user" && message.content.trim());
  if (messages.length === 0) return request.language ?? "en";
  const result = await textModel.generateJson({
    purpose: "detect-language",
    temperature: 0,
    maxTokens: 160,
    schema: languageDetectionSchema,
    messages: [
      {
        role: "system",
        content: [
          "Resolve the book's output language using only the user's own messages.",
          "The latest explicit request for the book's language wins, in any language or wording (including terse corrections like 'No in English').",
          "Otherwise retain the current book language if one is selected; for a new book use the natural language the user is writing in.",
          "Never infer a language from a person's name, nationality, country, setting, topic, quoted text or source material. An English request about Neymar or Brazil means an English book; a Portuguese request means Portuguese unless another book language is requested.",
          "Mentioning a language as subject matter ('Japanese cinema', 'learning Spanish') is not choosing the output language.",
          "Return JSON with language as a BCP-47 language code, optional code and confidence. Do not answer or develop the book idea."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          currentBookLanguage: request.language ?? null,
          prompt: messages[0]!.content.slice(0, 4000),
          recentUserMessages: messages.slice(-4).map((message) => message.content.slice(-4000))
        })
      }
    ]
  });
  const language = result.data.language.trim().toLowerCase();
  return LANGUAGE_NAME_CODES[language] ?? language;
}

/** Shared by both language-bearing tools so a creative guess cannot overwrite
 * the resolved preference or acknowledge a language it will not deliver.
 */
export function assertCreationBookLanguage(proposed: string | undefined, language: string): void {
  if (proposed && normalizeProjectLanguage(proposed).toLowerCase() !== normalizeProjectLanguage(language).toLowerCase()) {
    const label = language === "en" ? "English" : normalizeProjectLanguage(language);
    throw new Error(`The user's book language is ${label}. Use that language for the book and its title suggestions; correct your reply and language setting accordingly.`);
  }
}
