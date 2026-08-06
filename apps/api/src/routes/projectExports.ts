import {
  assertBookLikeMarkdown,
  AUTO_BOOK_GENERATION_STRATEGY_ID,
  generateBookEpub,
  getBookGenerationStrategy,
  chapterHeadingLabelPreference,
  chapterHeadingStylePreference,
  includeSourcesPreference,
  mediaSettingsSchema,
  resolvePublicImageUrl,
  type AppConfig
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * The compiled book on disk: how it is named, how it is rebuilt from the
 * database when missing, and how it is sent to a client.
 *
 * Both the operator API and the mobile API serve the same files, so this lives
 * apart from either route module.
 */

const BOOK_MARKDOWN_FILENAME = "book.md";
const LEGACY_BOOK_MARKDOWN_FILENAME = "README.md";
const BOOK_PDF_FILENAME = "book.pdf";
const BOOK_EPUB_FILENAME = "book.epub";

export type ProjectPdfExportSource = {
  title: string;
  /**
   * Load-bearing on the lazy rebuild path below: a PDF regenerated without it
   * has no fonts for the book's script and comes back as tofu.
   */
  language: string;
  currentPlanId: string | null;
  mediaSettings: unknown;
};

export type ProjectEpubExportSource = {
  title: string;
  language: string;
  currentPlanId: string | null;
};

export type ProjectExportFormat = "pdf" | "epub";

/**
 * Size and mtime come back alongside availability because the mobile reader
 * caches the downloaded PDF on the device: together they identify the exact
 * file on disk, so a cached copy can be reused without re-downloading and a
 * recompiled book is detected as stale.
 */
export async function projectExportAvailability(
  appConfig: AppConfig,
  projectId: string,
  format: ProjectExportFormat
): Promise<{ available: boolean; byteSize: number | null; modifiedAt: Date | null }> {
  const filename = format === "pdf" ? BOOK_PDF_FILENAME : BOOK_EPUB_FILENAME;
  try {
    const stats = await stat(join(appConfig.BOOK_STORAGE_DIR, projectId, filename));
    return { available: true, byteSize: stats.size, modifiedAt: stats.mtime };
  } catch {
    return { available: false, byteSize: null, modifiedAt: null };
  }
}

export async function sendProjectPdfExport(options: {
  request: FastifyRequest;
  reply: FastifyReply;
  appConfig: AppConfig;
  projectId: string;
  project: ProjectPdfExportSource;
  disposition?: "attachment" | "inline";
}) {
  const { request, reply, appConfig, projectId, project, disposition = "attachment" } = options;
  const pdfPath = join(appConfig.BOOK_STORAGE_DIR, projectId, BOOK_PDF_FILENAME);
  let pdf: Buffer;
  try {
    await access(pdfPath);
    pdf = await readFile(pdfPath);
  } catch {
    if (!project.currentPlanId) {
      return reply.code(404).send({ error: "Book not found" });
    }
    const markdown = await compileProjectMarkdown(projectId, appConfig.PUBLIC_API_URL, appConfig.BOOK_STORAGE_DIR);
    if (!markdown) {
      return reply.code(404).send({ error: "Book not found" });
    }
    try {
      await mkdir(dirname(pdfPath), { recursive: true });
      const strategy = strategyForMediaSettings(project.mediaSettings);
      pdf = await strategy.generatePdf(markdown, {
        imageStorageDir: appConfig.IMAGE_STORAGE_DIR,
        publicApiUrl: appConfig.PUBLIC_API_URL,
        outputPath: pdfPath,
        language: project.language
      });
    } catch (error) {
      request.log.error({ err: error, projectId }, "PDF generation failed");
      return reply.code(500).send({ error: "PDF generation failed" });
    }
  }

  const filename = `${sanitizeDownloadFilename(project.title)}.pdf`;
  reply.header("Content-Disposition", `${disposition}; filename="${filename}"`);
  reply.type("application/pdf");
  return pdf;
}

export async function sendProjectEpubExport(options: {
  request: FastifyRequest;
  reply: FastifyReply;
  appConfig: AppConfig;
  projectId: string;
  project: ProjectEpubExportSource;
}) {
  const { request, reply, appConfig, projectId, project } = options;
  const epubPath = join(appConfig.BOOK_STORAGE_DIR, projectId, BOOK_EPUB_FILENAME);
  let epub: Buffer;
  try {
    await access(epubPath);
    epub = await readFile(epubPath);
  } catch {
    if (!project.currentPlanId) {
      return reply.code(404).send({ error: "Book not found" });
    }
    const markdown = await compileProjectMarkdown(projectId, appConfig.PUBLIC_API_URL, appConfig.BOOK_STORAGE_DIR);
    if (!markdown) {
      return reply.code(404).send({ error: "Book not found" });
    }
    try {
      await mkdir(dirname(epubPath), { recursive: true });
      epub = await generateBookEpub(markdown, {
        title: project.title,
        language: project.language,
        imageStorageDir: appConfig.IMAGE_STORAGE_DIR,
        publicApiUrl: appConfig.PUBLIC_API_URL,
        outputPath: epubPath
      });
    } catch (error) {
      request.log.error({ err: error, projectId }, "EPUB generation failed");
      return reply.code(500).send({ error: "EPUB generation failed" });
    }
  }

  const filename = `${sanitizeDownloadFilename(project.title)}.epub`;
  reply.header("Content-Disposition", `attachment; filename="${filename}"`);
  reply.type("application/epub+zip");
  return epub;
}

export async function compileProjectMarkdown(
  projectId: string,
  publicApiUrl: string,
  bookStorageDir: string
): Promise<string | null> {
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
    return readSavedBookMarkdown(projectId, bookStorageDir);
  }

  const generatedPages = project.pages.filter((page) => page.markdown.trim().length > 0);
  if (generatedPages.length === 0) {
    return readSavedBookMarkdown(projectId, bookStorageDir);
  }

  const strategy = strategyForMediaSettings(project.mediaSettings);
  const cover = project.images.find((image) => image.type === "COVER");
  const markdown = strategy.compileMarkdown({
    plan: project.currentPlan.planningPackage as never,
    category: project.category,
    language: project.language,
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
    researchSources: project.research.map((source) => ({
      title: source.title,
      url: source.url ?? undefined,
      summary: source.summary
    })),
    includeSources: includeSourcesPreference(project.mediaSettings),
    chapterHeadingStyle: chapterHeadingStylePreference(project.mediaSettings),
    chapterHeadingLabel: chapterHeadingLabelPreference(project.mediaSettings)
  });
  assertBookLikeMarkdown(markdown);
  return markdown;
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
