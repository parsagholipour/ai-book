/** Languages offered by the app for model-selected chat replies. Printed book
 * language and deterministic matter-request grammars are separate concerns. */
export const CONVERSATION_LANGUAGES = [
  "en", "ar", "zh", "da", "nl", "fa", "fr", "de", "el", "he", "hi", "it", "ja",
  "ko", "no", "pl", "pt", "ru", "es", "sv", "th", "tr", "uk", "ur", "vi"
] as const;

export type ConversationLanguage = (typeof CONVERSATION_LANGUAGES)[number];
