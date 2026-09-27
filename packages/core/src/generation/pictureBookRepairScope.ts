import type { CreateProjectInput } from "../schemas/book.js";
import type { PictureBookRepairFeedback, PictureBookRepairIssue } from "./pictureBookRepair.js";
import { onlySentenceLengthIssues, sentenceLengthRepairSentences } from "./pageSentenceRepair.js";
import { validSceneRepairPageIndexes, type PictureBookSceneRepairTarget } from "./pictureBookSceneRepairTargets.js";
import { pictureBookSentenceFindingMessages } from "./pictureBookSentenceFindings.js";
import type { PictureBookPageReview } from "./pictureBookReviewValidation.js";

/** A diagnostic's explicit page label owns its scope; the group may also include
 * related evidence pages. Ambiguous/unlabeled group advice keeps its full scope. */
export function pictureBookRepairPageScopes(options: {
  input: CreateProjectInput; pages: readonly { index: number; markdown?: string }[]; issues: readonly PictureBookRepairIssue[];
  originalReviews?: readonly PictureBookPageReview[];
  requirementTargets?: readonly { pageIndex: number }[];
  sceneRepairTargets?: readonly PictureBookSceneRepairTarget[];
}): { pageIndex: number; sentenceOnly: boolean }[] {
  const known = new Set(options.pages.map(page => page.index));
  const sentenceMessages = pictureBookSentenceFindingMessages(options.input, options.pages, options.originalReviews ?? []);
  const sentenceOnly = (pageIndex: number, issues: readonly string[]) => issues.length > 0 && issues.every(message =>
    onlySentenceLengthIssues(options.input, [message]) || sentenceMessages.get(pageIndex)?.has(message) ||
    sentenceMessages.get(pageIndex)?.has(message.replace(/^Page \d+: /u, "")));
  const messages = new Map<number, string[]>();
  for (const issue of options.issues) for (const message of issue.messages) {
    const label = /^Page (\d+): /u.exec(message);
    const scope = label && issue.pageIndexes.includes(Number(label[1])) ? [Number(label[1])]
      : issue.pageIndexes.length ? issue.pageIndexes : [...known];
    for (const index of scope) if (known.has(index)) messages.set(index, [...(messages.get(index) ?? []), message]);
  }
  for (const target of options.requirementTargets ?? []) if (known.has(target.pageIndex))
    messages.set(target.pageIndex, [...(messages.get(target.pageIndex) ?? []), "Semantic requirement target"]);
  const semanticOwners = new Set([...messages].filter(([index, issues]) => !sentenceOnly(index, issues)).map(([index]) => index));
  for (const target of options.sceneRepairTargets ?? []) {
    if (!semanticOwners.has(target.pageIndex) || !validSceneRepairPageIndexes(target.pageIndex, target.pageIndexes, known))
      throw new Error("Scene repair interval requires an original semantic target and contiguous known pages.");
    for (const index of target.pageIndexes)
      messages.set(index, [...(messages.get(index) ?? []), "Semantic scene repair target"]);
  }
  return [...messages].sort(([a], [b]) => a - b).map(([pageIndex, issues]) => ({ pageIndex,
    sentenceOnly: sentenceOnly(pageIndex, issues) }));
}

/** Exact patches have already been validated against the frozen original. Permit
 * a broad anchor only when its actual edit stays within one eligible sentence;
 * unchanged prefix/suffix bytes do not grant permission to edit other prose. */
export function sentenceRepairScopeIssues(options: {
  input: CreateProjectInput; pageIndex: number; markdown: string; summary: string;
  patches: readonly { find: string; replace: string }[]; proposedSummary: string | null;
}): string[] {
  const fail = (detail: string) => [`Sentence-only repair on page ${options.pageIndex}: ${detail}`];
  if (options.proposedSummary !== null && options.proposedSummary !== options.summary)
    return fail("keep the original summary; only sentence length is targeted.");
  const ranges = sentenceLengthRepairSentences(options.input, options.markdown).flatMap(sentence => {
    const start = options.markdown.indexOf(sentence);
    return start >= 0 && options.markdown.indexOf(sentence, start + 1) === -1 ? [{ start, end: start + sentence.length }] : [];
  });
  for (const patch of options.patches) {
    let start = 0, end = patch.find.length, replacementEnd = patch.replace.length;
    while (start < end && start < replacementEnd && patch.find[start] === patch.replace[start]) start++;
    if (start === end && start === replacementEnd) continue;
    while (end > start && replacementEnd > start && patch.find[end - 1] === patch.replace[replacementEnd - 1]) { end--; replacementEnd--; }
    const offset = options.markdown.indexOf(patch.find);
    if (!ranges.some(range => offset + start >= range.start && offset + end <= range.end))
      return fail("edit one eligible original sentence per patch, preserving every other sentence. Keep all events, choices and causal consequences.");
  }
  return [];
}

/** A rejected proposal can use the existing correction, but never model review
 * or publication. Its text is feedback, not the next patch's source. */
export class PictureBookRepairScopeError extends Error {
  constructor(readonly feedback: PictureBookRepairFeedback) {
    super(feedback.failures.flatMap(failure => failure.issues).join(" "));
    this.name = "PictureBookRepairScopeError";
  }
}
