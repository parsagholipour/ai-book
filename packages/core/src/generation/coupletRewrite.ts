import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import { targetLanguageGenerationGuidance, targetLanguagePayload } from "../prompting/language.js";
import type { BookPlan, ChapterPlan, CreateProjectInput } from "../schemas/book.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";

/**
 * The antithesis rewrite. The move every blind reader quoted first from every
 * Luna book is a claim balanced by its own retraction, and it has four shapes:
 * the classic couplet (`findCouplets`: opinion-fable-5 §2 counts it at 34–53
 * per thousand sentences on Luna against 4 on Gemini), the assertion answered
 * by a retraction in the next sentence, the same pair folded onto a semicolon,
 * and "X can show A without proving B". The 2026-09-06 prototype counts the
 * three new kinds at 18 per 1,000 sentences on the fresh-plan books against
 * 6.5 at rung 5, and no prompt moved any of them. This pass finds the hits,
 * sends only those to one line-edit call on the writer's own model (the edit
 * never goes to a second family), and accepts a replacement only when the
 * pattern is gone, every capitalised word and number survives, and the length
 * is within bounds. It changes nothing else: the acceptance is what makes
 * "only those sentences" a property of the code.
 *
 * "Neither … nor" and "not only … but" were measured too and dropped: they
 * carry false positives ("neither snow, rain, heat nor darkness"; "neither the
 * map nor the missile").
 */
export const REWRITE_COUPLETS_PURPOSE = "rewrite-couplets";

export const COUPLET_MAX_PAIRS_PER_CHAPTER = 12;
const FIRST_MAX_WORDS = 18;
const SECOND_MAX_WORDS = 22;
/** The assert-then-retract pair runs longer than the classic couplet on both sides. */
const RETRACT_FIRST_MAX_WORDS = 28;
const RETRACT_SECOND_MAX_WORDS = 26;

