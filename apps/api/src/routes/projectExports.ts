import {
  assertBookLikeMarkdown,
  AUTO_BOOK_GENERATION_STRATEGY_ID,
  exportContentDigest,
  generateBookEpub,
  getBookGenerationStrategy,
  chapterHeadingLabelPreference,
  chapterHeadingStylePreference,
  includeSourcesPreference,
  mediaSettingsSchema,
  pendingExportTempPath,
  readPublishedExport,
  removeExportProvenance,
  resolvePublicImageUrl,
  writeExportProvenance,
  type AppConfig,
  type ExportArtifact
} from "@book-maker/core";
import { Prisma, prisma, researchCitationsForExport, type ProjectStatus } from "@book-maker/db";
import { access, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireOperatorActor, type ProjectActor } from "../requestAuth.js";

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
  /** The manuscript this request was answered for; see `publishRebuiltExport`. */
  contentRevision: number;
  /** What the book was doing when the request arrived; see `projectExportIsMidWrite`. */
  status: ProjectStatus;
};

export type ProjectEpubExportSource = {
  title: string;
  /** Becomes the EPUB's `dc:creator`, which is what a reading system files the book under. */
  authorName: string | null;
  language: string;
  currentPlanId: string | null;
  contentRevision: number;
  status: ProjectStatus;
};

export type ProjectExportFormat = "pdf" | "epub";

export type ProjectExportProvenanceSource = {
  contentRevision: number;
  status: ProjectStatus;
};

export type ReadableProjectExport = {
  byteSize: number;
  modifiedAt: Date;
};

/**
 * Cheaply verifies the exact promise made by export availability: the path is
 * a readable regular file. Status is serialized on every poll/SSE tick, so it
 * must not read and hash an entire book just to answer that question. Opening
 * the file, fstat'ing the descriptor and sampling one byte for a non-empty file
 * catches directories, permissions failures and torn/disappearing paths while
 * keeping work constant regardless of book size.
 */
export async function probeReadableProjectExport(
  appConfig: Pick<AppConfig, "BOOK_STORAGE_DIR">,
  projectId: string,
  format: ProjectExportFormat
): Promise<ReadableProjectExport | null> {
  const filename = format === "pdf" ? BOOK_PDF_FILENAME : BOOK_EPUB_FILENAME;
  return probeReadableExportPath(join(appConfig.BOOK_STORAGE_DIR, projectId, filename));
}

