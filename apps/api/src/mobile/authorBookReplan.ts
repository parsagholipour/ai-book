import { isAuthorManuscript } from "@book-maker/core";
import type { BookEditIntent } from "../bookEditIntent.js";
import type { MobileProjectChatMessageRecord } from "./dto.js";
import { createAssistantChatMessage } from "./projectChat.js";

/**
 * The chat never rebuilds an author's book from a new plan.
 *
 * A `book_replan` forks a copy of the book and regenerates it whole
 * (`replanCopyOperations.ts`), and the copy inherits the book's media settings
 * — the Studio or import record with them — so it was an author manuscript the
 * pipeline then wrote over from scratch, charged as a replan. Every other
 * generation route already refuses an author's book (`AUTHOR_MANUSCRIPT`); this
 * is the chat's door, asked at the proposal *and* at Apply, because a card
 * quoted before a takeover can still be applied after it. The reply offers what
 * the chat can still do rather than stopping at "no".
 */
export const AUTHOR_BOOK_REPLAN_MESSAGE =
  "This book is yours now, so I won't rebuild it from a new plan. Tell me which pages or chapters to change and I'll suggest the edit — or keep writing it in the Writing Studio.";

/** The refusal message for an author's book, or null for a generated one. */
export async function refuseAuthorBookReplan(options: {
  project: { id: string; mediaSettings: unknown };
  userMessageId: string;
  intent: BookEditIntent;
}): Promise<MobileProjectChatMessageRecord | null> {
  if (!isAuthorManuscript(options.project.mediaSettings)) {
    return null;
  }
  return createAssistantChatMessage({
    projectId: options.project.id,
    parentId: options.userMessageId,
    content: AUTHOR_BOOK_REPLAN_MESSAGE,
    metadata: { intent: options.intent, charged: false }
  });
}
