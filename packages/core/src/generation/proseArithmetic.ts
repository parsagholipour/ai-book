import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import { isCancellationError } from "../adapters/retry.js";
import { targetLanguageGenerationGuidance } from "../prompting/language.js";
import type { ArithmeticFinding } from "./arithmeticCheck.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";

/**
 * The arithmetic a chapter does in its prose — a balance, a total, a rate, a
 * "fold" — which `arithmeticFindings` cannot see, since it reads only
 * delimited math. A workbook told its reader that $800 less $1,200 rent and
 * $110 electricity "leaves only $290", a history called $5.86 against 16 cents
 * a "39-fold saving", a guide converted a quarterly bill to monthly by
 * dividing by four; blind readers caught each one (2026-09-30).
 *
 * A model proposes and code decides: every proposed error carries the exact
 * computation from the chapter's own numbers, and it is kept only when its
 * quote is in the chapter, carries the stated number, and the computation,
 * evaluated here, disagrees with it beyond rounding. Unconfirmed intent remains
 * review-only evidence and cannot authorize a numeric replacement. Only the
 * obvious kind is asked for: no assumptions, estimates or outside facts.
 */
export const CHECK_CHAPTER_ARITHMETIC_PURPOSE = "check-chapter-arithmetic";

/** A chapter with fewer numbers than this has no worked arithmetic worth a call. */
const MIN_NUMBERS = 4;
const MAX_ERRORS = 12;

const replySchema = z.object({
  errors: z.array(z.object({
    quote: z.string(),
    expression: z.string(),
    stated: z.union([z.number(), z.string()])
  }).passthrough()).max(40).default([])
}).passthrough();

export async function proseArithmeticFindings(options: { markdown: string; textModel: TextModelAdapter; language?: string | undefined }): Promise<ArithmeticFinding[]> {
  if ((options.markdown.match(/\d[\d,.]*/g) ?? []).length < MIN_NUMBERS) return [];
  const reply = await generateJsonWithRetry(options.textModel, {
    purpose: CHECK_CHAPTER_ARITHMETIC_PURPOSE,
    temperature: 0,
    maxTokens: 2000,
    schema: replySchema,
    messages: [
      {
        role: "system",
        content: [
          "You check the arithmetic a book chapter does in its prose: totals, differences, remaining balances, products, averages, percentages, rates, unit conversions and ratios computed from numbers the chapter itself states.",
          "Report only a result that is plainly wrong given numbers stated in the chapter. For each: quote — the words that state the wrong result, copied exactly from the chapter, six to thirty words; expression — the computation from the chapter's own numbers, using only digits, a decimal point, + - * / and parentheses; stated — the number the chapter gives as the result.",
          "Do not report a figure given as approximate that is within rounding, an assumption, an estimate, a fact about the world, or a result whose inputs the chapter does not state. When every computation holds, return errors as an empty array.",
          "Return one JSON object: {\"errors\": [{\"quote\": \"\", \"expression\": \"\", \"stated\": 0}]}.",
          ...targetLanguageGenerationGuidance(options.language ?? "en")
        ].join(" ")
      },
      { role: "user", content: JSON.stringify({ chapter: options.markdown }) }
    ]
  });
  const findings: ArithmeticFinding[] = [];
  for (const proposal of reply.data.errors) {
    const finding = verifiedFinding(options.markdown, proposal.quote, proposal.expression, proposal.stated);
    if (!finding || findings.some((kept) => kept.quote === finding.quote)) continue;
    // Code can check the arithmetic and not whether the expression is what the sentence computes:
    // replayed over 32 stored chapters, one proposal paired "$300 left" with the wrong subtraction.
    let confirmed = false;
    try { confirmed = await sentenceStatesComputation(options, finding.quote, proposal.expression); }
    catch (error) { if (isCancellationError(error)) throw error; }
    findings.push(confirmed ? finding : {
      ...finding,
      reason: `Check whether this statement uses the proposed calculation: ${finding.reason} The intent check did not confirm the connection; do not automatically replace the number.`,
      reviewOnly: true
    });
    if (findings.length === MAX_ERRORS) break;
  }
  return findings;
}

/**
 * The passage around the quote, read once more for intent alone: is its number meant as the
 * result of exactly this computation? Told to judge correctness as well, the confirmation
 * reasoned "800 − 1,200 − 110 is not 290, so the sentence cannot mean that" and turned down
 * every real error; shown the quote's paragraph alone, it missed figures stated a paragraph
 * earlier. So it is shown the two paragraphs before it too, and told to ignore the arithmetic.
 */