async function probeReadableExportPath(path: string): Promise<ReadableProjectExport | null> {
  let file: Awaited<ReturnType<typeof open>> | null = null;
  try {
    file = await open(path, "r");
    const stats = await file.stat();
    if (!stats.isFile()) {
      return null;
    }
    if (stats.size > 0) {
      const sample = Buffer.allocUnsafe(1);
      const { bytesRead } = await file.read(sample, 0, 1, 0);
      if (bytesRead !== 1) {
        return null;
      }
    }
    return { byteSize: stats.size, modifiedAt: stats.mtime };
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

/**
 * Size and mtime come back alongside availability because the mobile reader
 * caches the downloaded PDF on the device: together they identify the exact
 * file on disk, so a cached copy can be reused without re-downloading and a
 * recompiled book is detected as stale.
 *
 * It asks the config for one thing, and says so: `ensureExportRepairQueued`
 * re-asks this question from inside its decision transaction, where the whole
 * config is neither available nor needed.
 */
export async function projectExportAvailability(
  appConfig: Pick<AppConfig, "BOOK_STORAGE_DIR">,
  projectId: string,
  format: ProjectExportFormat
): Promise<{ available: boolean; byteSize: number | null; modifiedAt: Date | null }> {
  const readable = await probeReadableProjectExport(appConfig, projectId, format);
  if (!readable) {
    return { available: false, byteSize: null, modifiedAt: null };
  }
  return { available: true, ...readable };
}

/**
 * The lazy rebuilds in flight, keyed `projectId:format:contentRevision`.
 *
 * User edits delete the compiled files first (`invalidateCompiledProjectExports`)
 * and queue the recompile immediately after, so this path is reachable in that
 * window — and a reader refreshing, or several devices on one account, would
 * otherwise fork one full render per request against the same missing file.
 * They now share one.
 *
 * The revision is part of the key because sharing is only ever right between
 * requests asking for the *same* book: an edit bumps `contentRevision` and
 * deletes the compiled files, so a request arriving a moment later found the
 * file missing for a new reason, and joining the render already in flight would
 * have answered it with the manuscript from before the edit.
 *
 * The status is not, because a joiner inherits the publication decision of the
 * render it joined and that inheritance can only be conservative: the claim in
 * `publishRebuiltExport` still re-checks the status at the end, so a render
 * that becomes eligible mid-flight publishes nothing while one that stops being
 * eligible is refused there.
 */
const lazyRebuilds = new Map<string, Promise<Buffer | null>>();

function rebuildExportOnce(key: string, build: () => Promise<Buffer | null>): Promise<Buffer | null> {
  const inFlight = lazyRebuilds.get(key);
  if (inFlight) {
    return inFlight;
  }
  const started = build().finally(() => {
    lazyRebuilds.delete(key);
  });
  lazyRebuilds.set(key, started);
  return started;
}

/**
 * The statuses a lazy rebuild may publish over.
 *
 * The same two the worker's detached compiles use, and refused for the same
 * reason: GENERATING and EDITING mean somebody is writing the book right now,
 * and both can still hold the revision this render matched — `applyBookEdit`
 * takes the project EDITING before it rewrites a page and bumps the revision
 * only once every page is saved, so a render compiled in that window is a
 * half-applied book that would claim cleanly on the revision alone.
 */
const PUBLISHABLE_EXPORT_STATUSES = ["COMPLETE", "REVIEW_REQUIRED"] as const;

function isPublishableExportStatus(status: ProjectStatus): boolean {
  return (PUBLISHABLE_EXPORT_STATUSES as readonly ProjectStatus[]).includes(status);
}

/**
 * The statuses in which the manuscript is being written *right now*.
 *
 * A render begun in one of them compiles the pages that exist at that instant,
 * which is a fragment of a book rather than a book — and the claim above cannot
 * catch it, because it re-checks the status at the *end* of the render, by
 * which time the writer has finished and left the project COMPLETE. Initial
 * generation never bumps `contentRevision` either, so a partial render started
 * during GENERATING matched both halves of the claim against the very compile
 * that had just published the finished book, and replaced it — permanently,
 * since nothing rebuilds an export whose file is present and whose revision
 * never moves again.
 *
 * Refusing the whole request rather than only its publication is deliberate:
 * serving a truncated PDF as the book is the same lie as storing one. Neither
 * client asks for it — the console only links to the download once the project
 * is COMPLETE or the file is already on disk, and the mobile routes never
 * render at all — and the answer they both understand is "not ready yet".
 *
 * A project that is merely *unfinished* (DRAFT, FAILED, a plan awaiting
 * approval) is not in this list: its pages are static, so a render of them is a
 * whole and honest download of what exists. It still publishes nothing, because
 * the claim's status check refuses everything outside
 * `PUBLISHABLE_EXPORT_STATUSES`.
 */
const MID_WRITE_PROJECT_STATUSES = ["GENERATING", "EDITING"] as const;

function projectExportIsMidWrite(status: ProjectStatus): boolean {
  return (MID_WRITE_PROJECT_STATUSES as readonly ProjectStatus[]).includes(status);
}

/** What a mid-write download is told, in place of a fragment of the book. */
const EXPORT_MID_WRITE_MESSAGE = "The book is still being written. The download will be ready when it finishes.";

/** Matches the worker's publication transaction: an outage bound, not a budget. */
const PUBLICATION_TRANSACTION_TIMEOUT_MS = 30_000;
const PUBLICATION_TRANSACTION_MAX_WAIT_MS = 10_000;

/**
 * Moves a finished render onto the downloadable filename, if it is still the
 * book. The worker's `publishCompiledExports` in reverse-image: same claim,
 * one file, and no status write at all.
 *
 * A lazy rebuild takes minutes of Chromium, and it runs against a project that
 * is COMPLETE — which is exactly the state in which the reader may edit. Writing
 * straight to `book.pdf` meant a render that started before an edit could land
 * *after* the worker's recompile published, leaving the book sitting finished
 * with its pre-edit PDF until some later revision bump happened to rebuild it.
 * So the render goes to a scratch name beside the real one and only moves once
 * a compare-and-set says the manuscript has not moved.
 *
 * The claim and the rename are one transaction because the claim alone can go
 * stale between deciding to publish and publishing: the no-op write takes the
 * project row's lock, so an edit's own bump — and any compile racing this one —
 * waits behind the rename instead of interleaving with it.
 */
async function publishRebuiltExport(options: {
  projectId: string;
  projectDir: string;
  format: ProjectExportFormat;
  contentRevision: number;
  rendered: Buffer;
  pendingPath: string;
  publishedPath: string;
}): Promise<boolean> {
  // Hashed before the transaction, which is holding a lock every edit to this
  // book has to take — and from the buffer this render already produced, so it
  // costs no read. See `writeExportProvenance` for what the record is for.
  const digest = exportContentDigest(options.rendered);
  return prisma.$transaction(
    async (tx) => {
      const claimed = await tx.project.updateMany({
        where: {
          id: options.projectId,
          contentRevision: options.contentRevision,
          status: { in: [...PUBLISHABLE_EXPORT_STATUSES] }
        },
        // Deliberately changes nothing: this render rebuilds a file, not the
        // book, so it has no verdict to write. The write is here for the row
        // lock — an `updateMany` matching nothing would take none.
        data: { contentRevision: { increment: 0 } }
      });
      if (claimed.count !== 1) {
        return false;
      }
      // The worker uses this same row lock when it publishes. Revision and
      // status alone cannot distinguish its same-revision detached repair from
      // this lazy rebuild, so re-check the destination only after the lock is
      // ours. If the worker committed while Chromium was rendering, its exact
      // book.md-based artifact wins and this reconstructed render stands down.
      if (await probeReadableExportPath(options.publishedPath)) {
        return false;
      }
      // Retire the old file's record before replacing its bytes. If the new
      // sidecar write fails, the result is honestly `unknown` and the
      // download-time metadata repair below can heal it; leaving the old
      // record would produce a permanent mismatch indistinguishable from a
      // file being replaced outside the publisher protocol.
      await removeExportProvenance(options.projectDir, options.format);
      await rename(options.pendingPath, options.publishedPath);
      // After the rename, and never fatal: a file that is on disk and
      // downloadable must not be undone because the metadata beside it could
      // not be written. Bytes no record describes are answered as exactly that.
      try {
        await writeExportProvenance({
          projectDir: options.projectDir,
          format: options.format,
          revision: options.contentRevision,
          digest,
          byteSize: options.rendered.length
        });
      } catch (error) {
        console.error(`Failed to record export provenance for project ${options.projectId}:`, error);
      }
      return true;
    },
    { timeout: PUBLICATION_TRANSACTION_TIMEOUT_MS, maxWait: PUBLICATION_TRANSACTION_MAX_WAIT_MS }
  );
}

/**
 * Renders one export beside its destination and publishes it if it is still the
 * current book.
 *
 * The caller is answered either way — this is a plain-link download in the
 * operator console, where a 404 is a broken download — but a render that lost
 * the claim prefers whatever is on disk now, since that is the newer book and
 * this one is stale by definition.
 *
 * `publishable` is the status the project held when the render *began*. The
 * claim can only see the status at the end, and the two differ for exactly the
 * case that matters: a book finishes while this render is running. A render
 * that was never eligible answers its own request and nothing more.
 */
async function renderAndPublishExport(options: {
  appConfig: AppConfig;
  projectId: string;
  contentRevision: number;
  publishable: boolean;
  format: ProjectExportFormat;
  render: (outputPath: string) => Promise<Buffer>;
}): Promise<Buffer> {
  const { appConfig, projectId, format } = options;
  const projectDir = join(appConfig.BOOK_STORAGE_DIR, projectId);
  await mkdir(projectDir, { recursive: true });
  // Named per render, because two rebuilds of one project overlapping is the
  // whole case here: a shared scratch name would have them writing over each
  // other's half-rendered file. The name comes from the same builder the
  // worker's compile uses, so the worker's age-based sweep collects one of these
  // too when this process is killed before its `finally` runs — both processes
  // write into one storage volume, and the sweep is age-based rather than
  // ownership-based precisely so it can clean up after the other one.
  const pendingPath = pendingExportTempPath(projectDir, format);
  try {
    const rendered = await options.render(pendingPath);
    const published =
      options.publishable &&
      (await publishRebuiltExport({
        projectId,
        projectDir,
        format,
        contentRevision: options.contentRevision,
        rendered,
        pendingPath,
        publishedPath: join(projectDir, format === "pdf" ? BOOK_PDF_FILENAME : BOOK_EPUB_FILENAME)
      }));
    if (published) {
      return rendered;
    }
    // Lost the claim, or never held one: whatever is on disk now is the book
    // this render is not, so it is the better answer. Its own bytes are the
    // last resort — a stale download beats a broken link, and they are at
    // least a whole manuscript, because a request that arrives mid-write is
    // refused outright rather than rendered.
    return (await readProjectExportFile(appConfig, projectId, format)) ?? rendered;
  } finally {
    // A no-op once the rename above moved it.
    await rm(pendingPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Renders the missing export in this process, sharing one render per project,
 * format and manuscript revision. Returns `null` when there is no book to
 * compile.
 *
 * The render itself is bounded by the browser pool's watchdog, so a wedged
 * Chromium cannot pin a Fastify handler open indefinitely.
 */
export function rebuildProjectPdfExport(
  appConfig: AppConfig,
  projectId: string,
  project: ProjectPdfExportSource
): Promise<Buffer | null> {
  return rebuildExportOnce(`${projectId}:pdf:${project.contentRevision}`, async () => {
    if (!project.currentPlanId) {
      return null;
    }
    const markdown = await compileProjectMarkdown(projectId, appConfig.PUBLIC_API_URL, appConfig.BOOK_STORAGE_DIR);
    if (!markdown) {
      return null;
    }
    const strategy = strategyForMediaSettings(project.mediaSettings);
    return renderAndPublishExport({
      appConfig,
      projectId,
      contentRevision: project.contentRevision,
      publishable: isPublishableExportStatus(project.status),
      format: "pdf",
      render: (outputPath) =>
        strategy.generatePdf(markdown, {
          imageStorageDir: appConfig.IMAGE_STORAGE_DIR,
          publicApiUrl: appConfig.PUBLIC_API_URL,
          outputPath,
          language: project.language,
          // Scopes the renderer's file access to this book's own illustrations,
          // exactly as the worker's compile does.
          projectId
        })
    });
  });
}

export function rebuildProjectEpubExport(
  appConfig: AppConfig,
  projectId: string,
  project: ProjectEpubExportSource
): Promise<Buffer | null> {
  return rebuildExportOnce(`${projectId}:epub:${project.contentRevision}`, async () => {
    if (!project.currentPlanId) {
      return null;
    }
    const markdown = await compileProjectMarkdown(projectId, appConfig.PUBLIC_API_URL, appConfig.BOOK_STORAGE_DIR);
    if (!markdown) {
      return null;
    }
    return renderAndPublishExport({
      appConfig,
      projectId,
      contentRevision: project.contentRevision,
      publishable: isPublishableExportStatus(project.status),
      format: "epub",
      render: (outputPath) =>
        generateBookEpub(markdown, {
          title: project.title,
          ...(project.authorName ? { author: project.authorName } : {}),
          language: project.language,
          imageStorageDir: appConfig.IMAGE_STORAGE_DIR,
          publicApiUrl: appConfig.PUBLIC_API_URL,
          outputPath,
          // Scopes the illustrations this book may package to its own, exactly as
          // the worker's compile does.
          projectId
        })
    });
  });
}

/** The compiled file, or `null` when it is not on disk. */
export async function readProjectExportFile(
  appConfig: AppConfig,
  projectId: string,
  format: ProjectExportFormat
): Promise<Buffer | null> {
  const path = join(appConfig.BOOK_STORAGE_DIR, projectId, format === "pdf" ? BOOK_PDF_FILENAME : BOOK_EPUB_FILENAME);
  try {
    await access(path);
    return await readFile(path);
  } catch {
    return null;
  }
}

/**
 * The compiled file together with the compile that produced it.
 *
 * What the mobile download surface reads, because the app has to file the bytes
 * it receives under a revision and the availability descriptor it asked with
 * cannot say which one: every compile of a book is published over this same
 * path. The provenance is resolved from the bytes themselves rather than from
 * the project row — a row read after a file read describes whatever compile is
 * current *now*, which is the same mistake the client was making.
 */
export async function readProjectExportArtifact(
  appConfig: Pick<AppConfig, "BOOK_STORAGE_DIR">,
  projectId: string,
  format: ProjectExportFormat,
  source?: ProjectExportProvenanceSource
): Promise<ExportArtifact | null> {
  const projectDir = join(appConfig.BOOK_STORAGE_DIR, projectId);
  const artifact = await readPublishedExport(projectDir, format);
  if (
    !artifact ||
    artifact.provenance.state === "exact" ||
    !source ||
    !isPublishableExportStatus(source.status)
  ) {
    return artifact;
  }

  // A missing record has two normal causes: the export predates provenance, or
  // its publisher installed the book but could not install the sidecar. Repair
  // only the metadata, under the same row lock every publisher takes. Once the
  // lock is held, a second read is settled: a publisher that was between its
  // artifact and sidecar has committed, and no newer edit/publication can move
  // the row or files until this record has been installed.
  try {
    return await prisma.$transaction(
      async (tx) => {
        const claimed = await tx.project.updateMany({
          where: {
            id: projectId,
            contentRevision: source.contentRevision,
            status: { in: [...PUBLISHABLE_EXPORT_STATUSES] }
          },
          data: { contentRevision: { increment: 0 } }
        });
        if (claimed.count !== 1) {
          return artifact;
        }

        const settled = await readPublishedExport(projectDir, format);
        if (!settled || settled.provenance.state !== "unknown") {
          return settled;
        }
        // The claim proves the *row* is at this revision; it does not prove the
        // bytes are. A presentation preference bumps the revision without
        // deleting the compiled files, so when its recompile fails, the
        // restored COMPLETE row sits one revision ahead of the bytes on disk —
        // and stamping the row's revision onto them would label a book that
        // does not contain the change as exactly containing it, forever. A
        // compile that COMPLETED for this same revision is the missing proof:
        // one that completes while the row still holds its revision cannot
        // have stood down, so a publication really did put these bytes here.
        // Without it the file keeps its honest `unknown`, which the app treats
        // as a pre-provenance download.
        const publishedCompile = await tx.generationJob.findFirst({
          where: {
            projectId,
            type: "COMPILE_EXPORT",
            status: "COMPLETED",
            contentRevision: source.contentRevision
          },
          select: { id: true }
        });
        if (!publishedCompile) {
          return settled;
        }
        await writeExportProvenance({
          projectDir,
          format,
          revision: source.contentRevision,
          digest: settled.provenance.digest,
          byteSize: settled.bytes.length
        });
        return {
          bytes: settled.bytes,
          provenance: {
            state: "exact" as const,
            revision: source.contentRevision,
            digest: settled.provenance.digest
          }
        };
      },
      { timeout: PUBLICATION_TRANSACTION_TIMEOUT_MS, maxWait: PUBLICATION_TRANSACTION_MAX_WAIT_MS }
    );
  } catch (error) {
    // The bytes remain a valid downloadable book. Returning their honest
    // unknown/mismatch state lets the client retry safely, and a later request
    // gets another metadata-only healing attempt.
    console.error(`Failed to repair export provenance for project ${projectId}:`, error);
    return artifact;
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
  let pdf = await readProjectExportFile(appConfig, projectId, "pdf");
  if (!pdf) {
    if (projectExportIsMidWrite(project.status)) {
      return reply.code(409).send({ error: EXPORT_MID_WRITE_MESSAGE });
    }
    try {
      pdf = await rebuildProjectPdfExport(appConfig, projectId, project);
    } catch (error) {
      request.log.error({ err: error, projectId }, "PDF generation failed");
      return reply.code(500).send({ error: "PDF generation failed" });
    }
    if (!pdf) {
      return reply.code(404).send({ error: "Book not found" });
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
  let epub = await readProjectExportFile(appConfig, projectId, "epub");
  if (!epub) {
    if (projectExportIsMidWrite(project.status)) {
      return reply.code(409).send({ error: EXPORT_MID_WRITE_MESSAGE });
    }
    try {
      epub = await rebuildProjectEpubExport(appConfig, projectId, project);
    } catch (error) {
      request.log.error({ err: error, projectId }, "EPUB generation failed");
      return reply.code(500).send({ error: "EPUB generation failed" });
    }
    if (!epub) {
      return reply.code(404).send({ error: "Book not found" });
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

export function ownedProjectWhere(projectId: string, actor: ProjectActor): Prisma.ProjectWhereInput {
  return { id: projectId, userId: actor.userId };
}

const idParamsSchema = z.object({ id: z.string().min(1) });
const pdfExportQuerySchema = z.object({
  disposition: z.enum(["attachment", "inline"]).optional()
});

/**
 * The operator console's download surface for the compiled book.
 *
 * Every handler here takes an *operator* actor, not merely an owning one. These
 * routes render inline when a file is missing and they charge nothing: the
 * reader's export unlock lives on `/api/mobile/projects/:id/export/*`, which
 * never renders. Ownership alone let a mobile bearer take the same book down
 * the free path — and drive an unbounded Chromium render inside a Fastify
 * handler while it was there.
 */
export function registerProjectExportRoutes(fastify: FastifyInstance, appConfig: AppConfig): void {
  fastify.get("/api/projects/:id/book", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const actor = await requireOperatorActor(request, reply);
    if (!actor) {
      return;
    }
    const project = await prisma.project.findFirst({ where: ownedProjectWhere(id, actor), select: { id: true } });
    if (!project) {
      return reply.code(404).send({ error: "Book not found" });
    }
    const markdown = await compileProjectMarkdown(id, appConfig.PUBLIC_API_URL, appConfig.BOOK_STORAGE_DIR);
    if (!markdown) {
      return reply.code(404).send({ error: "Book not found" });
    }
    reply.type("text/markdown");
    return markdown;
  });

  fastify.get("/api/projects/:id/export/readme", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const actor = await requireOperatorActor(request, reply);
    if (!actor) {
      return;
    }
    const project = await prisma.project.findFirst({ where: ownedProjectWhere(id, actor), select: { title: true } });
    if (!project) {
      return reply.code(404).send({ error: "Book not found" });
    }
    const markdown = await compileProjectMarkdown(id, appConfig.PUBLIC_API_URL, appConfig.BOOK_STORAGE_DIR);
    if (!markdown) {
      return reply.code(404).send({ error: "Book not found" });
    }
    const filename = `${sanitizeDownloadFilename(project?.title ?? "book")}.md`;
    reply.header("Content-Disposition", `attachment; filename="${filename}"`);
    reply.type("text/markdown");
    return markdown;
  });

  fastify.get("/api/projects/:id/export/pdf/status", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const actor = await requireOperatorActor(request, reply);
    if (!actor) {
      return;
    }
    const project = await prisma.project.findFirst({ where: ownedProjectWhere(id, actor), select: { id: true } });
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    return projectExportAvailability(appConfig, id, "pdf");
  });

  fastify.get("/api/projects/:id/export/pdf", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const actor = await requireOperatorActor(request, reply);
    if (!actor) {
      return;
    }
    const { disposition = "attachment" } = pdfExportQuerySchema.parse(request.query);
    const project = await prisma.project.findFirst({
      where: ownedProjectWhere(id, actor),
      select: {
        title: true,
        language: true,
        status: true,
        currentPlanId: true,
        mediaSettings: true,
        contentRevision: true
      }
    });
    if (!project) {
      return reply.code(404).send({ error: "Book not found" });
    }
    if (project.status === "REVIEW_REQUIRED") {
      return reply.code(409).send({ error: "Fix the flagged manuscript issues before exporting." });
    }

    return sendProjectPdfExport({ request, reply, appConfig, projectId: id, project, disposition });
  });

  fastify.get("/api/projects/:id/export/epub/status", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const actor = await requireOperatorActor(request, reply);
    if (!actor) {
      return;
    }
    const project = await prisma.project.findFirst({ where: ownedProjectWhere(id, actor), select: { id: true } });
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    return projectExportAvailability(appConfig, id, "epub");
  });

  fastify.get("/api/projects/:id/export/epub", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const actor = await requireOperatorActor(request, reply);
    if (!actor) {
      return;
    }
    const project = await prisma.project.findFirst({
      where: ownedProjectWhere(id, actor),
      select: {
        title: true,
        authorName: true,
        language: true,
        status: true,
        currentPlanId: true,
        contentRevision: true
      }
    });
    if (!project) {
      return reply.code(404).send({ error: "Book not found" });
    }
    if (project.status === "REVIEW_REQUIRED") {
      return reply.code(409).send({ error: "Fix the flagged manuscript issues before exporting." });
    }

    return sendProjectEpubExport({ request, reply, appConfig, projectId: id, project });
  });
}
