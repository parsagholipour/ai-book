import { type BookEditIntent } from "../bookEditIntent.js";
import { pageDesignCatalogLines, type PageDesignEdit } from "../bookEditPageDesign.js";
import { bookUpdateMetadata } from "./bookUpdateMetadata.js";
import { type MobileProjectChatMessageRecord } from "./dto.js";
import { applyPresentationPreference } from "./presentationEdits.js";
import { createAssistantChatMessage, type ProjectForChat } from "./projectChat.js";
import { jsonRecord } from "./support.js";
import {
  allStoryPageDesigns,
  chooseStoryPageDesign,
  storyPageDesign,
  storyPageDesignFor,
  storyPageLayoutFor,
  type StoryPageDesignId
} from "@book-maker/core";
import { prisma } from "@book-maker/db";

/**
 * Applies a `page_design` intent: the design a picture book's text-only pages
 * print in (`storyPageDesigns.ts` in core).
 *
 * The design is a compile preference — `storyPageDesign` on the project row,
 * read by both compiles through `storyPageDesignFor` — so changing it is the
 * free presentation recompile the chapter headings and the Sources list use.
 *
 * It only shows on a book printed one scene a sheet with nothing but words on
 * them: the stylesheet dresses those sheets alone, and leaves a book with
 * pictures, figures or tables in its scenes in the layout they were drawn for.
 * Writing the preference anywhere else would recompile an identical book and
 * tell the reader it changed, so that book gets the truth instead.
 */
export async function applyPageDesignEdit(
  project: ProjectForChat,
  intent: BookEditIntent,
  parentId: string
): Promise<MobileProjectChatMessageRecord> {
  const edit: PageDesignEdit = intent.pageDesign ?? { design: null };
  const reply = (content: string, applied?: StoryPageDesignId, rebuilt?: { contentRevision: number }) =>
    createAssistantChatMessage({
      projectId: project.id,
      parentId,
      content,
      metadata: {
        intent,
        charged: false,
        pageDesign: { ...edit, ...(applied ? { applied } : {}) },
        ...bookUpdateMetadata(rebuilt?.contentRevision)
      }
    });

  const plan = jsonRecord(project.currentPlan?.planningPackage);
  const book = {
    mediaSettings: project.mediaSettings,
    category: project.category,
    prompt: project.prompt,
    plan: {
      title: stringOrNull(plan.title),
      subtitle: stringOrNull(plan.subtitle),
      premise: stringOrNull(plan.premise),
      audience: stringOrNull(plan.audience)
    }
  };
  // A book with no design prints the plain sheet, which is the classic one.
  const current = storyPageDesignFor(book) ?? "classic";

  if (edit.list) {
    return reply(`Your book’s pages can be printed in any of these designs:\n\n${pageDesignCatalogLines(current)}\n\nJust tell me which one you’d like — changing it is free.`);
  }
  if (!project.currentPlanId) {
    return reply("I can change that once this book has finished generating.");
  }

  const shows = await designShowsIn(project);
  if (shows !== "yes") {
    return reply(
      shows === "pictures"
        ? "This book’s pages are laid out around their pictures, so a page design wouldn’t show on them. Page designs are for picture books printed without illustrations. Nothing was changed."
        : "Page designs are for picture books printed one scene to a page, and this book’s pages flow like a regular book’s, so a design wouldn’t show. Nothing was changed."
    );
  }

  const target = edit.design ?? differentDesign(current, bookText(book));
  const chosen = storyPageDesign(target);
  if (target === current) {
    return reply(`Your pages are already in the **${chosen.label}** design — ${chosen.summary}. ${otherDesignsLine(target)}`);
  }

  const rebuilt = await applyPresentationPreference({ ...project, currentPlanId: project.currentPlanId }, { storyPageDesign: target });
  return reply(
    `Done — your pages are now in the **${chosen.label}** design: ${chosen.summary}. This one’s free, and I’m refreshing the exports.\n\n${otherDesignsLine(target)}`,
    target,
    rebuilt
  );
}

/**
 * Whether a design would print on this book: one scene a sheet (the story
 * layout both compiles choose by), and no scene holding what the stylesheet
 * leaves in its own layout — a picture, a figure, a table or a code block.
 */
async function designShowsIn(project: ProjectForChat): Promise<"yes" | "pictures" | "flow"> {
  const pages = await prisma.page.findMany({
    where: { projectId: project.id },
    orderBy: { index: "asc" },
    select: { index: true, markdown: true }
  });
  const written = pages.filter((page) => page.markdown.trim().length > 0);
  if (storyPageLayoutFor(project, written) !== "separate") {
    return "flow";
  }
  const drawnInScene = written.some((page) => /!\[[^\]]*]\(|<img\b|^\s*(?:```|~~~)|^\s*\|.*\|\s*$/m.test(page.markdown));
  if (drawnInScene) {
    return "pictures";
  }
  const illustrations = await prisma.imageAsset.count({
    where: { projectId: project.id, pageId: { not: null }, type: { in: ["SCENE_ILLUSTRATION", "DIAGRAM"] } }
  });
  return illustrations > 0 ? "pictures" : "yes";
}

/**
 * "Something different": the book's own match when that is not what it wears
 * already (a reader who once picked the sea gets the night sky a bedtime story
 * would have had), else the next design in the catalog. Never the plain one —
 * a reader asking for a new look did not ask for less of one.
 */
function differentDesign(current: StoryPageDesignId, text: string): StoryPageDesignId {
  const matched = chooseStoryPageDesign(text);
  if (matched !== current && matched !== "classic") {
    return matched;
  }
  const ids = allStoryPageDesigns().map((design) => design.id);
  for (let step = 1; step <= ids.length; step += 1) {
    const next = ids[(ids.indexOf(current) + step) % ids.length]!;
    if (next !== current && next !== "classic") {
      return next;
    }
  }
  return "storybook";
}

function otherDesignsLine(current: StoryPageDesignId): string {
  const others = allStoryPageDesigns()
    .filter((design) => design.id !== current)
    .map((design) => design.label);
  return `Other designs: ${others.join(", ")} — just ask.`;
}

function bookText(book: { prompt: string; plan: Record<string, string | null> }): string {
  return [book.prompt, ...Object.values(book.plan)].filter((part): part is string => Boolean(part)).join("\n");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
