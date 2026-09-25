// Deliberately a closed grammar: any unrecognized clause may describe a substantive
// payoff and must retain semantic review. A keyword search would silently lose it.
const number = "(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty)";
const delivery = new RegExp(`^(?:deliver|provide|create|write|produce) (?:exactly )?(\\d+) (text-only )?(?:story )?pages` +
  `(?:, (?:organized|arranged|divided) (?:as|into) ${number}(?: ${number}-page)? chapters)?` +
  "(?:,? (?:with no|without) (illustrations|images|cover artwork|illustrations or cover artwork|images or cover artwork))?\\.?$", "i");

/** Planned chapter counts are provisional. Explicit user structure is inventoried
 * separately from the brief; this recognizes only the remaining delivery facts. */
export function deliveryPromiseFacts(text: string): { pageCount: number; mediaScope?: "story_pages" | "cover" | "all" } | undefined {
  const match = delivery.exec(text.trim());
  if (!match) return undefined;
  const pageCount = Number(match[1]);
  if (!Number.isSafeInteger(pageCount) || pageCount <= 0) return undefined;
  const media = match[3]?.toLowerCase();
  const story = Boolean(match[2]) || Boolean(media && media !== "cover artwork");
  const cover = media?.includes("cover artwork");
  return { pageCount, ...(story || cover ? { mediaScope: story ? (cover ? "all" as const : "story_pages" as const) : "cover" as const } : {}) };
}
