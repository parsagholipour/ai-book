import { cutChapter, type EditChapterOptions, type EditedChapterText } from "./composedChapter.js";
import { countReadableWords } from "./proseShape.js";

/** The cut scoped to a chapter's tail: the read's notes name recap tails and closers, so the head is not sent. */
export const CUT_TAIL_WORDS = 600;

export async function cutChapterTail(
  options: EditChapterOptions & { notes: string[]; bookNotes?: string[] | undefined }
): Promise<EditedChapterText> {
  const paragraphs = options.markdown.split(/\n\s*\n/);
  let tailStart = paragraphs.length;
  let words = 0;
  while (tailStart > 1 && words < CUT_TAIL_WORDS) {
    tailStart -= 1;
    words += countReadableWords(paragraphs[tailStart] ?? "");
  }
  const head = paragraphs.slice(0, tailStart).join("\n\n");
  const tail = paragraphs.slice(tailStart).join("\n\n");
  const cut = await cutChapter({ ...options, markdown: tail, unchangedPrefix: [options.unchangedPrefix, head].filter(Boolean).join("\n\n") });
  if (!cut.changed) {
    return { markdown: options.markdown, words: countReadableWords(options.markdown), attempts: cut.attempts, changed: false };
  }
  const markdown = head ? `${head}\n\n${cut.markdown}` : cut.markdown;
  return { markdown, words: countReadableWords(markdown), attempts: cut.attempts, changed: true };
}

/** The cut may remove at most a quarter of the chapter. */
const CUT_MIN_KEPT_SHARE = 0.75;

function cutParagraphs(markdown: string): string[] {
  return markdown
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function cutSentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?؟。][”"’')\]]?)\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * Accepts a cut only if it is one: every kept paragraph is one of the draft's
 * paragraphs with zero or more whole sentences removed, in order, and the
 * chapter kept at least 75% of its words and made a cut. Anything else — a rewrite,
 * a merge, a fragment, a refusal, an over-cut — returns undefined and the draft
 * stands. Nothing the model writes can enter the book through this pass.
 */
export function deletionOnlyResult(draft: string, candidate: string): string | undefined {
  const draftParagraphs = cutParagraphs(draft);
  const keptParagraphs = cutParagraphs(candidate);
  if (keptParagraphs.length === 0 || keptParagraphs.length > draftParagraphs.length) {
    return undefined;
  }
  let cursor = 0;
  for (const kept of keptParagraphs) {
    const keptSentences = cutSentences(kept);
    let found = -1;
    for (let index = cursor; index < draftParagraphs.length; index += 1) {
      const source = cutSentences(draftParagraphs[index]!);
      let at = 0;
      for (const sentence of source) {
        if (at < keptSentences.length && sentence === keptSentences[at]) {
          at += 1;
        }
      }
      if (at === keptSentences.length) {
        found = index;
        break;
      }
    }
    if (found < 0) {
      return undefined;
    }
    cursor = found + 1;
  }
  const draftWords = countReadableWords(draft);
  const keptWords = countReadableWords(candidate);
  const share = draftWords > 0 ? keptWords / draftWords : 0;
  if (share < CUT_MIN_KEPT_SHARE || keptWords >= draftWords) {
    return undefined;
  }
  return keptParagraphs.join("\n\n");
}
