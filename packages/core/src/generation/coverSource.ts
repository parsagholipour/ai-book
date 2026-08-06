import type { MediaSettings } from "../schemas/book.js";

export type CoverArtSource = "ai" | "design" | "none";

/**
 * The single place `includeCover` is interpreted.
 *
 * That flag predates designed covers and only ever answered "did a model draw
 * this cover", so `false` now resolves to `"design"`: a book that declined the
 * AI artwork still gets a cover, rendered from the bundled catalog for free.
 * A genuinely cover-less book has to say `"none"` explicitly, which only the
 * operator console does.
 *
 * Writers keep setting `includeCover` alongside the explicit field so a client
 * on an older build still reads the priced choice correctly.
 */
export function coverArtSourceFor(mediaSettings: Pick<MediaSettings, "includeCover" | "coverArtSource">): CoverArtSource {
  return mediaSettings.coverArtSource ?? (mediaSettings.includeCover ? "ai" : "design");
}

/** The legacy flag for a given source, for writers that must set both. */
export function includeCoverForSource(source: CoverArtSource): boolean {
  return source === "ai";
}
