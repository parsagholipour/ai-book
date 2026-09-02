import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import type { BookPlan, ChapterPlan, CreateProjectInput } from "../schemas/book.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";

/**
 * The one stage in the composed-chapters pipeline that chooses. Every other
 * stage generates once and keeps, so variety is asserted by rules, and rules
 * are performed. Two drafts of a chapter, a forced choice by a judge from
 * another model family, both orders, and a disagreement is a tie that keeps
 * the first draft. The rubric is the blind panel's, not the writer's: rhythm,
 * commitment, forward motion, varied endings; never topic, facts or length.
 */

export const JUDGE_CHAPTER_DRAFTS_PURPOSE = "judge-chapter-drafts";

const verdictSchema = z.object({
  winner: z.enum(["A", "B"]),
  reason: z.string().default("")
});

export type ChapterDraftVerdict = {
  /** Index into `drafts` of the chosen draft. */
  pick: number;
  /** Both orders named the same draft. */
  agreed: boolean;
  reasons: string[];
};

const JUDGE_RUBRIC =
  "You are choosing between two drafts of the same chapter of a book for a demanding general reader; you see the opening and the closing of each. Which of the two would that reader keep reading? Judge paragraph rhythm (do paragraphs differ in length and shape, is there a sustained stretch and a short turn), whether sentences commit (or re-balance what they just said with a counterweight), whether the chapter moves forward or re-states, whether paragraphs and sections end differently from one another. Ignore the topic, the facts, and which draft is longer. Do not prefer the draft that hedges more carefully. A forced choice: return one JSON object {\"winner\": \"A\" or \"B\", \"reason\": one sentence naming the decisive difference}. Never answer with a tie.";

async function judgeOnce(
  judge: TextModelAdapter,
  header: Record<string, unknown>,
  first: string,
  second: string
): Promise<{ winner: "A" | "B"; reason: string }> {
  const result = await generateJsonWithRetry(judge, {
    purpose: JUDGE_CHAPTER_DRAFTS_PURPOSE,
    temperature: 0.2,
    maxTokens: 400,
    schema: verdictSchema,
    messages: [
      { role: "system", content: JUDGE_RUBRIC },
      { role: "user", content: JSON.stringify({ ...header, draftA: first, draftB: second }, null, 2) }
    ]
  });
  return result.data;
}

const EXCERPT_HEAD_WORDS = 900;
const EXCERPT_TAIL_WORDS = 450;

/** Aligned excerpts of equal size, so length and the middle cannot decide. */
export function judgeExcerpt(markdown: string): string {
  const words = markdown.trim().split(/\s+/);
  if (words.length <= EXCERPT_HEAD_WORDS + EXCERPT_TAIL_WORDS + 100) {
    return markdown.trim();
  }
  return `${words.slice(0, EXCERPT_HEAD_WORDS).join(" ")}\n\n[…]\n\n${words.slice(-EXCERPT_TAIL_WORDS).join(" ")}`;
}

export async function judgeChapterDrafts(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  chapter: ChapterPlan;
  drafts: readonly string[];
  judge: TextModelAdapter;
}): Promise<ChapterDraftVerdict> {
  if (options.drafts.length < 2) {
    return { pick: 0, agreed: true, reasons: [] };
  }
  const [first, second] = [judgeExcerpt(options.drafts[0]!), judgeExcerpt(options.drafts[1]!)];
  const header = {
    book: { title: options.plan.title, audience: options.plan.audience },
    chapter: { index: options.chapter.index, title: options.chapter.title }
  };
  const [forward, reversed] = await Promise.all([
    judgeOnce(options.judge, header, first, second),
    judgeOnce(options.judge, header, second, first)
  ]);
  // In the reversed order "A" is the second draft.
  const forwardPick = forward.winner === "A" ? 0 : 1;
  const reversedPick = reversed.winner === "A" ? 1 : 0;
  const agreed = forwardPick === reversedPick;
  return {
    pick: agreed ? forwardPick : 0,
    agreed,
    reasons: [forward.reason, reversed.reason].filter(Boolean)
  };
}
