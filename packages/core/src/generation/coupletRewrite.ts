import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import { targetLanguageGenerationGuidance, targetLanguagePayload } from "../prompting/language.js";
import type { BookPlan, ChapterPlan, CreateProjectInput } from "../schemas/book.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";

/**
 * The couplet rewrite. The move every blind reader quoted first from every
 * Luna book — a short negated sentence answered by a short "It was …" — is
 * detectable by rule (`findCouplets`: opinion-fable-5 §2 counts it at 34–53
 * per thousand sentences on Luna against 4 on Gemini), and no prompt moved
 * it. This pass finds the pairs, sends only those to one line-edit call on
 * the writer's own model (the edit never goes to a second family), and
 * accepts a replacement only when the pattern is gone, every capitalised
 * word and number of the pair survives, and the length is within bounds. It
 * changes nothing else: the acceptance is what makes "only those sentences"
 * a property of the code.
 */
export const REWRITE_COUPLETS_PURPOSE = "rewrite-couplets";

export const COUPLET_MAX_PAIRS_PER_CHAPTER = 14;
const FIRST_MAX_WORDS = 18;
const SECOND_MAX_WORDS = 22;

const NEGATION = /\b(?:was|were|is|are|did|does|do|had|has|have|could|would|will|can)\s+not\b|\bn't\b|\bnever\b/i;
const SECOND_OPENER = /^(?:It|They|That|This|What|The|Its|Their|He|She|We)\b/;

export type Couplet = { id: string; paragraph: number; first: string; second: string };

function splitSentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?][”"’')\]]?)\s+(?=[A-Z“"‘'([])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function isCouplet(first: string, second: string): boolean {
  return (
    NEGATION.test(first) &&
    wordCount(first) <= FIRST_MAX_WORDS &&
    SECOND_OPENER.test(second) &&
    wordCount(second) <= SECOND_MAX_WORDS
  );
}