async function sentenceStatesComputation(options: { markdown: string; textModel: TextModelAdapter }, quote: string, expression: string): Promise<boolean> {
  const paragraphs = options.markdown.split(/\n\s*\n/);
  const at = paragraphs.findIndex((block) => flat(block).includes(flat(quote)));
  const passage = at < 0 ? quote : paragraphs.slice(Math.max(0, at - 2), at + 1).join("\n\n");
  const reply = await generateJsonWithRetry(options.textModel, {
    purpose: CHECK_CHAPTER_ARITHMETIC_PURPOSE,
    temperature: 0,
    maxTokens: 400,
    schema: z.object({ states: z.boolean() }).passthrough(),
    messages: [
      { role: "system", content: "You are shown a passage, a quote from it, and a computation. Decide only whether the quote's number is meant as the result of that computation — the same figures from the passage, combined the same way — as a careful reader would take it. Do not judge whether the arithmetic is right: a wrong result can still be meant as that computation. Answer false when the number refers to something else or other figures. Return {\"states\": true} or {\"states\": false}." },
      { role: "user", content: JSON.stringify({ passage, quote, computation: expression }) }
    ]
  });
  return reply.data.states === true;
}

const flat = (text: string) => text.replace(/[‘’]/g, "'").replace(/[“”]/g, "\"").replace(/[‐‑–—−]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();

/** A proposed error that survives code: quoted from the chapter, carrying the stated number, and wrong by the computation. */
export function verifiedFinding(markdown: string, quote: string, expression: string, stated: number | string): ArithmeticFinding | undefined {
  const quoted = quote.trim();
  if (quoted.split(/\s+/).length < 3 || !flat(markdown).includes(flat(quoted))) return undefined;
  const statedText = String(stated).trim();
  const statedValue = Number(statedText.replace(/[^\d.-]/g, ""));
  // A result spelled in words ("six feet ten and a half inches") is not a number to compare.
  if (!/\d/.test(statedText) || !Number.isFinite(statedValue)) return undefined;
  const digits = String(Math.abs(statedValue)).replace(/^0+(?=\d)/, "");
  if (!quoted.replace(/,/g, "").includes(digits)) return undefined;
  const value = evaluateExpression(expression);
  if (value === undefined) return undefined;
  const approximate = /\b(about|around|roughly|approximately|nearly|almost|some)\b|~|≈/i.test(quoted);
  const decimals = (digits.split(".")[1] ?? "").length;
  const tolerance = Math.max(Math.abs(value) * (approximate ? 0.02 : 0.005), 0.5 * 10 ** -decimals);
  if (Math.abs(value - statedValue) <= tolerance) return undefined;
  return { quote: quoted, reason: `${expression.trim()} = ${formatNumber(value)}, not ${statedText}.` };
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

/** `+ - * /`, parentheses and decimals over literals, nothing else; undefined for anything it cannot read. */
export function evaluateExpression(expression: string): number | undefined {
  const source = expression.replace(/[×x]/g, "*").replace(/÷/g, "/").replace(/−/g, "-").replace(/(\d),(?=\d{3}\b)/g, "$1");
  if (!/^[\d\s.+\-*/()]+$/.test(source) || source.length > 200) return undefined;
  const tokens = source.match(/\d+(?:\.\d+)?|[+\-*/()]/g) ?? [];
  let position = 0;
  const peek = () => tokens[position];
  const expressionValue = (): number => {
    let value = term();
    while (peek() === "+" || peek() === "-") value = tokens[position++] === "+" ? value + term() : value - term();
    return value;
  };
  const term = (): number => {
    let value = factor();
    while (peek() === "*" || peek() === "/") value = tokens[position++] === "*" ? value * factor() : value / factor();
    return value;
  };
  const factor = (): number => {
    const token = tokens[position++];
    if (token === "-") return -factor();
    if (token === "(") {
      const value = expressionValue();
      if (tokens[position++] !== ")") throw new Error("unbalanced");
      return value;
    }
    const value = Number(token);
    if (token === undefined || !Number.isFinite(value)) throw new Error("not a number");
    return value;
  };
  try {
    const value = expressionValue();
    return position === tokens.length && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