const NEGATION = /\b(?:was|were|is|are|did|does|do|had|has|have|could|would|will|can)\s+not\b|\bn't\b|\bnever\b/i;
const SECOND_OPENER = /^(?:It|They|That|This|What|The|Its|Their|He|She|We)\b/;
/** The second half of an assert-then-retract pair: a bare subject that takes the claim back. */
const RETRACTION_OPENER =
  /^(?:It|They|That|This|What it|What they|The (?:record|evidence|bones|text|document|site|sources?))\s+(?:(?:does|did|do|is|was|are|were|can|could|will|would|has|have)\s+not|cannot|can't|rarely|never|seldom)\b/;
/** The same retraction folded onto a semicolon inside one sentence. */
const SEMICOLON_RETRACTION =
  /;\s*(?:it|they|that|this|the other|the second)\s+(?:(?:does|did|do|is|was|are|were|can|could|will|would|had|has|have)\s+not|cannot|can't|rarely|never|seldom|hardly)\b/i;
/** "The evidence can support A without proving B": the retraction as a subordinate clause. */
const WITHOUT_PROVING =
  /\b(?:can|could|may|might|does|do|did|will)\b[^.;:!?]{0,90}\bwithout\s+(?:establishing|proving|showing|settling|determining|telling|revealing|explaining|demonstrating|implying|supplying)\b/i;

export type CoupletKind = "classic" | "assertRetract" | "semicolonRetract" | "withoutProving";

export type Couplet = {
  id: string;
  paragraph: number;
  kind: CoupletKind;
  /** The exact span to replace: both sentences for a pair, the sentence itself otherwise. */
  text: string;
  first: string;
  /** Empty for the one-sentence kinds. */
  second: string;
};

/** The couplet detector's own sentence split, shared with `disclaimerCap.ts`; named apart from `proseMeasurements`' export. */
export function splitCoupletSentences(paragraph: string): string[] {
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

/** An assertion, then its retraction: the mirror of the classic couplet. */
export function isAssertRetract(first: string, second: string): boolean {
  return (
    !NEGATION.test(first) &&
    wordCount(first) <= RETRACT_FIRST_MAX_WORDS &&
    RETRACTION_OPENER.test(second) &&
    wordCount(second) <= RETRACT_SECOND_MAX_WORDS
  );
}

/**
 * Every antithesis in the chapter, in order, at most one hit per sentence and
 * the earliest kind winning. Prose paragraphs only: a heading, a quotation, a
 * list item and a fence are read past.
 */
export function findCouplets(markdown: string): Couplet[] {
  const couplets: Couplet[] = [];
  const paragraphs = markdown.split(/\n\s*\n/);
  paragraphs.forEach((paragraph, index) => {
    if (/^\s*(?:#|>|[-*]\s|\d+\.\s|```)/.test(paragraph)) return;
    const sentences = splitCoupletSentences(paragraph);
    const push = (kind: CoupletKind, text: string, first: string, second: string) => {
      couplets.push({ id: `c${couplets.length + 1}`, paragraph: index, kind, text, first, second });
    };
    let at = 0;
    while (at < sentences.length) {
      const first = sentences[at]!;
      const second = at + 1 < sentences.length ? sentences[at + 1]! : undefined;
      const pair = second ? `${first} ${second}` : undefined;
      if (second && pair && paragraph.includes(pair) && isCouplet(first, second)) {
        push("classic", pair, first, second);
        at += 2;
        continue;
      }
      if (second && pair && paragraph.includes(pair) && isAssertRetract(first, second)) {
        push("assertRetract", pair, first, second);
        at += 2;
        continue;
      }
      if (SEMICOLON_RETRACTION.test(first)) {
        push("semicolonRetract", first, first, "");
      } else if (WITHOUT_PROVING.test(first)) {
        push("withoutProving", first, first, "");
      }
      at += 1;
    }
  });
  return couplets;
}

function sentenceCount(markdown: string): number {
  return markdown.split(/\n\s*\n/).reduce((sum, paragraph) => sum + splitCoupletSentences(paragraph).length, 0);
}

/** Sentences per thousand that open a classic couplet — the scorecard's series, unchanged. */
export function coupletsPer1000Sentences(markdown: string): number {
  const total = sentenceCount(markdown);
  return total === 0 ? 0 : (findCouplets(markdown).filter((couplet) => couplet.kind === "classic").length / total) * 1000;
}

/** The same reading over every kind: the claim-and-retraction rate of the chapter. */
export function antithesesPer1000Sentences(markdown: string): number {
  const total = sentenceCount(markdown);
  return total === 0 ? 0 : (findCouplets(markdown).length / total) * 1000;
}

/** Capitalised words and numbers that must survive a rewrite, minus the sentence-opening function words; shared with `disclaimerCap.ts`. */
export function coupletAnchors(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b[A-Z][\p{L}’'-]+|\b\d[\d,.]*\b/gu)) {
    const token = match[0].replace(/[’']s$/, "");
    if (/^(?:It|They|That|This|What|The|Its|Their|He|She|We|A|An|But|And|In|On|At|By|For|To|Of|If|When|Where|While|Yet|So|As|Not|No|There|These|Those|Here|Then|Now)$/.test(token)) continue;
    found.add(token);
  }
  return found;
}

/**
 * The shapes a pair collapses into when the model folds two sentences into
 * one and loses the sense: a trailing relative clause carrying the second
 * sentence's content ("…, whose evidence required interpretation beyond
 * sentences"), or a participial tail standing in for the negation ("with no
 * speaking", "doing no"). Readers of three books named those sentences as
 * garbled while every anchor of the original was still present, so the
 * anchors are not the whole of the acceptance.
 */
const FOLDED_RELATIVE_TAIL = /,\s+(?:whose|which|and which|and whose)\s/i;
const PARTICIPIAL_STAND_IN = /\sdoing no\s|\swith no \w+ing\b/i;
/** A single folded sentence longer than this is the collapse, not a rewrite. */
const FOLDED_SENTENCE_MAX_WORDS = 30;
const SENTENCE_TERMINATOR = /[.!?…؟。][”"’')\]]?$/u;
/** A sentence that stops on the word before its own content. */
const DANGLING_TAIL = /\b(?:whose|which|that|of|to|with|and|but|for|in|on|by)\s*[.!?…؟。][”"’')\]]?$/iu;

/**
 * Whether a replacement may stand in for the hit: no antithesis of its own in
 * any of the four shapes, no bare balancing on a semicolon, no folded relative
 * clause where a second sentence was, every anchor of the original present,
 * between 0.6 and 1.6 times its length, and prose (no list, no heading, no
 * quotation marks the original did not have) that ends on a finished sentence.
 */
export function acceptCoupletRewrite(couplet: Couplet, replacement: string): boolean {
  const text = replacement.replace(/\s+/g, " ").trim();
  if (!text) return false;
  const original = couplet.text;
  const originalWords = wordCount(original);
  const words = wordCount(text);
  if (words < originalWords * 0.6 || words > originalWords * 1.6) return false;
  const sentences = splitCoupletSentences(text);
  for (let at = 0; at + 1 < sentences.length; at += 1) {
    if (isCouplet(sentences[at]!, sentences[at + 1]!)) return false;
    if (isAssertRetract(sentences[at]!, sentences[at + 1]!)) return false;
  }
  if (SEMICOLON_RETRACTION.test(text) || WITHOUT_PROVING.test(text)) return false;
  if (PARTICIPIAL_STAND_IN.test(text)) return false;
  // A pair folded into one long sentence, its second half hung on a relative clause.
  if (couplet.second && sentences.length <= 1) {
    if (words > FOLDED_SENTENCE_MAX_WORDS) return false;
    if (FOLDED_RELATIVE_TAIL.test(text)) return false;
  }
  const last = sentences.at(-1) ?? text;
  if (!SENTENCE_TERMINATOR.test(last) || DANGLING_TAIL.test(last)) return false;
  if (/;\s*(?:the other|the second|it)\b/i.test(text)) return false;
  if (/^\s*(?:#|>|[-*]\s|\d+\.\s)/.test(text)) return false;
  if (/[“”"]/.test(text) && !/[“”"]/.test(original)) return false;
  const required = coupletAnchors(original);
  const present = coupletAnchors(text);
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
          `You are the line editor of "${options.plan.title}", working on chapter ${options.chapter.index}, "${options.chapter.title}". Each entry in pairs is a passage from the chapter — two consecutive sentences, or one sentence — written as a claim balanced by its own retraction ("X was not A. It was B."; "X does A. It does not do B."; "X does A; it does not do B."; "X can show A without showing B") — a cadence the chapter uses so often that readers hear it as a tic.`,
          "For each entry, write the same content as one or two sentences in a different shape: say what the thing was, did or meant directly, put the denied alternative in a subordinate clause or drop it if the sentence does not need it, and do not answer one claim with its retraction. No 'not X but Y', no 'rather than', no semicolon balancing two halves, no rhetorical question, no 'without proving/showing/establishing'. Keep every name, date, number and fact; add none. Match the register of the chapter; do not simplify.",
          "Return one JSON object shaped exactly like outputContract, one rewrite per pair id, text only.",
          ...targetLanguageGenerationGuidance(options.input.language)
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            language: targetLanguagePayload(options.input.language),
            pairs: chosen.map((couplet) => ({
              id: couplet.id,
              kind: couplet.kind,
              text: couplet.text,
              ...(couplet.second ? { first: couplet.first, second: couplet.second } : {})
            })),
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
    if (!paragraph.includes(couplet.text)) continue;
    paragraphs[couplet.paragraph] = paragraph.replace(couplet.text, entry.text.replace(/\s+/g, " ").trim());
    rewritten += 1;
  }
  const markdown = paragraphs.join("\n\n");
  return { markdown, found: all.length, rewritten, changed: rewritten > 0 };
}
