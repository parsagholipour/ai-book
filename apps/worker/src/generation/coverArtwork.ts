import { coverDesignSvg, type CoverDesign } from "@book-maker/core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolves a catalog entry to the artwork bytes `renderCoverPng` composites over.
 *
 * A design normally draws itself as SVG, which is why nothing binary ships with
 * the catalog. `artworkFile` is the upgrade path: drop a 3:4 image into the
 * directory below, name it on the entry, and that one design starts using real
 * art without any other change. The read is here rather than in `packages/core`
 * so the catalog stays a pure module with no filesystem of its own.
 *
 * A named file that cannot be read falls back to the generated SVG instead of
 * throwing — this runs at the end of a paid book, where a cover is worth more
 * than being right about which cover.
 */

const COVER_DESIGN_ASSET_DIR = fileURLToPath(new URL("../../assets/cover-designs/", import.meta.url));

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};

export type CoverDesignArtwork = {
  bytes: Buffer;
  mimeType: string;
  source: "file" | "generated";
};

export async function coverDesignArtwork(design: CoverDesign): Promise<CoverDesignArtwork> {
  if (design.artworkFile) {
    const bytes = await readFile(join(COVER_DESIGN_ASSET_DIR, design.artworkFile)).catch(() => null);
    if (bytes) {
      return { bytes, mimeType: coverDesignArtworkMimeType(design.artworkFile), source: "file" };
    }
  }
  return { bytes: Buffer.from(coverDesignSvg(design), "utf8"), mimeType: "image/svg+xml", source: "generated" };
}

export function coverDesignArtworkMimeType(fileName: string): string {
  const extension = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  return IMAGE_MIME_TYPES[extension] ?? "application/octet-stream";
}
