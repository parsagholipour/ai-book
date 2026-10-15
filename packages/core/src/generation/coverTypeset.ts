import { createHash } from "node:crypto";
import { isRecord } from "../schemas/jsonCoercion.js";

/**
 * The words a cover is typeset with. The artwork never holds them —
 * `buildCoverArtworkPrompt` forbids text and `renderCoverPng` sets the title,
 * subtitle and byline over the picture — so changing them is a re-render, not a
 * redraw, *if the picture is still at hand*.
 *
 * Every cover row records the words it was set with (`metadata.typeset`), and
 * one drawn by a model also keeps its artwork (`metadata.artworkObjectKey`).
 * That is what lets a pen name typed while the book is still being written
 * reach a cover that was finished minutes earlier, and a renamed book keep the
 * picture it was sold with, for nothing.
 */
export type CoverTypeset = { title: string; subtitle: string; authorName: string };

/** The `ImageAsset.metadata` key that names a model-drawn cover's stored artwork. */
export const COVER_ARTWORK_OBJECT_KEY = "artworkObjectKey";

export function coverTypesetFor(words: {
  title?: string | null | undefined;
  subtitle?: string | null | undefined;
  coverTagline?: string | null | undefined;
  authorName?: string | null | undefined;
}): CoverTypeset {
  return {
    title: clean(words.title),
    // `renderCoverPng` sets the tagline in the subtitle's place when there is no subtitle.
    subtitle: clean(words.subtitle) || clean(words.coverTagline),
    authorName: clean(words.authorName)
  };
}

/** What a stored cover row says it was set with, or `undefined` for a row from before it said. */
export function storedCoverTypeset(assetMetadata: unknown): CoverTypeset | undefined {
  const typeset = isRecord(assetMetadata) ? assetMetadata.typeset : undefined;
  if (!isRecord(typeset)) return undefined;
  const { title, subtitle, authorName } = typeset;
  if (typeof title !== "string" || typeof subtitle !== "string" || typeof authorName !== "string") return undefined;
  return { title, subtitle, authorName };
}

export function sameCoverTypeset(left: CoverTypeset, right: CoverTypeset): boolean {
  return left.title === right.title && left.subtitle === right.subtitle && left.authorName === right.authorName;
}

/**
 * Where a free re-typeset takes its picture from: the catalog design the cover
 * was rendered from, or the stored artwork of a drawn one. `undefined` for an
 * upload (nothing is typeset on it) and for a drawn cover from before artwork
 * was kept — the words in its pixels can change only with a paid redraw.
 */
export function coverRetypesetSource(assetMetadata: unknown): "design" | "artwork" | undefined {
  if (!isRecord(assetMetadata)) return undefined;
  if (assetMetadata.coverArtSource === "design" && typeof assetMetadata.coverDesignId === "string") return "design";
  const key = assetMetadata[COVER_ARTWORK_OBJECT_KEY];
  return typeof key === "string" && key.length > 0 ? "artwork" : undefined;
}

/**
 * Short and stable, for a dedupe key: one re-typeset per change of a cover's
 * words — from the words it was set with to the words it should carry. Naming
 * only the target is not enough: a byline changed A → X → A sets the cover to X
 * and then needs A again, and an earlier re-set *to* A has already spent that
 * key. Naming both still stops a loop, because a re-set that ran and could not
 * change the cover leaves the same pair behind and finds its own key spent.
 * `stored` is `undefined` for a cover from before covers recorded their words.
 */
export function coverRetypesetFingerprint(stored: CoverTypeset | undefined, target: CoverTypeset): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        stored ? [stored.title, stored.subtitle, stored.authorName] : null,
        [target.title, target.subtitle, target.authorName]
      ]),
      "utf8"
    )
    .digest("hex")
    .slice(0, 16);
}

function clean(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}
