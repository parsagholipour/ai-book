/**
 * The light-markdown format sentence shared by every chat-reply prompt.
 *
 * Creation (`creationTurnMessages`), the finished-book grounded answer,
 * and the edit router (`bookEditRouterPrompt`) all write assistant text
 * the Flutter bubbles render, so they must ask for the same markup. A
 * leaf with no imports: `bookEditRouterPrompt` must stay able to import
 * this without reaching the mobile or database graph those modules need,
 * and this must not join that graph.
 */
export const CHAT_REPLY_MARKDOWN_PROMPT =
  "rendered as light markdown, so format for reading: **bold** for a name or the key term, a numbered list (1.) or a bulleted list (-) with one item per line whenever you list several things, and a blank line between paragraphs. No headings, tables, code blocks or links.";

/**
 * How every finished-book chat reply sounds: the edit router's
 * `assistantMessage` and the grounded answer. A reader called the chat "a bit
 * cocky" (2026-10-17) after it told them what it could do and to send the rest
 * as its own message; the fixed matter copy was softened the same day
 * (`bookMatterChatCopy.ts`), and this is the same rule for what a model writes.
 */
export const CHAT_REPLY_TONE_PROMPT =
  "Write to the user warmly and respectfully, the way a courteous assistant would: polite and plain, never curt, smug or lecturing. Never suggest they did something wrong or left something out, and never tell them what they should have written; when you need something from them, ask for it kindly.";
