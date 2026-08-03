import { type BookEditIntent } from "../bookEditIntent.js";
import { type MobileProjectChatMessageRecord } from "./dto.js";
import { applyPresentationPreference } from "./presentationEdits.js";
import { createAssistantChatMessage, type ProjectForChat } from "./projectChat.js";
import { includeSourcesPreference } from "@book-maker/core";

/**
 * Applies a `back_matter` intent: the reader-facing Sources list at the end of
 * the book.
 *
 * The section is not page text — `compileBookMarkdown` builds it from the
 * project's ResearchSource rows on every export — so removing it is a project
 * preference plus a recompile, never a page edit. That also makes it free: no
 * prose is regenerated, exactly like undo.
 */
export async function applyBackMatterEdit(
  project: ProjectForChat,
  intent: BookEditIntent,
  parentId: string
): Promise<MobileProjectChatMessageRecord> {
  const includeSources = intent.backMatter?.includeSources ?? false;
  const current = includeSourcesPreference(project.mediaSettings);
  const reply = (content: string) =>
    createAssistantChatMessage({
      projectId: project.id,
      parentId,
      content,
      metadata: { intent, charged: false, backMatter: { includeSources } }
    });

  if (!includeSources && project.research.length === 0) {
    return reply("This book doesn’t have a sources list at the end, so there’s nothing to remove there.");
  }
  // `undefined` is the automatic per-category decision, which already prints
  // the list wherever it belongs — so it counts as "on" for a restore request.
  if (includeSources === (current ?? true)) {
    return reply(
      includeSources
        ? "The sources list is already set to print at the end of your book."
        : "I’ve already taken the sources list out of this book."
    );
  }
  if (!project.currentPlanId) {
    return reply("I can change that once this book has finished generating.");
  }

  await applyPresentationPreference({ ...project, currentPlanId: project.currentPlanId }, { includeSources });

  return reply(
    includeSources
      ? "Done - the sources list is back at the end of your book and I’m refreshing the exports. This one’s free."
      : "Done - I removed the sources list from the end of your book and I’m refreshing the exports. This one’s free."
  );
}
