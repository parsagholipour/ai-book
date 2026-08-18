import {
  assertBookLikeMarkdown,
  AUTO_BOOK_GENERATION_STRATEGY_ID,
  getBookGenerationStrategy,
  chapterHeadingLabelPreference,
  chapterHeadingStylePreference,
  includeSourcesPreference,
  mediaSettingsSchema,
  resolvePublicImageUrl,
  type BookPageMapPlan
} from "@book-maker/core";
import { prisma, researchCitationsForExport } from "@book-maker/db";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Compiling a project's manuscript for the operator export routes.
 *
 * Split out of `projectExports.ts`, which owns the rebuild-and-publish
 * machinery; this module owns only "what the book compiles from". Note the
 * inline render is the API-side twin of the worker's compile — anything that
 * changes what a compiled file contains belongs in `packages/core`, not here.
 */

const BOOK_MARKDOWN_FILENAME = "book.md";
const LEGACY_BOOK_MARKDOWN_FILENAME = "README.md";

export async function compileProjectMarkdown(
  projectId: string,
  publicApiUrl: string,
  bookStorageDir: string
): Promise<string | null> {
  const manuscript = await compileProjectManuscript(projectId, publicApiUrl, bookStorageDir);
  return manuscript?.markdown ?? null;
}

/**
 * The manuscript plus — when it was compiled from the durable pages rather than
 * read back off disk — the anchor plan the PDF page map is measured from. A
 * saved `book.md` carries no offsets, so a rebuild from one renders unmeasured
 * and must replace translatable ranges with a cover-numbering stub rather than
 * leave a map from a different pass.
 */
export async function compileProjectManuscript(
  projectId: string,
  publicApiUrl: string,
  bookStorageDir: string
): Promise<{ markdown: string; pageMapPlan?: BookPageMapPlan } | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      currentPlan: true,
      pages: { orderBy: { index: "asc" }, include: { images: true } },
      images: true,
      research: true
    }
  });
  if (!project?.currentPlan) {
    return savedBookManuscript(projectId, bookStorageDir);
  }

  const generatedPages = project.pages.filter((page) => page.markdown.trim().length > 0);
  if (generatedPages.length === 0) {
    return savedBookManuscript(projectId, bookStorageDir);
  }

  const strategy = strategyForMediaSettings(project.mediaSettings);
  const cover = project.images.find((image) => image.type === "COVER");
  const compiled = strategy.compileMarkdownWithPageAnchors({
    plan: project.currentPlan.planningPackage as never,
    category: project.category,
    language: project.language,
    ...(project.authorName ? { authorName: project.authorName } : {}),
    ...(cover
      ? {
          cover: {
            imagePath: resolvePublicImageUrl(cover.path, publicApiUrl) ?? cover.path,
            imageAlt: `Cover for ${project.title}`
          }
        }
      : {}),
    pages: generatedPages.map((page) => ({
      index: page.index,
      title: page.title,
      markdown: page.markdown,
      imagePath: resolvePublicImageUrl(page.images[0]?.path, publicApiUrl),
      imageAlt: "Illustration"
    })),
    // Through the shared builder, not a local map: it unwraps a stored Google
    // grounding redirect and writes the publisher's own address back, so this
    // render cannot print a link the worker's render of the same book would not.
    researchSources: await researchCitationsForExport(project.research),
    includeSources: includeSourcesPreference(project.mediaSettings),
    chapterHeadingStyle: chapterHeadingStylePreference(project.mediaSettings),
    chapterHeadingLabel: chapterHeadingLabelPreference(project.mediaSettings)
  });
  assertBookLikeMarkdown(compiled.markdown);
  return { markdown: compiled.markdown, pageMapPlan: compiled };
}

async function savedBookManuscript(
  projectId: string,
  bookStorageDir: string
): Promise<{ markdown: string } | null> {
  const markdown = await readSavedBookMarkdown(projectId, bookStorageDir);
  return markdown === null ? null : { markdown };
}

async function readSavedBookMarkdown(projectId: string, bookStorageDir: string): Promise<string | null> {
  for (const filename of [BOOK_MARKDOWN_FILENAME, LEGACY_BOOK_MARKDOWN_FILENAME]) {
    try {
      const markdown = await readFile(join(bookStorageDir, projectId, filename), "utf8");
      return markdown.trim().length > 0 ? markdown : null;
    } catch {
      // Try the next legacy filename.
    }
  }
  return null;
}

export function strategyForMediaSettings(mediaSettings: unknown) {
  const selection = mediaSettingsSchema.parse(mediaSettings).generationStrategy;
  return getBookGenerationStrategy(selection === AUTO_BOOK_GENERATION_STRATEGY_ID ? undefined : selection);
}

export function sanitizeDownloadFilename(title: string): string {
  const clean = title
    .trim()
    .replace(/[^\w\s-]+/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80);
  return clean || "book";
}
