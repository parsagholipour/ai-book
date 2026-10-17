import type { ManuscriptQualityIssue } from "./manuscriptQualityIssue.js";

/**
 * A model finding the page it names refutes outright, dropped before it is
 * graded, shown or repaired.
 *
 * Only one shape so far: "this page has no dialogue" about a page that prints
 * attributed speech. Whole-book review filed "Page 4: This page has no
 * dialogue…" with “Every light is gone,” Rabbit said as its own evidence, and
 * an unverified concern said the same of a page where Rabbit says two lines
 * (2026-10-15 labels: both false to every labeller). The picture-book review
 * already *challenges* such a claim while it runs
 * (`pictureBookChecklistCounterevidence`), but a challenge can be retained, and
 * those two were.
 *
 * It is a veto, so it is narrow in both halves. The claim has to say speech is
 * absent — not that it is stiff, thin or unattributed — and the page has to
 * hold a quotation with a speech verb beside it, which a quoted sign, title or
 * thought does not have. A page with quotation marks and no such verb keeps the
 * finding for the reader of the console to judge, and a claim about several
 * pages is dropped only when every one of them speaks.
 */
const SPEECH_ABSENCE =
  /\b(?:no|without|lacks?|missing|absent)\s+(?:(?:any|natural|spoken|actual|direct|explicit)\s+)*(?:dialogue|speech|spoken (?:words|lines))\b(?!\s+(?:tags?|attributions?|markers?))|\b(?:dialogue|speech)\s+(?:is\s+)?(?:absent|missing)\b|\b(?:does not|doesn't)\s+(?:include|contain|have|feature)\s+(?:any\s+)?(?:dialogue|speech)\b/iu;

const QUOTATION = /“[^“”\n]{2,}”|"[^"\n]{2,}"|«[^«»\n]{2,}»|„[^„“”\n]{2,}[“”]/gu;

const SPEECH_VERBS =
  "said|says|asked|asks|whispered|whispers|shouted|shouts|called|calls|cried|cries|replied|replies|answered|answers|" +
  "yelled|yells|murmured|murmurs|added|adds|told|tells|exclaimed|laughed|giggled|sang|sings|squeaked|sighed|muttered|" +
  "mutters|explained|explains|insisted|agreed|announced|declared|begged|pleaded|gasped|grumbled|chirped|hollered|" +
  "shrieked|screamed|repeated|continued";

/** The verb follows the quotation within a few words: “…,” Rabbit said / “…” he asked. */
const ATTRIBUTION_AFTER = new RegExp(`^\\s*(?:[\\p{L}'’-]+\\s+){0,3}(?:${SPEECH_VERBS})\\b`, "iu");
/** The verb leads into the quotation: Rabbit asked, “…” / She said: “…”. */
const ATTRIBUTION_BEFORE = new RegExp(`\\b(?:${SPEECH_VERBS})(?:\\s+[\\p{L}'’-]+){0,3}\\s*[,:]\\s*$`, "iu");

/** Whether the page prints a quotation a speech verb attributes to someone. */
export function hasAttributedSpeech(markdown: string): boolean {
  for (const match of markdown.matchAll(QUOTATION)) {
    const start = match.index;
    const end = start + match[0].length;
    if (ATTRIBUTION_AFTER.test(markdown.slice(end, end + 48)) || ATTRIBUTION_BEFORE.test(markdown.slice(Math.max(0, start - 48), start))) {
      return true;
    }
  }
  return false;
}

/**
 * Whether `issue` says speech is absent from pages that all print attributed
 * speech. A finding that carries several complaints (page QA joins its issues
 * one to a line) is never dropped for one of them.
 */
export function speechAbsenceRefuted(issue: ManuscriptQualityIssue, pageText: ReadonlyMap<number, string>): boolean {
  if (issue.source !== "model" || issue.affectedPageIndexes.length === 0 || /\n/.test(issue.message.trim()) ||
    !SPEECH_ABSENCE.test(issue.message)) return false;
  return issue.affectedPageIndexes.every((index) => {
    const markdown = pageText.get(index);
    return markdown !== undefined && hasAttributedSpeech(markdown);
  });
}

/** The model findings left once every one its own pages refute is dropped. */
export function withoutRefutedFindings<T extends ManuscriptQualityIssue>(
  issues: readonly T[],
  pages: readonly { index: number; markdown: string }[]
): T[] {
  const pageText = new Map(pages.map((page) => [page.index, page.markdown]));
  return issues.filter((issue) => !speechAbsenceRefuted(issue, pageText));
}
