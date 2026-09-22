import { Lexer } from "marked";
import { cutChapter, type EditChapterOptions, type EditedChapterText } from "./composedChapter.js";
import { mathAt } from "./markdownMathSyntax.js";
import { countReadableWords } from "./proseShape.js";

/** The cut scoped to a chapter's tail: the read's notes name recap tails and closers, so the head is not sent. */
export const CUT_TAIL_WORDS = 600;

export async function cutChapterTail(
  options: EditChapterOptions & { notes: string[]; bookNotes?: string[] | undefined }
): Promise<EditedChapterText> {
  const paragraphs = cutParagraphs(options.markdown);
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
  const blocks: string[] = [];
  let lines: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  const flush = () => {
    if (lines.some((line) => line.trim())) blocks.push(lines.join("\n"));
    lines = [];
  };
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const match = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      lines.push(line);
      if (match && match[1]![0] === fence.marker && match[1]!.length >= fence.length && !match[2]!.trim()) fence = undefined;
    } else if (match) {
      lines.push(line);
      fence = { marker: match[1]![0]!, length: match[1]!.length };
    } else if (!line.trim()) flush();
    else lines.push(line);
  }
  flush();
  return blocks;
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

function protectedSpans(paragraph: string): string[] | undefined {
  if (paragraph.includes("\n")) return undefined;
  const blocks = Lexer.lex(paragraph);
  const block = blocks[0];
  if (blocks.length !== 1 || block?.type !== "paragraph" || !block.tokens) return undefined;
  const spans = block.tokens.filter((token) => token.type !== "text").map((token) => token.raw);
  // Use the renderer's TeX syntax: marked otherwise treats math as ordinary text.
  for (let at = 0; at < paragraph.length; at += 1) {
    const math = mathAt(paragraph, at);
    if (math) {
      spans.push(paragraph.slice(at, math.end));
      at = math.end - 1;
    } else if (paragraph[at] === "\\") at += 1;
  }
  return spans;
}

function preservesInlineStructure(original: string, candidate: string): boolean {
  const before = protectedSpans(original);
  const after = protectedSpans(candidate);
  return before !== undefined && after !== undefined && before.length === after.length
    && before.every((span, index) => span === after[index]);
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
  const preserved: string[] = [];
  let cursor = 0;
  for (const kept of keptParagraphs) {
    const keptSentences = cutSentences(normalize(kept));
    let found = -1;
    for (let index = cursor; index < draftParagraphs.length; index += 1) {
      const original = draftParagraphs[index]!;
      if (normalize(kept) === normalize(original)) {
        preserved.push(original);
        found = index;
        break;
      }
      // Even a single line can be code, a list item or a formatted span crossing
      // sentence boundaries. Keep these whole, just like multiline blocks.
      if (original.includes("\n") || kept.includes("\n")) continue;
      const source = cutSentences(original);
      let at = 0;
      const retained: string[] = [];
      for (const sentence of source) {
        if (at < keptSentences.length && normalize(sentence) === keptSentences[at]) {
          retained.push(sentence);
          at += 1;
        }
      }
      const retainedText = retained.join(" ");
      if (at === keptSentences.length && preservesInlineStructure(original, retainedText)) {
        preserved.push(retainedText);
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
  return preserved.join("\n\n");
}
