import { coupletAnchors, splitCoupletSentences } from "./coupletRewrite.js";
import { countReadableWords } from "./proseShape.js";

/**
 * The paragraph-final disclaimer cap. Three Opus readers of `legacy-cuts-7b`
 * each wrote a version of "almost every paragraph closes on an epistemic-limit
 * disclaimer"; measured on that book, 84 disclaimer sentences (26 per 1,000),
 * 22 of them the last sentence of a paragraph of three or more that carried no
 * fact appearing anywhere else — 468 words of pure cadence.
 *
 * The cap is deterministic and conservative in three ways at once. It only ever
 * *deletes*, so no sentence is invented and no fact is moved; it only touches a
 * paragraph-final sentence whose every anchor (a capitalised word or a number)
 * is said again elsewhere in the chapter, so a disclaimer that carries the only
 * mention of a date, a place or a source survives; and it keeps every third
 * candidate, because the move is a tic at 26 per 1,000, not an error. The floor
 * is the last guard: deletion stops before the chapter falls under `minWords`,
 * which is why the chapter budget now asks ~10% above it.
 */

const DISCLAIMER_VERB =
  /(cannot|can't|could not|does not|do not|did not|will not|would not|rarely|never|no longer|hardly)\s+(\w+\s+){0,3}?(show|shows|establish|establishes|tell|tells|reveal|reveals|record|records|prove|proves|settle|settles|supply|supplies|answer|answers|explain|explains|identify|identifies|preserve|preserves|register|registers|measure|measures|guarantee|guarantees|say|says|determine|determines|capture|captures|disclose|discloses|indicate|indicates|specify|specifies|name|names)\b/i;

const DISCLAIMER_PHRASE =
  /more securely than|less securely than|offers? no\b|leaves? (open|unresolved|undecided|unanswered)|is (limited|silent|weakest|strongest) (at|on|about)|beyond (its|their|the) (record|reach|evidence)|remains? (unknown|uncertain|unresolved|beyond)|what (it|they|the \w+) cannot\b/i;

/** A sentence whose work is to say what the material does not do. */
export function isDisclaimerSentence(sentence: string): boolean {
  return DISCLAIMER_VERB.test(sentence) || DISCLAIMER_PHRASE.test(sentence);
}

/** Headings, quotations, list items, fences and figure lines are read past, exactly as the couplet detector reads them. */
function isProseParagraph(paragraph: string): boolean {
  return !/^\s*(?:#|>|[-*]\s|\d+\.\s|```|!\[)/.test(paragraph) && !paragraph.includes("```");
}

/** True when every anchor of the sentence is said again somewhere else in the chapter. */
function carriesNoUniqueAnchor(sentence: string, markdown: string): boolean {
  const at = markdown.indexOf(sentence);
  const rest = at === -1 ? markdown : markdown.slice(0, at) + markdown.slice(at + sentence.length);
  for (const anchor of coupletAnchors(sentence)) {
    if (!rest.includes(anchor)) return false;
  }
  return true;
}

export type DisclaimerCapResult = {
  markdown: string;
  /** Paragraph-final disclaimers the chapter offered up. */
  found: number;
  /** How many of them this pass deleted. */
  removed: number;
  /** Readable words the deletions took out. */
  words: number;
};

type Candidate = { paragraph: number; sentence: string; kept: string };

export function capParagraphFinalDisclaimers(
  markdown: string,
  options: { minWords: number; keepEvery?: number | undefined }
): DisclaimerCapResult {
  const keepEvery = Math.max(1, options.keepEvery ?? 3);
  const paragraphs = markdown.split(/\n\s*\n/);
  const candidates: Candidate[] = [];
  paragraphs.forEach((paragraph, index) => {
    if (!isProseParagraph(paragraph)) return;
    const sentences = splitCoupletSentences(paragraph);
    if (sentences.length < 3) return;
    const last = sentences[sentences.length - 1]!;
    if (!isDisclaimerSentence(last)) return;
    if (!carriesNoUniqueAnchor(last, markdown)) return;
    const trimmed = paragraph.trimEnd();
    const kept = trimmed.endsWith(last)
      ? trimmed.slice(0, trimmed.length - last.length).trimEnd()
      : sentences.slice(0, -1).join(" ");
    if (!kept) return;
    candidates.push({ paragraph: index, sentence: last, kept });
  });
  let words = countReadableWords(markdown);
  let removed = 0;
  let removedWords = 0;
  candidates.forEach((candidate, position) => {
    if ((position + 1) % keepEvery === 0) return;
    const cost = countReadableWords(candidate.sentence);
    if (words - cost < options.minWords) return;
    paragraphs[candidate.paragraph] = candidate.kept;
    words -= cost;
    removedWords += cost;
    removed += 1;
  });
  return {
    markdown: removed > 0 ? paragraphs.join("\n\n") : markdown,
    found: candidates.length,
    removed,
    words: removedWords
  };
}
