import { CONVERSATION_LANGUAGES, type ConversationLanguage } from "@book-maker/core";

export type MatterChatLanguage = ConversationLanguage;
const LANGUAGES: ReadonlySet<string> = new Set(CONVERSATION_LANGUAGES);

function supportedLanguage(value: unknown): value is MatterChatLanguage {
  return typeof value === "string" && LANGUAGES.has(value);
}

/**
 * Reply language is a model decision: the router reads the request and history,
 * and the matter composer can refine it in its existing call. When a call fails
 * or returns no supported language, retain the last model-selected conversation
 * language. With no such history, use English. Text, script and word counts
 * never guess a language here.
 */
export function matterChatLanguage(
  modelLanguage: unknown,
  recent: readonly { role: string; metadata?: unknown }[] = []
): MatterChatLanguage {
  return establishedChatLanguage(modelLanguage, recent) ?? "en";
}

/**
 * The same decision without the English default: undefined when neither the
 * model nor any saved turn named a language. This is what a prompt is told as
 * its `conversationLanguage`, because a defaulted "en" reads there as English
 * established — a Persian chat from before languages were saved then had a bare
 * ISBN or name answered in English. Omitted, the prompt falls back to the
 * reader's earlier instructions in the transcript it is shown.
 */
export function establishedChatLanguage(
  modelLanguage: unknown,
  recent: readonly { role: string; metadata?: unknown }[] = []
): MatterChatLanguage | undefined {
  if (supportedLanguage(modelLanguage)) return modelLanguage;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const turn = recent[index]!;
    if (turn.role !== "ASSISTANT") continue;
    const metadata = turn.metadata;
    if (!metadata || typeof metadata !== "object") continue;
    if ("replyLanguage" in metadata && supportedLanguage(metadata.replyLanguage)) return metadata.replyLanguage;
    // Other chat actions store their router decision in intent; their prose
    // also establishes the conversation for a later matter or credit edit.
    const intent = "intent" in metadata ? metadata.intent : undefined;
    if (intent && typeof intent === "object" && "responseLanguage" in intent && supportedLanguage(intent.responseLanguage)) {
      return intent.responseLanguage;
    }
  }
  return undefined;
}
