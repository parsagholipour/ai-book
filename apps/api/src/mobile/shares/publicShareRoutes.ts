import { loadConfig, publishedExportFilename } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { objectKey, objectStore } from "@book-maker/storage";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { z } from "zod";
import { InMemoryRateLimiter, rateLimitKey, sendRateLimitError, type RateLimitConfig } from "../../rateLimit.js";
import { sanitizeDownloadFilename } from "../../routes/projectExports.js";
import { ensureExportRepairQueued } from "../exportRepair.js";
import { mobileAssetFilenameFromPath } from "../projectArtifactSerializers.js";
import {
  loadFullSharedPdf,
  loadPreviewSharedPdf,
  loadSharedPdfLayout,
  shareBookKind,
  shareProjectSelect,
  type ShareProject,
  type SharedPdf
} from "./shareBook.js";
import { previewSheetRange } from "./sharePageRange.js";
import { renderNoLongerSharedPage, renderShareNotFoundPage, renderSharePage } from "./sharePage.js";
import { loadShareBySlug, shareServesCurrentText, wasShareSlugIssued, type BookShareRecord } from "./shareRecords.js";
import type { ShareRescreener } from "./shareRescreen.js";
import { isShareSlug } from "./shareSlug.js";

/**
 * The public share surface: `/s/<slug>` (the page), `/s/<slug>/book.pdf`,
 * `/s/<slug>/cover.jpg`, `POST /s/<slug>/report`, and the page's own static
 * files under `/s/_/`.
 *
 * **It lives outside `/api/` on purpose, and outside the auth surface by
 * construction.** `shouldProtectPath` (`auth.ts`) guards `/api/`, `/docs` and
 * the two asset prefixes, so nothing here ever sees a cookie check or a bearer;
 * `allowsMobileBearer` and `isOperatorOnlyPath` are untouched, and
 * `publicShareRoutes.test.ts` pins both halves. What a stranger can reach is
 * decided here, by the share row: an ACTIVE share serves its book (a preview
 * serves only the preview slice), and anything else serves a 410 with no bytes.
 *
 * **And only text screened at the book's current revision.** A live share whose
 * book changed since its last screen (`shareServesCurrentText`) is answered as
 * a book being updated: the page names neither the title nor the author and
 * shows no viewer, the PDF is a 503, the cover is the generic image — and the
 * request asks the rescreener for a screen (`shareRescreen.ts`), which public
 * traffic can start at most once per share and revision.
 *
 * **Production only proxies what Nginx names.** `deploy/nginx.conf` sends
 * `/api`, `/docs`, the asset prefixes and `/s/` to this process and serves the
 * operator SPA for every other path, so a new public prefix that is not added
 * there works under `pnpm dev` and 404s — or renders the console — in
 * production. `server.ts`'s SPA fallback likewise answers 404 under `/s/`
 * rather than the console's `index.html`.
 *
 * Every response says `noindex` twice (header and meta), and share bytes are
 * cached for at most five minutes, because a revoke has to take effect quickly.
 * A view is counted when the **PDF** is fetched, never the HTML: link-preview
 * crawlers fetch only the page, so this keeps them out without a user-agent
 * list.
 */

type PublicShareRouteOptions = {
  reportRateLimit?: Partial<RateLimitConfig>;
  pdfRateLimit?: Partial<RateLimitConfig>;
  /** Asked for a screen when a stale share is reached; without one, the background sweep is the only door. */
  rescreener?: Pick<ShareRescreener, "requestFromPublic">;
};

/** What a stale share's page says in place of the book's own title and author, which no screen has read yet. */
const UPDATING_TITLE = "A book on Tomeza";
const ANONYMOUS_BYLINE = "A Tomeza author";

const ROBOTS = "noindex, nofollow";
const SHARE_BYTES_CACHE = "public, max-age=300";
const SHARE_PAGE_CACHE = "public, max-age=60";
/**
 * The page runs only its own script and the vendored pdf.js, reads only its
 * own origin, and may not be framed. `blob:` covers pdf.js's rendering paths.
 */
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join("; ");

const reportBodySchema = z
  .object({
    reason: z.enum([
      "offensive",
      "hate_or_harassment",
      "sexual_content",
      "violence_or_self_harm",
      "child_safety",
      "deceptive_or_misleading",
      "privacy_or_copyright",
      "other"
    ]),
    comment: z.string().trim().max(1000).optional()
  })
  .strict();

const slugParams = z.object({ slug: z.string().max(64) });

