import { marked } from "marked";

export type CoverageMediaScope = "story_pages" | "cover" | "all" | "character_references";
type MediaScope = CoverageMediaScope;
export type CoverageMediaInventory = { storyPagesWithArtwork?: number[]; coverArtworkCount?: number; characterReferenceCount?: number };

/** Only complete, unconditional lists describe pure absence. An unknown term
 * (for example, 'images of frightening scenes') preserves semantic review. */
export function mediaAbsenceScopes(quote: string): Exclude<MediaScope, "all">[] | undefined {
  // Only the complete delivery-only clause qualifies. Mixed prose obligations
  // (e.g. text-only AND self-contained scenes) still need semantic review.
  if (/^(?:(?:all|every) story pages? (?:are|must be)|each story page (?:is|must be)) text[- ]only[.!]?$/iu.test(quote.trim())) return ["story_pages"];
  const match = /^(?:(?:(?:with|include) )?no|without|do not (?:create|generate|include|use))\s+(.+)$/iu.exec(quote.trim().replace(/\.$/u, ""));
  if (!match) return undefined;
  const scopes: Exclude<MediaScope, "all">[] = [];
  for (const raw of match[1]!.toLowerCase().split(/\s*,\s*(?:(?:or|and)\s+)?|\s+(?:or|and)\s+/u)) {
    const term = raw.replace(/^(?:a |an )?(?:generated )?/u, "");
    const scope = /^(?:interior )?(?:illustrations|images|artwork)$/u.test(term) ? "story_pages"
      : /^cover(?: image| images| art| artwork)?$/u.test(term) ? "cover"
      : /^character reference (?:images|sheets)$/u.test(term) ? "character_references" : undefined;
    if (!scope) return undefined;
    if (!scopes.includes(scope)) scopes.push(scope);
  }
  return scopes.length ? scopes : undefined;
}

/** Older inventories called simple prohibitions content. Only a whole media-only
 * quote can be normalized; mixed requirements and subject/style restrictions still need review. */
export function normalizeMediaAbsence<T extends { kind: string; quote: string; mediaScope?: MediaScope | undefined }>(requirement: T):
  T | (Omit<T, "kind" | "mediaScope"> & { kind: "media_absence"; mediaScope: MediaScope }) {
  if (requirement.kind !== "content" && requirement.kind !== "illustration") return requirement;
  const scopes = mediaAbsenceScopes(requirement.quote);
  if (!scopes) return requirement;
  // The exact list is expanded into independent deliveryChecks before a verdict.
  return { ...requirement, kind: "media_absence", mediaScope: scopes.length === 1 ? scopes[0]! : "all" };
}

export function mediaAbsenceVerdict(scope: MediaScope | undefined, inventory?: CoverageMediaInventory):
  { status: "fulfilled" | "missing" | "unverified"; reason: string } {
  if (!scope) return { status: "unverified", reason: "The requested artwork prohibition has no verified scope." };
  if (scope === "character_references") {
    const count = inventory?.characterReferenceCount;
    return count === undefined || !Number.isSafeInteger(count) || count < 0
      ? { status: "unverified", reason: "The actual project character-reference asset inventory was not supplied." }
      : count > 0 ? { status: "missing", reason: "The project contains character-reference images prohibited by the request." }
      : { status: "fulfilled", reason: "The project asset inventory contains no character-reference images; saved character profiles are separate." };
  }
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
 * Optional project reference assets have their own count, never an artwork count.
 * Saved character profiles/portrait provenance and settings never prove absence. */
export function buildCoverageMediaInventory(pages: readonly { index: number; markdown: string; images?: readonly unknown[] }[], coverArtworkCount: number, characterReferenceCount?: number): CoverageMediaInventory {
  return { coverArtworkCount, ...(characterReferenceCount !== undefined ? { characterReferenceCount } : {}), ...(pages.every((page) => page.images !== undefined) ? {
    storyPagesWithArtwork: pages.filter((page) => (page.images?.length ?? 0) > 0 || markdownHasArtwork(page.markdown)).map((page) => page.index).sort((a, b) => a - b)
  } : {}) };
}

/**
 * Pictures in the page's text. A ```figure block is not one: a bar, line or pie
 * chart or a flow diagram is typeset from the book's own numbers, with no image
 * asset and no illustration slot. Counted as story-page artwork, a reader who
 * turned illustrations off got "artwork prohibited by the request" on books
 * whose only pictures were their charts (2 of 2 such findings false,
 * 2026-10-15). An explicit "no charts" is not a media scope here
 * (`mediaAbsenceScopes` returns undefined for it), so it stays a requirement
 * the coverage review reads like any other.
 */
function markdownHasArtwork(markdown: string): boolean {
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
