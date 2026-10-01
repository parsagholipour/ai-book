import { type BookEditIntent } from "../bookEditIntent.js";
import { applyBackMatterEdit } from "./backMatterEdits.js";
import { applyChapterHeadingEdit } from "./chapterHeadingEdits.js";
import { type MobileProjectChatMessageRecord } from "./dto.js";
import { applyPageDesignEdit } from "./pageDesignEdits.js";
import { type ProjectForChat } from "./projectChat.js";

/**
 * The chat's presentation edits — the Sources list, the chapter headings and
 * the page design — each a free `mediaSettings` preference plus a recompile
 * (`presentationEdits.ts`). Answered only on a finished book, which is what the
 * recompile needs; anywhere else this returns null and the request takes the
 * not-finished-yet reply every edit gets. Listing the page designs changes
 * nothing, so it is answered at any status.
 */
export async function applyPresentationIntent(
  project: ProjectForChat,
  intent: BookEditIntent,
  userMessageId: string
): Promise<MobileProjectChatMessageRecord | null> {
  if (intent.kind === "page_design" && intent.pageDesign?.list) {
    return applyPageDesignEdit(project, intent, userMessageId);
  }
  if (!["COMPLETE", "REVIEW_REQUIRED"].includes(project.status)) {
    return null;
  }
  switch (intent.kind) {
    case "back_matter":
      return applyBackMatterEdit(project, intent, userMessageId);
    case "chapter_heading":
      return applyChapterHeadingEdit(project, intent, userMessageId);
    case "page_design":
      return applyPageDesignEdit(project, intent, userMessageId);
    default:
      return null;
  }
}
