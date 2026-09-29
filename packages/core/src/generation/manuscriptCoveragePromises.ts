import { mediaAbsenceScopes, type CoverageMediaScope } from "./manuscriptCoverageMedia.js";
import type { PageCountConstraint, RequirementScope } from "../schemas/manuscriptRequirements.js";

export type DeliveryObligation =
  | { kind: "page_count"; quote: string; expectedCount: number; requireNonempty?: true;
    pageCountConstraint?: PageCountConstraint; scope?: RequirementScope }
  | { kind: "word_range"; quote: string; minWords: number; maxWords: number }
  | { kind: "media_absence"; quote: string; mediaScope: CoverageMediaScope };

const number = "(?:[1-9]\\d*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty)";
const chapterClause = new RegExp(`^(?:planned|organized|arranged|divided) (?:as|into) ${number}(?: ${number}-page)? chapters(?=$|[,;])`, "i");

/** Compatibility boundary for untyped plan/story-state promises. Consume the
 * ENTIRE promise before returning typed atoms. Unknown clauses stay semantic;
 * matching a page count at the start must never discharge a substantive payoff.
 * Planned chapter divisions remain provisional; explicit brief structure is
 * inventoried independently. The resulting atoms are persisted as deliveryChecks.
 */
export function deliveryPromiseFacts(text: string): DeliveryObligation[] | undefined {
  const source = text.trim().replace(/\.$/u, "");
  const head = /^(?:(?:plan|deliver|provide|create|write|produce|preserve) )?(?:exactly )?([1-9]\d*) (complete )?(text-only )?(?:story )?pages(?=$|[,;]| (?:with no|without) )/iu.exec(source);
  if (!head || !Number.isSafeInteger(Number(head[1]))) return undefined;
  // "Complete pages" requires populated slots, not just numbered rows. This
  // never consumes a promise of a complete story/ending or any unknown qualifier.
  const obligations: DeliveryObligation[] = [{ kind: "page_count", quote: head[0], expectedCount: Number(head[1]),
    ...(head[2] ? { requireNonempty: true as const } : {}) }];
  if (head[3]) obligations.push({ kind: "media_absence", quote: head[0], mediaScope: "story_pages" });
  let rest = source.slice(head[0].length);
  let chaptersSeen = false, wordsSeen = false, textOnlySeen = Boolean(head[3]);
  while (rest) {
    const separator = /^(?:[,;]\s*|\s+and\s+|\s+(?=with no |without ))/u.exec(rest);
    if (!separator) return undefined;
    rest = rest.slice(separator[0].length);
    const textOnly = /^all text-only(?=$|[,;]| and )/iu.exec(rest);
    if (textOnly && !textOnlySeen) {
      textOnlySeen = true;
      obligations.push({ kind: "media_absence", quote: textOnly[0], mediaScope: "story_pages" });
      rest = rest.slice(textOnly[0].length);
      continue;
    }
    const chapters = chapterClause.exec(rest);
    if (chapters && !chaptersSeen) { chaptersSeen = true; rest = rest.slice(chapters[0].length); continue; }
    const words = /^with ([1-9]\d*)\s*[-–]\s*([1-9]\d*) words per page(?=$|[,;]| and )/iu.exec(rest);
    if (words && !wordsSeen) {
      const minWords = Number(words[1]), maxWords = Number(words[2]);
      if (!Number.isSafeInteger(minWords) || !Number.isSafeInteger(maxWords) || minWords > maxWords) return undefined;
      wordsSeen = true;
      obligations.push({ kind: "word_range", quote: words[0], minWords, maxWords });
      rest = rest.slice(words[0].length);
      continue;
    }
    const media = mediaAbsenceScopes(rest);
    if (!media) return undefined;
    for (const mediaScope of media) {
      if (!obligations.some(o => o.kind === "media_absence" && o.mediaScope === mediaScope))
        obligations.push({ kind: "media_absence", quote: rest, mediaScope });
    }
    rest = "";
  }
  return obligations;
}
