import { type ConversationLanguage } from "@book-maker/core";
import { type BookEditIntent } from "../bookEditIntent.js";
import { chatCopy } from "../chatReplyCopy.js";
import { matterChatLanguage } from "./bookMatterChatLanguage.js";
import { type MobileProjectChatMessageRecord } from "./dto.js";
import { createAssistantChatMessage, type ProjectForChat } from "./projectChat.js";
import { removeTomezaCredit, type TomezaCreditRemoval } from "./tomezaCredit.js";
import { TOMEZA_CREDIT_CHAT_COPY } from "./tomezaCreditChatCopy.js";

/**
 * Applies a `tomeza_credit` intent through the decision the book's "Title &
 * credits" sheet uses (`removeTomezaCredit`): free, no `BookEditOperation`, no
 * ledger entry, no card, and never a page rewrite.
 *
 * A free account is not refused into a dead end. The reply says the line comes
 * with any plan and carries `metadata.insufficientCredits` — with no numbers,
 * so no price badge is drawn — because that is the one chat-metadata key every
 * shipped app turns into a button that opens the paywall, whose Monthly plans
 * tab is where the line comes off. The app reads the pair (that key on a
 * `tomeza_credit` intent, `asksForPlan` in `project_chat_models.dart`) as a
 * plan offer: its button reads "See plans" and the sheet opens on the plans,
 * with no shortfall. A build from before that still draws "Add credits" over
 * the credit packs, which is why the sentence says credits alone do not unlock
 * it. `metadata.pageLimit` was the other candidate and was rejected: its row
 * and offer speak only of page counts ("Your book wants N pages").
 */
export async function applyTomezaCreditEdit(options: {
  project: ProjectForChat;
  intent: BookEditIntent;
  userMessageId: string;
  message: string;
  /** The active transcript, oldest first, retains language for terse follow-ups. */
  activeMessages?: MobileProjectChatMessageRecord[] | undefined;
}): Promise<MobileProjectChatMessageRecord> {
  const { project, intent } = options;
  const replyLanguage = matterChatLanguage(intent.responseLanguage, options.activeMessages);
  const outcome = await removeTomezaCredit(project);
  return createAssistantChatMessage({
    projectId: project.id,
    parentId: options.userMessageId,
    content: tomezaCreditReply(outcome, replyLanguage),
    metadata: {
      intent,
      charged: false,
      replyLanguage,
      ...(outcome.kind === "subscription_required" ? { insufficientCredits: {} } : {})
    }
  });
}

/** What the chat says, by what the shared decision did. Never names a price. */
export function tomezaCreditReply(outcome: TomezaCreditRemoval, language?: ConversationLanguage): string {
  return chatCopy(TOMEZA_CREDIT_CHAT_COPY, language)[outcome.kind];
}
