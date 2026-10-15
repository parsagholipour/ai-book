import type { BookEditScope } from "./bookEditIntent.js";

/**
 * Reading a message's scope — "the whole book", "every page", "throughout" —
 * and the two ways a scope or a follow-up is written back onto a request.
 * Split out of `bookEditMessage.ts` (which re-exports it) at its size budget;
 * nothing here reads page numbers.
 */

export function bookEditScopeFromMessage(message: string): BookEditScope {
  return hasAllPagesScope(message) ? "all_pages" : "none";
}

export function isBookEditScopeOnlyMessage(message: string): boolean {
  const normalized = normalizeScopeOnlyText(message);
  if (!hasAllPagesScope(normalized)) {
    return false;
  }
  const withoutScope = normalized
    .replace(/\b(?:the\s+)?(?:whole|entire|full)\s+(?:book|story|manuscript)\b/g, "")
    .replace(/\b(?:all|every)\s+(?:pages?|chapters?|book|story)\b/g, "")
    .replace(/\b(?:everywhere|throughout|globally)\b/g, "")
    .trim();
  return withoutScope.length === 0;
}

export function messageWithScope(message: string, scope: BookEditScope): string {
  if (scope === "all_pages") {
    return `${message.trim().replace(/[.?!]+$/g, "")} throughout the whole book.`;
  }
  return message.trim();
}

/**
 * Re-attaches the request a clarification was asked about to the reply that did
 * not answer it, so the router, the heuristic hint, the resolved page targets
 * and the queued operation all see the real request rather than a fragment like
 * "just add" whose meaning lives entirely in the previous turn.
 */
export function messageWithFollowUp(request: string, followUp: string): string {
  const original = request.trim();
  const reply = followUp.trim();
  if (!original || original.toLowerCase() === reply.toLowerCase()) {
    return reply;
  }
  return `${original}\n\nFollow-up from the user: ${reply}`;
}

export function hasAllPagesScope(message: string): boolean {
  return /\b(?:whole|entire|full)\s+(?:book|story|manuscript)\b/i.test(message) ||
    /\b(?:all|every)\s+(?:pages?|chapters?)\b/i.test(message) ||
    /\b(?:everywhere|throughout|globally)\b/i.test(message) ||
    /\bacross\s+(?:the\s+)?(?:book|story|all pages)\b/i.test(message);
}

function normalizeScopeOnlyText(message: string): string {
  return message
    .toLowerCase()
    .replace(/(?<![.!?])[.!?]+$/g, "")
    .replace(/^(?:i\s+(?:said|mean|meant|told\s+you)\s+|just\s+|please\s+|do\s+|make\s+it\s+|the\s+)/i, "")
    .replace(/(?<!\s)\s+please$/i, "")
    .trim();
}
