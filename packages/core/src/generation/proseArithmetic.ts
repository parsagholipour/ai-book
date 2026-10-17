import type { ArithmeticFinding } from "./arithmeticCheck.js";

/**
 * Code checks of a numeric statement in a chapter's prose. The model that used to propose these
 * (`check-chapter-arithmetic`, gate `proseArithmeticCheck`) was removed on 2026-10-16 (E4,
 * `.scratch/eval-data/reports/e4-review-audit.md`): over the 48 Quick Draft and Balanced books it
 * checked (324 chapters) it proposed 19 errors, code verified 6 in 5 books, 4 books' were real
 * (8%), and the intent confirmation turned every one of them down, so it fixed nothing — under
 * the owner's rule a defect screen stays only if it fixes real reader-visible defects in at least
 * 10% of books. `verifiedFinding` and `evaluateExpression` remain because the compile re-checks a
 * stored residual's computation against the chapter as it now stands (`composedEvidenceResiduals`).
 */

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
