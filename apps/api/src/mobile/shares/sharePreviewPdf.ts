import { objectKey, objectStore } from "@book-maker/storage";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, type PDFContext } from "pdf-lib";

/**
 * The preview a share serves is a real PDF of the first `sheets` sheets and
 * nothing else — sliced here, server-side, so no byte of a later page ever
 * leaves the server through a preview link.
 *
 * `copyPages` deep-copies every object a page reaches, and `save` writes every
 * object in the document's context whether or not anything references it. So
 * a later page leaks through anything a kept page *points at*: an internal
 * link whose destination is a page reference, an article bead, an additional
 * action. Those are cut from the kept pages of the *source* before the copy,
 * which is the only point where cutting them keeps their targets out of the
 * output. Only external URI links survive (a Sources entry is still a link);
 * every other annotation goes, including internal links by name, whose
 * destinations do not exist in the slice anyway.
 */
export async function slicePdfToFirstSheets(bytes: Uint8Array, sheets: number, options: { title?: string } = {}): Promise<Buffer> {
  const source = await PDFDocument.load(bytes, { updateMetadata: false });
  const keep = Math.min(Math.max(1, Math.floor(sheets)), source.getPageCount());
  const indices = Array.from({ length: keep }, (_, index) => index);
  for (const index of indices) {
    containPage(source.getPage(index).node, source.context);
  }
  const target = await PDFDocument.create({ updateMetadata: false });
  for (const page of await target.copyPages(source, indices)) {
    target.addPage(page);
  }
  // The book's own title: the compiled file's is Chrome's temporary filename.
  if (options.title) {
    target.setTitle(options.title);
  }
  return Buffer.from(await target.save({ useObjectStreams: true }));
}

/** How many sheets a PDF has, for a book whose page map does not describe its bytes. */
export async function pdfSheetCount(bytes: Uint8Array): Promise<number> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  return document.getPageCount();
}

/** Page keys that can reach other pages: article beads, additional actions. */
const PAGE_KEYS_THAT_REACH_OUT = ["B", "AA"];

function containPage(page: PDFDict, context: PDFContext): void {
  for (const key of PAGE_KEYS_THAT_REACH_OUT) {
    page.delete(PDFName.of(key));
  }
  const annots = page.lookup(PDFName.of("Annots"));
  if (!(annots instanceof PDFArray)) {
    page.delete(PDFName.of("Annots"));
    return;
  }
  const kept = annots.asArray().filter((entry) => {
    const annotation = entry instanceof PDFRef ? context.lookup(entry) : entry;
    return annotation instanceof PDFDict && isExternalLink(annotation);
  });
  if (kept.length === 0) {
    page.delete(PDFName.of("Annots"));
    return;
  }
  for (const entry of kept) {
    const annotation = (entry instanceof PDFRef ? context.lookup(entry) : entry) as PDFDict;
    // `/P` names the page an annotation sits on; nothing a viewer needs, and
    // one more way to point somewhere else.
    annotation.delete(PDFName.of("P"));
    annotation.delete(PDFName.of("Popup"));
    annotation.delete(PDFName.of("Parent"));
  }
  page.set(PDFName.of("Annots"), context.obj(kept));
}

function isExternalLink(annotation: PDFDict): boolean {
  if (annotation.get(PDFName.of("Subtype")) !== PDFName.of("Link") || annotation.has(PDFName.of("Dest"))) {
    return false;
  }
  const action = annotation.lookup(PDFName.of("A"));
  if (!(action instanceof PDFDict)) {
    return false;
  }
  // A chained `/Next` action could go anywhere.
  return action.get(PDFName.of("S")) === PDFName.of("URI") && !action.has(PDFName.of("Next"));
}

/**
 * Where a preview slice is cached: under the book's own `books/<projectId>/`
 * prefix, so deleting the book deletes its slices, and keyed by the digest of
 * the compile it was cut from and the sheets it holds — a new compile is a new
 * key, never a stale hit.
 */
export function sharePreviewPrefix(projectId: string): string {
  return `${objectKey("books", projectId, "share-previews")}/`;
}

export function sharePreviewKey(projectId: string, pdfDigest: string, visiblePages: number, sheets: number): string {
  return objectKey("books", projectId, "share-previews", `${pdfDigest}-p${visiblePages}-s${sheets}.pdf`);
}

export async function readCachedSharePreview(key: string): Promise<Buffer | null> {
  return objectStore().get(key);
}

/**
 * Stores a fresh slice and retires every other slice of this book. Old slices
 * are superseded compiles or page counts, and nothing else sweeps this prefix;
 * a slice another request still wants is simply cut again.
 */
export async function storeSharePreview(projectId: string, key: string, bytes: Buffer): Promise<void> {
  await objectStore().put(key, bytes, { contentType: "application/pdf" });
  try {
    const stale = (await objectStore().list(sharePreviewPrefix(projectId))).filter((entry) => entry.key !== key);
    await Promise.all(stale.map((entry) => objectStore().delete(entry.key)));
  } catch {
    // Housekeeping; the slice this request needs is already stored.
  }
}
