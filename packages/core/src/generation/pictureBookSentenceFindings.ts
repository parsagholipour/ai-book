import type { CreateProjectInput } from "../schemas/book.js";
import { kidsReadingGuidanceForInput } from "../prompting/readingLevel.js";
import { onlySentenceLengthIssues, sentenceLengthRepairSentences } from "./pageSentenceRepair.js";
import { pictureBookFindingDiagnosis } from "./pictureBookFindingIdentity.js";
import { pictureBookMeasurementErrors, pictureBookPageMeasurements } from "./pictureBookReviewMeasurements.js";
import type { PictureBookPageReview } from "./pictureBookReviewValidation.js";

type Finding = NonNullable<PictureBookPageReview["findings"]>[number];
type Page = { index: number; markdown?: string };

/** Compatibility for the captured numeric-only diagnosis, not a keyword rule.
 * Unknown clauses, grammar diagnoses and editorial advice remain semantic. */
function legacySentenceMeasurement(input: CreateProjectInput, markdown: string, finding: Finding): boolean {
  const limits = kidsReadingGuidanceForInput(input)!;
  const guidance = [
    /^Shorten the sentence beginning “[^”\n]{1,100}” and trim the page’s sentence lengths so the average is at or below (\d+) words and no sentence exceeds (\d+)\.$/u,
    /^Shorten the sentence listing [\p{L}\d ’'-]{1,100} and trim other sentences as needed to bring the average to (\d+) words or fewer and every sentence to (\d+) words or fewer\.$/u
  ].map(pattern => pattern.exec(finding.guidance)).find(Boolean);
  if (!onlySentenceLengthIssues(input, [finding.guidance]) && (!guidance ||
    Number(guidance[1]) !== limits.maxAverageSentenceWords || Number(guidance[2]) !== limits.maxSentenceWords)) return false;
  if (onlySentenceLengthIssues(input, [finding.message])) return pictureBookMeasurementErrors(markdown, [finding.message]).length === 0;
  const match = /^(?:Page \d+|This page) exceeds (?:the stated|both) sentence-length limits: its average is (\d+(?:\.\d+)?) words, and (?:one|a) sentence is (\d+) words\.$/u.exec(finding.message);
  if (!match) return false;
  const measured = pictureBookPageMeasurements(markdown);
  return Number(match[1]) === Number(measured.average.toFixed(1)) && Number(match[2]) === measured.longest;
}

/** A typed finding can only narrow edits to measured, quoted original sentences.
 * It never clears a finding, approves prose, or overrides a semantic target. */
export function isPictureBookSentenceLengthFinding(input: CreateProjectInput, page: Page, finding: Finding): boolean {
  const limits = kidsReadingGuidanceForInput(input), markdown = page.markdown;
  if (!limits || !markdown || finding.repairKind === "semantic" || finding.domain !== "prose" ||
    finding.basis !== "page_prose" || finding.category !== "language" || finding.requirementQuote !== null ||
    finding.relatedEvidence.length || finding.repairPageIndexes !== undefined || !markdown.includes(finding.quote)) return false;
  const measured = pictureBookPageMeasurements(markdown);
  if (measured.average <= limits.maxAverageSentenceWords && measured.longest <= limits.maxSentenceWords) return false;
  if (!sentenceLengthRepairSentences(input, markdown).some(sentence => sentence.includes(finding.quote) || finding.quote.includes(sentence))) return false;
  return finding.repairKind === "sentence_length" || legacySentenceMeasurement(input, markdown, finding);
}

/** Match exact messages emitted from verified findings, including their guidance.
 * A shared page/category or similar wording never makes two diagnoses equivalent. */
export function pictureBookSentenceFindingMessages(input: CreateProjectInput, pages: readonly Page[], reviews: readonly PictureBookPageReview[]) {
  const originals = new Map(pages.map(page => [page.index, page]));
  const messages = new Map<number, Set<string>>();
  for (const review of reviews) {
    const page = originals.get(review.pageIndex);
    if (!page || page.markdown !== review.draftMarkdown || !review.completedChecks.pageModelReview) continue;
    for (const finding of review.findings ?? []) {
      if (!isPictureBookSentenceLengthFinding(input, page, finding)) continue;
      const owned = messages.get(page.index) ?? new Set<string>();
      for (const message of [pictureBookFindingDiagnosis(page.index, finding), finding.guidance]) owned.add(message);
      messages.set(page.index, owned);
    }
  }
  return messages;
}
