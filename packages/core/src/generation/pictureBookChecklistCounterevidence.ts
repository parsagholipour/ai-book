import type { PriorPageContext } from "./pagesShared.js";
import { pictureBookChecklistSpans } from "./pictureBookChecklistSpans.js";

/** This challenges an absence diagnosis, never certifies natural dialogue.
 * Quoted thoughts, signs and unnatural speech still need a contextual judgment. */
export function pictureBookSpeechCounterevidence(page: Pick<PriorPageContext, "index" | "markdown">, requirement: string, message: string) {
  if (!/dialogue|speech|spoken/iu.test(requirement)) return [];
  const absence = /\b(?:no|without|lacks?|missing|absent)\s+(?:(?:any|natural|spoken|actual|direct|explicit)\s+)*(?:dialogue|speech|spoken (?:words|lines))\b|\b(?:dialogue|speech)\s+(?:is\s+)?(?:absent|missing)\b|\b(?:does not|doesn't)\s+(?:include|contain|have|feature)\s+(?:any\s+)?(?:dialogue|speech)\b/iu;
  if (!absence.test(message)) return [];
  const quotations = [...page.markdown.matchAll(/“[^“”]+”|"[^"\n]+"|«[^«»]+»|「[^「」]+」|『[^『』]+』|‘[^‘’]+’/gu)];
  if (!quotations.length) return [];
  let offset = 0;
  return Object.entries(pictureBookChecklistSpans(page)).flatMap(([id, text]) => {
    const start = offset;
    offset += text.length;
    return quotations.some(match => match.index < offset && match.index + match[0].length > start) ? [id] : [];
  });
}
