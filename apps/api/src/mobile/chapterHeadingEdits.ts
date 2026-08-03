import { type BookEditIntent } from "../bookEditIntent.js";
import { type ChapterHeadingEdit } from "../bookEditChapterHeading.js";
import { type MobileProjectChatMessageRecord } from "./dto.js";
import { applyPresentationPreference } from "./presentationEdits.js";
import { createAssistantChatMessage, type ProjectForChat } from "./projectChat.js";
import {
  chapterHeadingLabelPreference,
  chapterHeadingStylePreference,
  DEFAULT_CHAPTER_HEADING_STYLE
} from "@book-maker/core";

/**
 * Applies a `chapter_heading` intent: how a chapter heading is worded in the
 * compiled book.
 *
 * The heading is not page text — `compileBookMarkdown` builds `Chapter N: Title`
 * at export time from a label table, and `cleanChapterTitle` strips that prefix
 * back off the stored title so it cannot be doubled. So the word lives in no
 * page's markdown and not even in `Chapter.title`, which makes restyling it a
 * project preference plus a recompile, never a page edit. That also makes it
 * free: no prose is regenerated, exactly like the sources toggle and undo.
 */
export async function applyChapterHeadingEdit(
  project: ProjectForChat,
  intent: BookEditIntent,
  parentId: string
): Promise<MobileProjectChatMessageRecord> {
  const edit: ChapterHeadingEdit = intent.chapterHeading ?? { style: "title_only" };
  const reply = (content: string) =>
    createAssistantChatMessage({
      projectId: project.id,
      parentId,
      content,
      metadata: { intent, charged: false, chapterHeading: edit }
    });

  const currentStyle = chapterHeadingStylePreference(project.mediaSettings) ?? DEFAULT_CHAPTER_HEADING_STYLE;
  const currentLabel = chapterHeadingLabelPreference(project.mediaSettings);
  if (edit.style === currentStyle && (edit.label ?? undefined) === currentLabel) {
    return reply(
      edit.style === DEFAULT_CHAPTER_HEADING_STYLE && !edit.label
        ? "Your chapters already open with the standard “Chapter” heading."
        : "Your chapter headings are already set up that way."
    );
  }
  if (!project.currentPlanId) {
    return reply("I can change that once this book has finished generating.");
  }

  await applyPresentationPreference(
    { ...project, currentPlanId: project.currentPlanId },
    {
      chapterHeadingStyle: edit.style,
      // Written as null rather than omitted: this is a merge onto the stored
      // settings, so leaving it out would keep a label the user just replaced.
      chapterHeadingLabel: edit.label ?? null
    }
  );

  return reply(`${describeChange(edit)} This one’s free.`);
}

function describeChange(edit: ChapterHeadingEdit): string {
  if (edit.label) {
    return `Done - your chapters now open with “${edit.label} 1”, “${edit.label} 2” and so on, and I’m refreshing the exports.`;
  }
  if (edit.style === "title_only") {
    return "Done - each chapter now opens with just its title, and I’m refreshing the exports.";
  }
  if (edit.style === "number_title") {
    return "Done - each chapter now opens with its number and title, without the word “Chapter”, and I’m refreshing the exports.";
  }
  return "Done - the “Chapter” heading is back, and I’m refreshing the exports.";
}
