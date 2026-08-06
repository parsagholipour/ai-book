/**
 * The message a chat turn is a reply to, stored as a snapshot rather than a
 * bare id.
 *
 * Both transcripts prune — project chat paginates, and the creation tree caps
 * at CREATION_STORED_MESSAGE_CAP with older turns folded into a summary — so an
 * id alone would eventually point at nothing and the quote would vanish from a
 * message that visibly needs it. The excerpt always renders; the id is kept so a
 * later version can scroll to the original.
 *
 * A quote is context for the *model*, never for the deterministic edit
 * extractors. It must not be spliced into the routed message string:
 * `quotedTexts` treats any "..." as an edit target and `pageIndexesFromMessage`
 * reads any "page 4" as a page selection, so a quoted assistant sentence would
 * silently retarget and reprice an edit. Pass it as its own argument instead.
 *
 * This module deliberately imports nothing: it is reached from `bookEditIntent`,
 * whose suite runs without the database mocks the mobile modules need.
 */

export const CHAT_REPLY_EXCERPT_MAX = 240;

export type ChatReplyRole = "user" | "assistant";

export type ChatReplyQuote = {
  messageId: string;
  role: ChatReplyRole;
  excerpt: string;
};

/** Collapses whitespace and clips on a word boundary when there is a near one. */
function clipExcerpt(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= CHAT_REPLY_EXCERPT_MAX) {
    return normalized;
  }
  const clipped = normalized.slice(0, CHAT_REPLY_EXCERPT_MAX);
  const lastSpace = clipped.lastIndexOf(" ");
  const minBreak = Math.floor(CHAT_REPLY_EXCERPT_MAX * 0.65);
  return `${clipped.slice(0, lastSpace > minBreak ? lastSpace : CHAT_REPLY_EXCERPT_MAX).trim()}...`;
}

/**
 * Builds the snapshot from the replied-to row. Anything that is not USER is
 * quoted as the assistant, matching how `recentMessages` collapses the role.
 */
export function chatReplyQuoteFor(message: {
  id: string;
  role: string;
  content: string;
}): ChatReplyQuote | null {
  const excerpt = clipExcerpt(message.content);
  if (!excerpt) {
    return null;
  }
  return {
    messageId: message.id,
    role: message.role.toUpperCase() === "USER" ? "user" : "assistant",
    excerpt
  };
}

/** Reads a snapshot back off stored JSON, tolerating rows written by hand. */
export function parseChatReplyQuote(value: unknown): ChatReplyQuote | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const messageId = typeof record.messageId === "string" ? record.messageId.trim() : "";
  const excerpt = typeof record.excerpt === "string" ? record.excerpt.trim() : "";
  if (!messageId || !excerpt) {
    return null;
  }
  return {
    messageId,
    role: record.role === "user" ? "user" : "assistant",
    excerpt: clipExcerpt(excerpt)
  };
}

/**
 * The shape handed to a model. Only the role and the text matter to it — the id
 * is ours — and dropping it keeps the id out of anything the model might echo.
 */
export function chatReplyQuoteForPrompt(
  quote: ChatReplyQuote | null | undefined
): { role: ChatReplyRole; excerpt: string } | undefined {
  return quote ? { role: quote.role, excerpt: quote.excerpt } : undefined;
}

/** One transcript line's worth, for prompts that are plain text rather than JSON. */
export function chatReplyQuoteLabel(quote: ChatReplyQuote): string {
  return `replying to ${quote.role === "user" ? "their own earlier message" : "the assistant"}: "${quote.excerpt}"`;
}
