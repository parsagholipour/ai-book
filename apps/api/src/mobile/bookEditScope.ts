import { type BookEditIntent } from "../bookEditIntent.js";
import { quotedTexts, replacementTermsFromMessage } from "../bookEditMessage.js";
import { type ProjectForChat } from "./projectChat.js";
import { bookPlanSchema, type ExactReplacement } from "@book-maker/core";
import { prisma } from "@book-maker/db";

/**
 * Which pages an edit touches, and what the classifier is told about the book.
 *
 * Split out of `bookEditIntents.ts` because this is the input to pricing rather
 * than part of handling an intent: every quote and every charge multiplies the
 * page count these functions return, so they are worth reading on their own.
 */

export function planSummaryForClassifier(planVersion: { planningPackage: unknown }): string {
  const parsed = bookPlanSchema.safeParse(planVersion.planningPackage);
  if (!parsed.success) {
    return "";
  }
  return [
    parsed.data.title,
    parsed.data.premise,
    parsed.data.audience,
    ...parsed.data.chapters.slice(0, 8).map((chapter) => `${chapter.index}. ${chapter.title}: ${chapter.summary}`)
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 3000);
}

/**
 * Resolves an intent's scope to concrete page indexes.
 *
 * The `all_pages` branch is where a scope label becomes an N-page bill, so an
 * intent that reaches here with `all_pages` had better be one that really needs
 * every page rewritten. Presentation changes (`back_matter`, `chapter_heading`)
 * carry `scope: "none"` and an empty page list precisely so they can never
 * expand here.
 */
export async function affectedPagesForIntent(
  intent: BookEditIntent,
  message: string,
  project: Pick<ProjectForChat, "id" | "pages">
): Promise<number[]> {
  const pages = project.pages;
  const available = new Set(pages.map((page) => page.index));
  if (intent.kind === "chapter_regenerate" && intent.affectedChapterIndex) {
    return pages
      .filter((page) => page.chapter?.index === intent.affectedChapterIndex)
      .map((page) => page.index)
      .sort((a, b) => a - b);
  }
  const explicit = intent.affectedPageIndexes.filter((index) => available.has(index));
  if (explicit.length > 0) {
    return [...new Set(explicit)].sort((a, b) => a - b);
  }
  if (intent.kind === "book_replan") {
    return [];
  }
  if (intent.scope === "all_pages") {
    return pages.map((page) => page.index).sort((a, b) => a - b);
  }
  if (intent.scope === "matching_pages") {
    return pagesMatchingEditText(message, project.id);
  }
  const quotedMatches = await pagesMatchingQuotedText(message, project.id);
  if (quotedMatches.length > 0) {
    return quotedMatches;
  }
  return [];
}

/**
 * Pages a continuation will append: requested chapter count × the median
 * size of the book's existing chapters (clamped 3-15). Deterministic, so the
 * proposal price and the queued job always agree.
 */
export function continuationNewPageCount(intent: BookEditIntent, project: Pick<ProjectForChat, "pages">): number {
  const chapterCount = Math.min(8, Math.max(1, intent.continuation?.chapterCount ?? 1));
  const chapterSizes = new Map<number, number>();
  for (const page of project.pages) {
    const chapterIndex = page.chapter?.index;
    if (typeof chapterIndex === "number") {
      chapterSizes.set(chapterIndex, (chapterSizes.get(chapterIndex) ?? 0) + 1);
    }
  }
  const sizes = [...chapterSizes.values()].sort((a, b) => a - b);
  const median = sizes.length > 0 ? sizes[Math.floor(sizes.length / 2)]! : 5;
  return chapterCount * Math.min(15, Math.max(3, median));
}

export function exactReplacementFromMessage(message: string): ExactReplacement | null {
  return replacementTermsFromMessage(message);
}

export async function pagesMatchingEditText(message: string, projectId: string): Promise<number[]> {
  const replacement = replacementTermsFromMessage(message);
  if (replacement) {
    return pagesMatchingNeedle(replacement.from, projectId);
  }
  return pagesMatchingQuotedText(message, projectId);
}

export async function pagesMatchingQuotedText(message: string, projectId: string): Promise<number[]> {
  const quotes = quotedTexts(message);
  if (quotes.length === 0) {
    return [];
  }
  return pagesMatchingNeedle(quotes[0]!, projectId);
}

/**
 * Full-text needle matching runs in the database so chat never loads every
 * page's markdown.
 *
 * Deliberately case-**insensitive**. `hasExactMatch` itself is literal unless
 * `preserveCase` is set — it is `planExactReplacement` falling back to
 * `preserveCase` when the literal text appears nowhere that restores the
 * agreement with this search. A bare `String.includes` downstream still
 * disagrees with it and quietly sends the pages it selected to the model.
 */
export async function pagesMatchingNeedle(needleSource: string, projectId: string): Promise<number[]> {
  const needle = needleSource.trim();
  if (!needle) {
    return [];
  }
  const matches = await prisma.page.findMany({
    where: {
      projectId,
      OR: [
        { markdown: { contains: needle, mode: "insensitive" } },
        { title: { contains: needle, mode: "insensitive" } },
        { summary: { contains: needle, mode: "insensitive" } }
      ]
    },
    select: { index: true }
  });
  return matches.map((match) => match.index).sort((a, b) => a - b);
}
