import { jsonRecord } from "../schemas/jsonCoercion.js";
import type { ImageCopyrightRewrite, ImageFallbackMetadata } from "../adapters/types.js";

/**
 * The half of `ImageAsset.metadata` that describes *this render* rather than
 * the slot the picture sits in.
 *
 * `metadata.copyrightRewrite` is the only IP-provenance record this product
 * keeps: `ImageAsset.prompt` is what the book asked for, and that key is the
 * claim about what was drawn instead when a filter refused the name. A false
 * one is worse than none — so it may never outlive the bytes it describes.
 * Every other key on that document (`keeperToken`, `keeperPageId`,
 * `legacyGenerationJobId`, `planId`, the storage measurements) belongs to the
 * row and its file slot, and illustration ownership is decided from some of
 * them, so a redraw merges rather than overwrites.
 *
 * Two writes need that merge and they are mirror images: a replacement, which
 * installs the new render's provenance over the old, and undo, which puts the
 * previous picture's own provenance back with its bytes.
 */
export const IMAGE_RENDER_PROVENANCE_KEYS = ["fallback", "copyrightRewrite"] as const;

export type ImageRenderProvenance = {
  fallback?: ImageFallbackMetadata | undefined;
  copyrightRewrite?: ImageCopyrightRewrite | undefined;
};

/**
 * What a finished render claims about itself, as stored metadata.
 *
 * Absent keys are absent rather than `undefined`: this document is written to a
 * JSON column, where an explicit `undefined` is not a value and a `null` would
 * be a claim of its own.
 */
export function imageRenderProvenance(image: ImageRenderProvenance): Record<string, unknown> {
  return {
    ...(image.fallback ? { fallback: image.fallback } : {}),
    ...(image.copyrightRewrite ? { copyrightRewrite: image.copyrightRewrite } : {})
  };
}

/** The provenance a stored metadata document carries, on its own. */
export function storedImageRenderProvenance(metadata: unknown): Record<string, unknown> {
  const record = jsonRecord(metadata);
  const provenance: Record<string, unknown> = {};
  for (const key of IMAGE_RENDER_PROVENANCE_KEYS) {
    if (record[key] !== undefined) {
      provenance[key] = record[key];
    }
  }
  return provenance;
}

/**
 * `metadata` with its render provenance replaced wholesale by `provenance`.
 *
 * Wholesale is the point. Spreading the new render's keys over the old
 * document would leave a *previous* render's `copyrightRewrite` standing
 * whenever the new one had none — the row then asserting that a protected name
 * was removed from a picture that never named one.
 */
export function withImageRenderProvenance(
  metadata: unknown,
  provenance: Record<string, unknown>
): Record<string, unknown> {
  const kept = { ...jsonRecord(metadata) };
  for (const key of IMAGE_RENDER_PROVENANCE_KEYS) {
    delete kept[key];
  }
  return { ...kept, ...provenance };
}
