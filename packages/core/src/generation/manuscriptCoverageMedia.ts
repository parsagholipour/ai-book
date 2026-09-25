import { marked } from "marked";
import { findFigureFences } from "./figures/figureBlocks.js";

type MediaScope = "story_pages" | "cover" | "all";
export type CoverageMediaInventory = { storyPagesWithArtwork?: number[]; coverArtworkCount?: number };

/** Older inventories called simple prohibitions content. Only a whole media-only
 * quote can be normalized; mixed requirements and subject/style restrictions still need review. */
export function normalizeMediaAbsence<T extends { kind: string; quote: string; mediaScope?: MediaScope | undefined }>(requirement: T):
  T | (Omit<T, "kind" | "mediaScope"> & { kind: "media_absence"; mediaScope: MediaScope }) {
  if (requirement.kind !== "content" && requirement.kind !== "illustration") return requirement;
  const list = requirement.quote.trim().replace(/\.$/, "").match(/^(?:no|without)\s+(.+)$/i)?.[1];
  if (!list) return requirement;
  const terms = list.toLowerCase().split(/\s*,\s*(?:(?:or|and)\s+)?|\s+(?:or|and)\s+/);
  if (!terms.length || terms.some((term) => !["illustrations", "images", "cover artwork"].includes(term))) return requirement;
  const cover = terms.includes("cover artwork");
  const story = terms.some((term) => term !== "cover artwork");
  return { ...requirement, kind: "media_absence", mediaScope: cover ? (story ? "all" : "cover") : "story_pages" };
}

export function mediaAbsenceVerdict(scope: MediaScope | undefined, inventory?: CoverageMediaInventory):
  { status: "fulfilled" | "missing" | "unverified"; reason: string } {
  if (!scope) return { status: "unverified", reason: "The requested artwork prohibition has no verified scope." };
  const story = scope !== "cover";
  const cover = scope !== "story_pages";
  const pages = inventory?.storyPagesWithArtwork;
  const covers = inventory?.coverArtworkCount;
  if ((story && pages && pages.length > 0) || (cover && covers !== undefined && covers > 0)) {
    return { status: "missing", reason: "The export inventory contains artwork prohibited by the request." };
  }
  if ((story && pages === undefined) || (cover && covers === undefined)) {
    return { status: "unverified", reason: "The actual artwork inventory was not supplied for every prohibited location." };
  }
  return { status: "fulfilled", reason: `The export inventory contains no artwork in ${scope === "all" ? "the story pages or cover" : scope === "cover" ? "the cover" : "the story pages"}.` };
}

/** Inventory the same page attachments and cover assets the exporters consume.
 * Project reference sheets are deliberately not inputs. Settings never prove absence. */
export function buildCoverageMediaInventory(pages: readonly { index: number; markdown: string; images?: readonly unknown[] }[], coverArtworkCount: number): CoverageMediaInventory {
  return { coverArtworkCount, ...(pages.every((page) => page.images !== undefined) ? {
    storyPagesWithArtwork: pages.filter((page) => (page.images?.length ?? 0) > 0 || markdownHasArtwork(page.markdown)).map((page) => page.index).sort((a, b) => a - b)
  } : {}) };
}

function markdownHasArtwork(markdown: string): boolean {
  if (findFigureFences(markdown).some((figure) => figure.spec)) return true;
  let found = false;
  marked.walkTokens(marked.lexer(markdown), (token) => {
    if (token.type === "image") found = true;
    if (token.type === "html") {
      const visible = token.raw.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|textarea|pre)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
      if (/<(?:img|svg)\b/i.test(visible)) found = true;
    }
  });
  return found;
}