export const publicShareRoutes: FastifyPluginAsync<PublicShareRouteOptions> = async (fastify, options) => {
  const appConfig = loadConfig();
  const reportLimiter = new InMemoryRateLimiter({ maxAttempts: 5, windowMs: 60 * 60 * 1000, ...options.reportRateLimit });
  const pdfLimiter = new InMemoryRateLimiter({ maxAttempts: 120, windowMs: 10 * 60 * 1000, ...options.pdfRateLimit });

  fastify.addHook("onSend", async (request, reply, payload) => {
    // The matched route, not `request.url`: `/%73/<slug>` runs the same page
    // and has to carry the same noindex and nosniff headers.
    if (request.routeOptions.url?.startsWith("/s/")) {
      reply.header("X-Robots-Tag", ROBOTS);
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Referrer-Policy", "no-referrer");
    }
    return payload;
  });

  fastify.get("/s/_/:file", async (request, reply) => sendStaticAsset(request, reply));
  fastify.get("/s/_/pdfjs/:file", async (request, reply) => sendStaticAsset(request, reply, "pdfjs"));

  /** True when the share may show its book; otherwise asks for a screen and answers as being updated. */
  const servesCurrentText = (share: BookShareRecord, project: ShareProject, request: FastifyRequest): boolean => {
    if (shareServesCurrentText(share, project)) {
      return true;
    }
    try {
      options.rescreener?.requestFromPublic(share, project);
    } catch (error) {
      request.log.warn({ err: error, shareId: share.id }, "share re-screen could not be requested");
    }
    return false;
  };

  fastify.get("/s/:slug", async (request, reply) => {
    const resolved = await resolveShare(request, reply);
    if (!resolved) {
      return;
    }
    const { share, project } = resolved;
    const current = servesCurrentText(share, project, request);
    const available = await objectStore().head(objectKey("books", project.id, publishedExportFilename("pdf")));
    if (!available) {
      await queueRepair(project, request);
    }
    const servable = current && Boolean(available);
    let visiblePages: number | null = null;
    let readingPages: number | null = null;
    if (share.mode === "PREVIEW" && servable) {
      const loaded = await loadSharedPdfLayout(project).catch(() => null);
      if (loaded) {
        const range = previewSheetRange(loaded.layout, share.previewPages ?? 1);
        visiblePages = range.visiblePages;
        readingPages = range.readingPages;
      }
    }
    reply.header("Cache-Control", SHARE_PAGE_CACHE);
    reply.header("Content-Security-Policy", PAGE_CSP);
    reply.type("text/html; charset=utf-8");
    // A stale share shows nothing of the book's own words: the title,
    // subtitle and author name are text of the revision no screen has read.
    // The note is the author's, moderated on its own, and unchanged by an edit.
    return renderSharePage({
      slug: share.slug,
      publicApiUrl: appConfig.PUBLIC_API_URL,
      title: current ? project.title : UPDATING_TITLE,
      subtitle: current ? project.subtitle : null,
      byline: current && share.showAuthorName && project.authorName?.trim() ? project.authorName.trim() : ANONYMOUS_BYLINE,
      kind: shareBookKind(project.mediaSettings),
      caption: share.captionStatus === "ALLOWED" ? share.caption : null,
      mode: share.mode === "FULL" ? "full" : "preview",
      visiblePages,
      readingPages,
      available: servable
    });
  });

  fastify.get("/s/:slug/book.pdf", async (request, reply) => {
    const limit = pdfLimiter.hit(rateLimitKey(request, "share-pdf"));
    if (!limit.allowed) {
      return sendRateLimitError(reply, limit.retryAfterSeconds);
    }
    const resolved = await resolveShare(request, reply, { bytes: true });
    if (!resolved) {
      return;
    }
    const { share, project } = resolved;
    if (!servesCurrentText(share, project, request)) {
      return reply.code(503).header("Retry-After", "60").type("text/plain; charset=utf-8").send("This book is being updated.");
    }
    let pdf: SharedPdf | null;
    try {
      pdf = share.mode === "FULL" ? await loadFullSharedPdf(project.id) : await loadPreviewSharedPdf(project, share.previewPages ?? 1);
    } catch (error) {
      request.log.error({ err: error, shareId: share.id }, "share PDF could not be prepared");
      return reply.code(503).header("Retry-After", "60").type("text/plain; charset=utf-8").send("This book can't be opened right now.");
    }
    if (!pdf) {
      await queueRepair(project, request);
      return reply.code(503).header("Retry-After", "60").type("text/plain; charset=utf-8").send("This book is being updated.");
    }
    if (request.method === "GET") {
      await prisma.bookShare
        .updateMany({ where: { id: share.id, status: "ACTIVE" }, data: { viewCount: { increment: 1 } } })
        .catch((error: unknown) => request.log.warn({ err: error, shareId: share.id }, "share view count failed"));
    }
    const suffix = share.mode === "PREVIEW" ? " (preview)" : "";
    reply.header("Cache-Control", SHARE_BYTES_CACHE);
    reply.header("Content-Disposition", `inline; filename="${sanitizeDownloadFilename(`${project.title}${suffix}`)}.pdf"`);
    reply.header("Content-Length", String(pdf.bytes.length));
    return reply.type("application/pdf").send(pdf.bytes);
  });

  fastify.get("/s/:slug/cover.jpg", async (request, reply) => {
    const resolved = await resolveShare(request, reply, { bytes: true });
    if (!resolved) {
      return;
    }
    // A cover typesets the title, and an edit can redraw it: a stale share's
    // link preview gets the generic image until the book is screened again.
    if (!shareServesCurrentText(resolved.share, resolved.project)) {
      reply.header("Cache-Control", SHARE_PAGE_CACHE);
      return reply.type("image/jpeg").send(await genericShareImage());
    }
    const cover = await coverJpeg(resolved.project.id).catch((error: unknown) => {
      request.log.warn({ err: error, projectId: resolved.project.id }, "share cover could not be read");
      return null;
    });
    reply.header("Cache-Control", SHARE_BYTES_CACHE);
    return reply.type("image/jpeg").send(cover ?? (await genericShareImage()));
  });

  fastify.post("/s/:slug/report", async (request, reply) => {
    const limit = reportLimiter.hit(rateLimitKey(request, "share-report"));
    if (!limit.allowed) {
      return sendRateLimitError(reply, limit.retryAfterSeconds);
    }
    const resolved = await resolveShare(request, reply, { bytes: true });
    if (!resolved) {
      return;
    }
    const parsed = reportBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Choose a report reason." } });
    }
    const { share, project } = resolved;
    const comment = parsed.data.comment?.replace(/\s+/g, " ").trim();
    await prisma.moderationReport.create({
      data: {
        reporterUserId: null,
        projectId: project.id,
        bookShareId: share.id,
        targetType: "BOOK_SHARE",
        reason: parsed.data.reason.toUpperCase() as Uppercase<typeof parsed.data.reason>,
        comment: comment || null,
        targetSnapshot: {
          kind: "public_report",
          slug: share.slug,
          title: project.title,
          mode: share.mode,
          caption: share.caption,
          captionStatus: share.captionStatus
        }
      }
    });
    return reply.code(201).send({ reported: true });
  });
};

