import type { BookEditIntent } from "./bookEditIntent.js";

/** A standalone rerun command already has a target: the current finished book. */
export function bookRegenerationIntent(message: string, hasConversationTarget = false): BookEditIntent | null {
  // Match the entire command so questions, negations and page/image requests
  // cannot become an expensive whole-book proposal. Contextual fragments still
  // belong to the model, which can resolve the earlier page/chapter request.
  const command = message.trim().replace(/[.!]+$/, "").trim();
  const wholeBook = /^(?:please\s+)?(?:regenerate|generate|rebuild|redo)\s+(?:(?:the|this|my)\s+)?(?:(?:whole|entire)\s+)?book(?:\s+again)?(?:\s+please)?$/i.test(command);
  const standalone = /^(?:please\s+)?(?:generate\s+again|regenerate(?:\s+again)?|rebuild\s+again)(?:\s+please)?$/i.test(command);
  if (!wholeBook && (!standalone || hasConversationTarget)) return null;

  return {
    kind: "book_replan",
    confidence: 1,
    reasoning: "An explicit regeneration command targets the completed book.",
    affectedPageIndexes: [],
    assistantMessage: "I’ll regenerate the book as a new copy. Review the cost and tap Apply to start.",
    editInstruction: "Regenerate the entire book as a new copy using the existing brief, language, length, and media settings. Produce fresh content while preserving the book's subject and requirements.",
    scope: "all_pages",
    impact: "structural_replan",
    clarification: "none"
  };
}