/** Every negation-then-assertion pair in the chapter, in order, at most one per sentence. */
export function findCouplets(markdown: string): Couplet[] {
  const couplets: Couplet[] = [];
  const paragraphs = markdown.split(/\n\s*\n/);
  paragraphs.forEach((paragraph, index) => {
    if (/^\s*(?:#|>|[-*]\s|\d+\.\s|```)/.test(paragraph)) return;
    const sentences = splitSentences(paragraph);
    let skip = false;
    for (let at = 0; at + 1 < sentences.length; at += 1) {
      if (skip) {
        skip = false;
        continue;
      }
      const first = sentences[at]!;
      const second = sentences[at + 1]!;
      if (isCouplet(first, second) && paragraph.includes(`${first} ${second}`)) {
        couplets.push({ id: `c${couplets.length + 1}`, paragraph: index, first, second });
        skip = true;
      }
    }
  });
  return couplets;
}

/** Sentences per thousand that open a couplet — the scorecard's reading of the same rule. */
export function coupletsPer1000Sentences(markdown: string): number {
  const total = markdown
    .split(/\n\s*\n/)
    .reduce((sum, paragraph) => sum + splitSentences(paragraph).length, 0);
  return total === 0 ? 0 : (findCouplets(markdown).length / total) * 1000;
}

function anchors(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b[A-Z][\p{L}’'-]+|\b\d[\d,.]*\b/gu)) {
    const token = match[0].replace(/[’']s$/, "");
    if (/^(?:It|They|That|This|What|The|Its|Their|He|She|We|A|An|But|And|In|On|At|By|For|To|Of|If|When|Where|While|Yet|So|As|Not|No|There|These|Those|Here|Then|Now)$/.test(token)) continue;
    found.add(token);
  }
  return found;
}

/**
 * Whether a replacement may stand in for the pair: no couplet of its own,
 * no bare antithesis on a semicolon, every anchor of the pair present,
 * between 0.6 and 1.6 times the pair's length, and prose (no list, no
 * heading, no quotation marks the pair did not have).
 */
export function acceptCoupletRewrite(couplet: Couplet, replacement: string): boolean {
  const text = replacement.replace(/\s+/g, " ").trim();
  if (!text) return false;
  const original = `${couplet.first} ${couplet.second}`;
  const originalWords = wordCount(original);
  const words = wordCount(text);
  if (words < originalWords * 0.6 || words > originalWords * 1.6) return false;
  const sentences = splitSentences(text);
  for (let at = 0; at + 1 < sentences.length; at += 1) {
    if (isCouplet(sentences[at]!, sentences[at + 1]!)) return false;
  }
  if (/;\s*(?:the other|the second|it)\b/i.test(text)) return false;
  if (/^\s*(?:#|>|[-*]\s|\d+\.\s)/.test(text)) return false;
  if (/[“”"]/.test(text) && !/[“”"]/.test(original)) return false;
  const required = anchors(original);
  const present = anchors(text);
  for (const anchor of required) {
    if (!present.has(anchor)) return false;
  }
  return true;
}

const rewriteSchema = z.object({
  rewrites: z.array(z.object({ id: z.string(), text: z.string() })).default([])
});

export type CoupletRewriteResult = { markdown: string; found: number; rewritten: number; changed: boolean };

export async function rewriteCouplets(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  chapter: ChapterPlan;
  markdown: string;
  textModel: TextModelAdapter;
  maxPairs?: number | undefined;
}): Promise<CoupletRewriteResult> {
  const all = findCouplets(options.markdown);
  if (all.length === 0) {
    return { markdown: options.markdown, found: 0, rewritten: 0, changed: false };
  }
  // The pairs are spread through the chapter rather than taken from its
  // head, so a chapter with forty gets every third one rewritten and the
  // cadence breaks everywhere rather than in the first section only.
  const cap = options.maxPairs ?? COUPLET_MAX_PAIRS_PER_CHAPTER;
  const stride = Math.max(1, Math.ceil(all.length / cap));
  const chosen = all.filter((_, index) => index % stride === 0).slice(0, cap);
  const result = await generateJsonWithRetry(options.textModel, {
    purpose: REWRITE_COUPLETS_PURPOSE,
    temperature: Math.min(0.7, options.input.temperature),
    maxTokens: 6000,
    schema: rewriteSchema,
    messages: [
      {
        role: "system",
        content: [
          `You are the line editor of "${options.plan.title}", working on chapter ${options.chapter.index}, "${options.chapter.title}". Each entry in pairs is two consecutive sentences from the chapter written as a negation answered by a correction ("X was not A. It was B.") — a cadence the chapter uses so often that readers hear it as a tic.`,
          "For each pair, write the same content as one or two sentences in a different shape: say what the thing was, did or meant directly, put the denied alternative in a subordinate clause or drop it if the sentence does not need it, and do not answer one negation with another. No 'not X but Y', no 'rather than', no semicolon balancing two halves, no rhetorical question. Keep every name, date, number and fact; add none. Match the register of the chapter; do not simplify.",
          "Return one JSON object shaped exactly like outputContract, one rewrite per pair id, text only.",
          ...targetLanguageGenerationGuidance(options.input.language)
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            language: targetLanguagePayload(options.input.language),
            pairs: chosen.map((couplet) => ({ id: couplet.id, first: couplet.first, second: couplet.second })),
            outputContract: { rewrites: [{ id: "c1", text: "" }] }
          },
          null,
          2
        )
      }
    ]
  });
  const byId = new Map(chosen.map((couplet) => [couplet.id, couplet]));
  const paragraphs = options.markdown.split(/\n\s*\n/);
  let rewritten = 0;
  for (const entry of result.data.rewrites) {
    const couplet = byId.get(entry.id.trim());
    if (!couplet || !acceptCoupletRewrite(couplet, entry.text)) continue;
    const paragraph = paragraphs[couplet.paragraph];
    if (paragraph === undefined) continue;
    const original = `${couplet.first} ${couplet.second}`;
    if (!paragraph.includes(original)) continue;
    paragraphs[couplet.paragraph] = paragraph.replace(original, entry.text.replace(/\s+/g, " ").trim());
    rewritten += 1;
  }
  const markdown = paragraphs.join("\n\n");
  return { markdown, found: all.length, rewritten, changed: rewritten > 0 };
}
