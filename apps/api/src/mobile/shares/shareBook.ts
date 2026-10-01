import {
  libraryCharactersFromMediaSettings,
  publishedExportFilename,
  readExportProvenanceRecord,
  readPublishedExport,
  studioSettingsFromMediaSettings
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { objectKey, objectStore } from "@book-maker/storage";
import { copyrightRestrictionsEnabled, type ContentRestrictionAssessment } from "../../contentRestrictions.js";
import { assessManuscriptText } from "../manuscript/manuscriptContentScreen.js";
import { previewSheetRange, sharedPdfLayout, type SharedPdfLayout } from "./sharePageRange.js";
import {
  pdfSheetCount,
  readCachedSharePreview,
  sharePreviewKey,
  slicePdfToFirstSheets,
  storeSharePreview
} from "./sharePreviewPdf.js";

/**
 * What a share needs to know about the book behind it — whether it can be
 * shared at all, what kind of book it is, whether it shows a real person's
 * likeness, whether its text passes the screen — and the bytes it serves.
 *
 * The share always follows the book's **current** published `book.pdf`; it is
 * never a snapshot. So every read here goes to the published export, and a
 * book whose PDF is momentarily missing (an Edit Mode save deletes it until the
 * recompile lands — `invalidateCompiledProjectExports`) answers "being
 * updated" rather than an older copy, because there is no older copy to serve.
 */

export const shareProjectSelect = {
  id: true,
  userId: true,
  title: true,
  subtitle: true,
  authorName: true,
  status: true,
  category: true,
  subcategory: true,
  targetPages: true,
  contentRevision: true,
  currentPlanId: true,
  mediaSettings: true,
  pdfPageMap: true
} as const;

export type ShareProject = {
  id: string;
  userId: string;
  title: string;
  subtitle: string | null;
  authorName: string | null;
  status: string;
  category: string;
  subcategory: string | null;
  targetPages: number;
  contentRevision: number;
  currentPlanId: string | null;
  mediaSettings: unknown;
  pdfPageMap: unknown;
};

/** A book that has never been compiled is not shareable, whatever the file store says. */
const UNSHAREABLE_STATUSES = new Set(["DRAFT", "PLANNING", "PLAN_READY"]);

export function pdfObjectKey(projectId: string): string {
  return objectKey("books", projectId, publishedExportFilename("pdf"));
}

export type ShareAvailability = "available" | "not_finished" | "being_updated";

/**
 * Whether the book has a published compile to share right now. A book that was
 * never finished is `not_finished`; a finished one whose PDF is absent this
 * moment (an edit's recompile is landing) is `being_updated`.
 */
export async function shareAvailability(project: Pick<ShareProject, "id" | "status">): Promise<ShareAvailability> {
  const head = await objectStore().head(pdfObjectKey(project.id));
  if (head) {
    return UNSHAREABLE_STATUSES.has(project.status) ? "not_finished" : "available";
  }
  return UNSHAREABLE_STATUSES.has(project.status) || project.status === "GENERATING" || project.status === "FAILED"
    ? "not_finished"
    : "being_updated";
}

/**
 * "Created with AI on Tomeza" or "Written on Tomeza". A book taken over into
 * the Studio started as a generated book, and an import is not a Studio book,
 * so both keep the AI line: the page should never claim a person wrote what
 * the generator did.
 */
export type ShareBookKind = "generated" | "written";

export function shareBookKind(mediaSettings: unknown): ShareBookKind {
  const studio = studioSettingsFromMediaSettings(mediaSettings);
  return studio && studio.origin !== "takeover" ? "written" : "generated";
}

/**
 * Whether the book's cast includes someone drawn from a real photograph.
 *
 * The cast is `mediaSettings.mobile.characters`, copies of library characters
 * that name the library row they were copied from. A row whose `photoKind` is
 * PHOTOGRAPH or UNKNOWN counts — UNKNOWN is treated as a photograph everywhere
 * (see the enum) — and so does a row with a photo that was never read. A row
 * deleted since the book was made cannot say, so a copy carrying a *generated*
 * portrait counts too: that portrait may have been drawn from a photo, and
 * this is a warning to confirm, never a ban.
 */
export async function bookShowsRealLikeness(userId: string, mediaSettings: unknown): Promise<boolean> {
  const cast = libraryCharactersFromMediaSettings(mediaSettings);
  if (cast.length === 0) {
    return false;
  }
  const rows = await prisma.libraryCharacter.findMany({
    where: { userId, id: { in: cast.map((character) => character.id) } },
    select: { id: true, photoKind: true, photoPath: true }
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return cast.some((character) => {
    const row = byId.get(character.id);
    if (!row) {
      return Boolean(character.portraitFile) && character.portraitSource !== "adopted_upload";
    }
    return row.photoKind === "PHOTOGRAPH" || row.photoKind === "UNKNOWN" || (row.photoKind === null && Boolean(row.photoPath));
  });
}

/**
 * The book text screen: the Studio's windowed preflight
 * (`manuscriptContentScreen.ts`), page by page, plus the title. It is the
 * cheap deterministic screen that already exists; nothing here classifies a
 * book with a model. Run at create and at every mode change.
 */
export async function screenSharedBookText(project: Pick<ShareProject, "id" | "title" | "subtitle">): Promise<ContentRestrictionAssessment> {
  const copyrightRestrictions = await copyrightRestrictionsEnabled();
  const heading = [project.title, project.subtitle ?? ""].join("\n").trim();
  const headingAssessment = assessManuscriptText(heading, copyrightRestrictions);
  if (!headingAssessment.allowed) {
    return headingAssessment;
  }
  const pages = await prisma.page.findMany({
    where: { projectId: project.id },
    orderBy: { index: "asc" },
    select: { title: true, markdown: true }
  });
  for (const page of pages) {
    const assessment = assessManuscriptText(`${page.title}\n${page.markdown}`, copyrightRestrictions);
    if (!assessment.allowed) {
      return assessment;
    }
  }
  return { allowed: true };
}

export type LoadedLayout = { layout: SharedPdfLayout; digest: string; bytes: Buffer | null };

/**
 * The layout of the published PDF. When the stored page map describes the
 * bytes the provenance record names, no byte of the PDF is read; otherwise the
 * file is loaded and its sheets counted, and the bytes come back for reuse.
 */
export async function loadSharedPdfLayout(project: Pick<ShareProject, "id" | "pdfPageMap">): Promise<LoadedLayout | null> {
  const record = await readExportProvenanceRecord(project.id, "pdf");
  if (record) {
    const fromMap = sharedPdfLayoutFromMapOnly(project.pdfPageMap, record.digest);
    if (fromMap) {
      return { layout: fromMap, digest: record.digest, bytes: null };
    }
  }
  const artifact = await readPublishedExport(project.id, "pdf");
  if (!artifact) {
    return null;
  }
  const digest = artifact.provenance.digest;
  const totalSheets = await pdfSheetCount(artifact.bytes);
  return {
    layout: sharedPdfLayout({ totalSheets, pdfDigest: digest, storedPageMap: project.pdfPageMap }),
    digest,
    bytes: artifact.bytes
  };
}

function sharedPdfLayoutFromMapOnly(storedPageMap: unknown, digest: string): SharedPdfLayout | null {
  const record = storedPageMap && typeof storedPageMap === "object" ? (storedPageMap as Record<string, unknown>) : null;
  const totalSheets = record?.totalPdfPages;
  if (typeof totalSheets !== "number" || !Number.isInteger(totalSheets) || totalSheets < 1) {
    return null;
  }
  const layout = sharedPdfLayout({ totalSheets, pdfDigest: digest, storedPageMap });
  // Only a measured map proves the sheet count without reading the file.
  return layout.measured ? layout : null;
}

export type SharedPdf = { bytes: Buffer; visiblePages: number | null; readingPages: number | null };

/** The whole published PDF, for a FULL share. */
export async function loadFullSharedPdf(projectId: string): Promise<SharedPdf | null> {
  const artifact = await readPublishedExport(projectId, "pdf");
  return artifact ? { bytes: artifact.bytes, visiblePages: null, readingPages: null } : null;
}

/**
 * The preview slice for `requestedPages`, cut from the current compile and
 * cached under its digest. The cap is applied again here: a later edit can
 * shrink the book under a preview that was legal when the author saved it.
 */
export async function loadPreviewSharedPdf(
  project: Pick<ShareProject, "id" | "pdfPageMap" | "title">,
  requestedPages: number
): Promise<SharedPdf | null> {
  const loaded = await loadSharedPdfLayout(project);
  if (!loaded) {
    return null;
  }
  const range = previewSheetRange(loaded.layout, requestedPages);
  const key = sharePreviewKey(project.id, loaded.digest, range.visiblePages, range.sheets);
  const cached = await readCachedSharePreview(key);
  if (cached) {
    return { bytes: cached, visiblePages: range.visiblePages, readingPages: range.readingPages };
  }
  let bytes = loaded.bytes;
  let sheets = range.sheets;
  let visiblePages = range.visiblePages;
  let readingPages = range.readingPages;
  let cacheKey = key;
  if (!bytes) {
    const artifact = await readPublishedExport(project.id, "pdf");
    if (!artifact) {
      return null;
    }
    bytes = artifact.bytes;
    if (artifact.provenance.digest !== loaded.digest) {
      // A compile landed between the record read and this one: cut what is
      // actually in hand, filed under its own digest.
      const layout = sharedPdfLayout({
        totalSheets: await pdfSheetCount(bytes),
        pdfDigest: artifact.provenance.digest,
        storedPageMap: project.pdfPageMap
      });
      const fresh = previewSheetRange(layout, requestedPages);
      ({ sheets, visiblePages, readingPages } = fresh);
      cacheKey = sharePreviewKey(project.id, artifact.provenance.digest, visiblePages, sheets);
    }
  }
  const slice = await slicePdfToFirstSheets(bytes, sheets, { title: project.title });
  await storeSharePreview(project.id, cacheKey, slice);
  return { bytes: slice, visiblePages, readingPages };
}
