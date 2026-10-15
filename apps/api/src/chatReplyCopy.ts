import type { ConversationLanguage } from "@book-maker/core";

/**
 * A table of the chat's fixed replies — the ones no model writes, so nothing
 * else translates them: one complete entry per conversation language, English
 * included. The `Record` is what makes the compiler refuse a language without
 * an entry, or an entry without a key the others have, so a sentence changed
 * in one language is changed in the one place every other language sits
 * beside it. `chatCopyTables.test.ts` holds every table to the same
 * placeholders and the same specifics as its English entry.
 *
 * Each feature keeps its own table next to its code (furniture, matter, the
 * Tomeza credit, busy, cancel/undo/redo, book title), so no one file has to
 * hold every language's every sentence.
 */
export type ChatCopyTable<Entry> = Readonly<Record<ConversationLanguage, Entry>>;

/** The entry for a conversation language; English when there is none, or it is not one the app offers. */
export function chatCopy<Entry>(table: ChatCopyTable<Entry>, language: string | null | undefined): Entry {
  return language && Object.hasOwn(table, language) ? table[language as ConversationLanguage] : table.en;
}

/**
 * A template with its `{name}` placeholders filled. A value is inserted as
 * given — never expanded again, and a "$&" in a reader's title prints as typed —
 * and a placeholder with no value is dropped rather than shown.
 */
export function fillChatCopy(template: string, values: Readonly<Record<string, string>> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => values[key] ?? "");
}