/**
 * The live share and its book, or an answer already sent: 404 for a slug that
 * was never issued, 410 — with no book bytes and no book details — for one that
 * was revoked, taken down, retired by a re-share, or whose book is gone.
 */
async function resolveShare(
  request: FastifyRequest,
  reply: FastifyReply,
  options: { bytes?: boolean } = {}
): Promise<{ share: BookShareRecord; project: ShareProject } | null> {
  const { slug } = slugParams.parse(request.params);
  const gone = () => {
    reply.header("Cache-Control", SHARE_PAGE_CACHE);
    if (options.bytes) {
      return reply.code(410).type("text/plain; charset=utf-8").send("This book is no longer shared.");
    }
    reply.header("Content-Security-Policy", PAGE_CSP);
    return reply.code(410).type("text/html; charset=utf-8").send(renderNoLongerSharedPage());
  };
  const notFound = () => {
    if (options.bytes) {
      return reply.code(404).type("text/plain; charset=utf-8").send("Not found.");
    }
    reply.header("Content-Security-Policy", PAGE_CSP);
    return reply.code(404).type("text/html; charset=utf-8").send(renderShareNotFoundPage());
  };
  if (!isShareSlug(slug)) {
    notFound();
    return null;
  }
  const share = await loadShareBySlug(slug);
  if (!share) {
    if (await wasShareSlugIssued(slug)) {
      gone();
    } else {
      notFound();
    }
    return null;
  }
  if (share.status !== "ACTIVE") {
    gone();
    return null;
  }
  const project = (await prisma.project.findUnique({
    where: { id: share.projectId },
    select: shareProjectSelect
  })) as ShareProject | null;
  if (!project) {
    gone();
    return null;
  }
  return { share, project };
}

