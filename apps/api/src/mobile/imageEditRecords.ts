import { jsonRecord } from "./support.js";
import { storedImageRenderProvenance } from "@book-maker/core";

/**
 * What an image edit wrote down so it can be taken back.
 *
 * Undo (`manualEdits.ts`) and the changes card (`editChanges.ts`) both read
 * these off `BookEditOperation.classifier`, and both used to re-implement the
 * same field validation. One reader, so a shape change cannot make undo and the
 * card disagree about what an edit did.
 *
 * Both accept the **singular** `previousAsset` / `demotedAsset` keys written
 * before a remove could cover more than one picture. That is not politeness to
 * old code: an operation applied before this change is still on disk, still
 * inside its undo window, and still has a card to draw.
 */

export type PreviousImageAssetRecord = {
  id: string;
  pageId: string;
  path: string;
  prompt: string;
  imagePrompt?: string | null;
  /**
   * Set by a replacement: where the new artwork landed.
   *
   * It is also what *identifies* a replacement to undo, which matters for the
   * rows written before `generation` existed: a move or a remove never writes
   * one, so `afterPath` without `generation` is a replacement whose provenance
   * was never recorded, and undo clears the redraw's claim rather than leaving
   * it standing over the old bytes.
   */
  afterPath?: string;
  /**
   * Set by a replacement: the render provenance of the picture at `path`.
   *
   * A move or a remove never redraws, so its record has none — the row's
   * `metadata.copyrightRewrite` still describes the bytes it always did. A
   * replacement is the one edit that puts different pixels behind the same
   * `ImageAsset` row, so the record it left has to travel back with them:
   * restoring the old path over the new render's provenance would say a
   * protected name was removed from a picture drawn before anyone asked.
   */
  generation?: Record<string, unknown>;
  /** Set by a move: the page it went to, and that page's own prompt beforehand. */
  destPageId?: string;
  destImagePrompt?: string | null;
};

export type DemotedImageAssetRecord = {
  id: string;
  pageId: string;
  path: string;
  prompt: string;
  imagePrompt?: string | null;
};

/** The pictures an edit moved or removed, in the order it applied them. */
export function previousImageAssetsFromClassifier(classifier: unknown): PreviousImageAssetRecord[] {
  return readAssetRecords(classifier, "previousAssets", "previousAsset").map((stored) => ({
    id: stored.id,
    pageId: stored.pageId,
    path: stored.path,
    prompt: stored.prompt,
    ...(typeof stored.raw.imagePrompt === "string" || stored.raw.imagePrompt === null
      ? { imagePrompt: stored.raw.imagePrompt }
      : {}),
    ...(typeof stored.raw.afterPath === "string" && stored.raw.afterPath ? { afterPath: stored.raw.afterPath } : {}),
    ...(stored.raw.generation !== undefined
      ? { generation: storedImageRenderProvenance(stored.raw.generation) }
      : {}),
    ...(typeof stored.raw.destPageId === "string" && stored.raw.destPageId
      ? { destPageId: stored.raw.destPageId }
      : {}),
    ...(typeof stored.raw.destImagePrompt === "string" || stored.raw.destImagePrompt === null
      ? { destImagePrompt: stored.raw.destImagePrompt }
      : {})
  }));
}

/** Destination heroes a move pushed out of the hero slot into an inline line. */
export function demotedImageAssetsFromClassifier(classifier: unknown): DemotedImageAssetRecord[] {
  return readAssetRecords(classifier, "demotedAssets", "demotedAsset").map((stored) => ({
    id: stored.id,
    pageId: stored.pageId,
    path: stored.path,
    prompt: stored.prompt,
    ...(typeof stored.raw.imagePrompt === "string" || stored.raw.imagePrompt === null
      ? { imagePrompt: stored.raw.imagePrompt }
      : {})
  }));
}

type ValidatedAssetRecord = {
  id: string;
  pageId: string;
  path: string;
  prompt: string;
  raw: Record<string, unknown>;
};

/** The array key when present, else the singular key, dropping malformed entries. */
function readAssetRecords(classifier: unknown, arrayKey: string, singularKey: string): ValidatedAssetRecord[] {
  const record = jsonRecord(classifier);
  const stored = Array.isArray(record[arrayKey])
    ? (record[arrayKey] as unknown[])
    : record[singularKey] !== undefined
      ? [record[singularKey]]
      : [];
  const validated: ValidatedAssetRecord[] = [];
  for (const entry of stored) {
    const raw = jsonRecord(entry);
    if (
      typeof raw.id !== "string" ||
      !raw.id ||
      typeof raw.pageId !== "string" ||
      !raw.pageId ||
      typeof raw.path !== "string" ||
      !raw.path ||
      typeof raw.prompt !== "string"
    ) {
      continue;
    }
    validated.push({ id: raw.id, pageId: raw.pageId, path: raw.path, prompt: raw.prompt, raw });
  }
  return validated;
}
