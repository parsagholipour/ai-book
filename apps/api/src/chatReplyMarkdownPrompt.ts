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