/** A shared book whose PDF vanished heals the way the app's status watch heals it. */
async function queueRepair(project: ShareProject, request: FastifyRequest): Promise<void> {
  try {
    await ensureExportRepairQueued(project, "pdf", loadConfig());
  } catch (error) {
    request.log.warn({ err: error, projectId: project.id }, "share export repair could not be queued");
  }
}

/** The cover as a JPEG a link preview can show, at most 1200 px on its long side. */
async function coverJpeg(projectId: string): Promise<Buffer | null> {
  const cover = await prisma.imageAsset.findFirst({
    where: { projectId, type: "COVER" },
    orderBy: { createdAt: "desc" },
    select: { path: true }
  });
  const filename = cover ? mobileAssetFilenameFromPath(cover.path, projectId) : null;
  if (!filename) {
    return null;
  }
  const bytes = await objectStore().get(objectKey("images", projectId, filename));
  if (!bytes) {
    return null;
  }
  return sharp(bytes).rotate().resize(1200, 1200, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 82 }).toBuffer();
}

let genericImage: Promise<Buffer> | null = null;

/** The one image every coverless book shares: the Tomeza mark on the brand teal. */
export function genericShareImage(): Promise<Buffer> {
  genericImage ??= sharp(
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#0F6B5C"/>
  <g transform="translate(470 110) scale(2)" fill="#ffffff">
    <path fill-rule="evenodd" clip-rule="evenodd" d="M33.8 13H96.2C109.2 13 119.6 23.4 119.6 36.4V79.3C119.6 94.9 109.2 105.3 93.6 105.3H55.9L29.9 122.2V104C18.2 101.4 10.4 92.3 10.4 79.3V36.4C10.4 23.4 20.8 13 33.8 13ZM31.2 41.6C45.5 40.3 54.6 44.2 61.1 50.7V84.5C52 75.4 41.6 72.8 31.2 74.1V41.6ZM68.9 50.7C75.4 44.2 84.5 40.3 98.8 41.6V74.1C88.4 72.8 78 75.4 68.9 84.5V50.7Z"/>
  </g>
  <text x="600" y="520" font-family="sans-serif" font-size="64" font-weight="700" fill="#ffffff" text-anchor="middle">Tomeza</text>
</svg>`)
  )
    .jpeg({ quality: 88 })
    .toBuffer();
  return genericImage;
}

const require = createRequire(import.meta.url);
const PUBLIC_DIR = fileURLToPath(new URL("../../../public/share/", import.meta.url));

/**
 * The page's own files and the vendored pdf.js (legacy build, for older phone
 * browsers). A `Map`, never an object literal read by the URL's own segment:
 * `/s/_/constructor`, `/s/_/__proto__` and `/s/_/toString` found
 * `Object.prototype`'s members there and answered 500 (pre-launch review,
 * 2026-10-13).
 */
const STATIC_ASSETS = new Map<string, { path: () => string; type: string }>([
  ["share.css", { path: () => `${PUBLIC_DIR}share.css`, type: "text/css; charset=utf-8" }],
  ["share.js", { path: () => `${PUBLIC_DIR}share.js`, type: "text/javascript; charset=utf-8" }],
  ["icon.svg", { path: () => `${PUBLIC_DIR}icon.svg`, type: "image/svg+xml" }],
  ["pdfjs/pdf.min.mjs", { path: () => require.resolve("pdfjs-dist/legacy/build/pdf.min.mjs"), type: "text/javascript; charset=utf-8" }],
  [
    "pdfjs/pdf.worker.min.mjs",
    { path: () => require.resolve("pdfjs-dist/legacy/build/pdf.worker.min.mjs"), type: "text/javascript; charset=utf-8" }
  ]
]);
const staticCache = new Map<string, Promise<Buffer>>();

async function sendStaticAsset(request: FastifyRequest, reply: FastifyReply, folder?: string) {
  const { file } = z.object({ file: z.string().max(80) }).parse(request.params);
  const name = folder ? `${folder}/${file}` : file;
  const asset = STATIC_ASSETS.get(name);
  if (!asset) {
    return reply.code(404).type("text/plain; charset=utf-8").send("Not found.");
  }
  let bytes = staticCache.get(name);
  if (!bytes) {
    bytes = readFile(asset.path());
    staticCache.set(name, bytes);
    bytes.catch(() => staticCache.delete(name));
  }
  reply.header("Cache-Control", "public, max-age=3600");
  return reply.type(asset.type).send(await bytes);
}
