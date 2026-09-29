import { optimizeImageForStorage } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { objectKey, objectStore } from "@book-maker/storage";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";

/**
 * Pictures an author adds to their own book.
 *
 * Stored beside the book's other illustrations, `images/<projectId>/`, so the
 * existing asset route serves them to the app under the owner's bearer and the
 * export renderers' project-scoped resolver prints them — and deleting the book
 * takes them with the rest of that prefix. The `upload-` prefix is what tells
 * them apart from pictures the product drew: an author's own photo must never
 * count as the free tier's illustrated book (`projectAlreadyIllustrated`).
 */

export const UPLOADED_IMAGE_PREFIX = "upload-";

/** A cover the author uploaded; never page markdown, so no illustration predicate reads it. */
export const UPLOADED_COVER_PREFIX = "cover-upload-";

const ACCEPTED_TYPES: Record<string, string> = {
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/png": "image/png",
  "image/webp": "image/webp",
  "image/heic": "image/heic",
  "image/heif": "image/heif"
};

const TYPE_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif"
};

/**
 * The upload's type, or null to refuse it. SVG is refused outright — it is a
 * document that can carry script and external references, and the optimizer
 * would store it verbatim — and so is anything this list does not name.
 */
export function manuscriptImageType(contentType: string | undefined, filename: string): string | null {
  const declared = contentType?.toLowerCase().split(";")[0]?.trim();
  if (declared === "image/svg+xml" || extname(filename).toLowerCase() === ".svg") {
    return null;
  }
  if (declared && ACCEPTED_TYPES[declared]) {
    return ACCEPTED_TYPES[declared]!;
  }
  if (declared && declared !== "application/octet-stream") {
    return null;
  }
  return TYPE_BY_EXTENSION[extname(filename).toLowerCase()] ?? null;
}

export type StoredManuscriptImage = { url: string; width: number; height: number };

/**
 * Re-encodes and stores one upload, or returns null when the bytes are not a
 * picture this server can read.
 *
 * Always re-encoded (`alwaysReencode`): that is what strips a phone photo's
 * EXIF and GPS, and it normalizes whatever arrived — HEIC included, where the
 * image library can decode it — into the JPEG every exporter prints. The
 * optimizer hands back the input untouched when it cannot decode it; storing
 * that would put unreadable bytes behind a URL the book prints, so an
 * un-optimized result is a refusal here.
 */
export async function storeManuscriptImage(
  projectId: string,
  bytes: Buffer,
  mimeType: string,
  prefix: string = UPLOADED_IMAGE_PREFIX
): Promise<(StoredManuscriptImage & { filename: string; mimeType: string; bytes: number }) | null> {
  const optimized = await optimizeImageForStorage({ bytes, mimeType, alwaysReencode: true });
  if (!optimized.optimized || !optimized.width || !optimized.height) {
    return null;
  }
  const filename = `${prefix}${randomUUID()}.${optimized.extension}`;
  await objectStore().put(objectKey("images", projectId, filename), optimized.bytes, {
    contentType: optimized.mimeType
  });
  return {
    url: `/assets/images/${projectId}/${filename}`,
    width: optimized.width,
    height: optimized.height,
    filename,
    mimeType: optimized.mimeType,
    bytes: optimized.bytes.length
  };
}

/**
 * Whether an earlier Studio illustration already made this book illustrated
 * for the free tier's count: a charged ILLUSTRATE assist that was not refunded
 * — still running, delivered, applied, or dismissed after it delivered. A
 * FAILED one, and one dismissed before it ran, were refunded, and the refund
 * returned their slot. Read by `projectAlreadyIllustrated`, so the chat's
 * `add_image` and the Studio's Illustrate claim one slot per book between them
 * even before a publish puts the picture on a page.
 */
export async function hasChargedStudioIllustration(projectId: string): Promise<boolean> {
  const rows = await prisma.manuscriptAssist.findMany({
    where: { projectId, kind: "ILLUSTRATE", creditsCharged: { gt: 0 }, status: { not: "FAILED" } },
    select: { status: true, result: true },
    take: 50
  });
  return rows.some((row) => row.status !== "DISMISSED" || (row.result !== null && row.result !== undefined));
}
