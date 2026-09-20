/**
 * Deterministic arithmetic over the numeric statements a chapter's math carries.
 *
 * The 100-page Balanced cryptography book (2026-09-19) printed a worked RSA decryption whose
 * four intermediate residues were all wrong (128^2 ≡ 169 (mod 187); it is 115) under a correct
 * final answer, and no gate could see it: the editor preserves numbers, the acceptance judge
 * compares meaning, local QA is lexical, and the claim verifier reads research notes. Every
 * statement here is checkable without a model, so this module checks it and hands the exact
 * computation to the chapter repair as a factual correction.
 *
 * Grammar: integer literals, `+ - \cdot \times *`, implicit products (`128^{16}128^4`), `^`,
 * parentheses, `\gcd(a,b)`, `\varphi(n)`, `X \bmod n`, `X \pmod{n}` before a relation, and the
 * relations `=` (exact) and `\equiv` (modulo the trailing `\pmod{n}`). A statement with a
 * variable, a decimal, an inequality, an ellipsis or any other command is symbolic and skipped;
 * only a fully numeric statement can be wrong here. Measured on the book that motivated it:
 * 83 numeric statements, four findings, all of them the real error.
 *
 * The modulus is often stated once in the prose and then left out of every statement it governs:
 * "with arithmetic modulo 23, one can calculate \(5^2=2\), \(5^3=10\), \(5^4=4\)". Read alone,
 * each of those is wrong integer arithmetic; read under the section's modulus, all three hold.
 * The second 100-page book flagged exactly that sentence and paid for a repair of correct prose,
 * so a statement is checked under every modulus its section mentions (`modulo 23`, `mod 23`,
 * `\pmod{23}`, `\bmod 23`, `the modulus n = 187`) before it is called wrong. A section that
 * speaks of modular arithmetic without ever naming a number cannot be checked at all, so its
 * failing equalities are skipped: the checker may miss an error, never invent one.
 */
export type ArithmeticFinding = {
  /** The statement exactly as it stands inside its delimiters, for matching against page text. */
  quote: string;
  /** What the statement claims, what it evaluates to, and the value that would make it true. */
  reason: string;
};

/** A safe exact-power ceiling: `a^b` is evaluated exactly only while it fits in this many bits. */
const MAX_EXACT_POWER_BITS = 20_000;
const MAX_TOTIENT_ARGUMENT = 1_000_000_000n;

type Token =
  | { kind: "int"; value: bigint }
  | { kind: "op"; value: "+" | "-" | "*" | "^" | "(" | ")" | "{" | "}" | "," }
  | { kind: "rel"; value: "=" | "≡" }
  | { kind: "mod" }
  | { kind: "pmod" }
  | { kind: "fn"; value: "gcd" | "phi" };

class Unsupported extends Error {}

const DELIMITED = /\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$\$([\s\S]+?)\$\$|(?<![\\$\w])\$([^$\n]+?)\$(?!\w)/g;
const HEADING_LINE = /^[ \t]{0,3}#{1,6}[ \t]/m;
/** A modulus named in prose or math: `modulo 23`, `mod 23`, `(mod 23)`, `\pmod{23}`, `\bmod 23`, `the modulus n = 187`. */
const NAMED_MODULUS = /(?:\\pmod\s*\{?\s*|\\bmod\s*|\bmod(?:ulo|ulus)?\b(?:\s*(?:is|of|equals|the|a|prime|composite|number|modulus|\\\(|\(|[A-Za-z]\s*=))*\s*)(\d{1,40})\b/gi;
const MODULAR_LANGUAGE = /\\pmod|\\bmod|\bmod(?:ulo|ulus|ular)?\b|\bcongruen|\bresidue/i;

/**
 * What a section establishes about its arithmetic: the moduli it names, and whether it speaks of
 * modular arithmetic at all. A section is the run of text under one heading; a chapter without
 * headings is one section.
 */
export type ArithmeticScope = {
  /** Every modulus named in the section, each read under before an equality is called wrong. */
  moduli: bigint[];
  /** The section mentions modular arithmetic — with or without naming a modulus. */
  modular: boolean;
};

const NO_SCOPE: ArithmeticScope = { moduli: [], modular: false };

/** Every numeric statement in `markdown` whose arithmetic does not hold under its section's scope. */
export function arithmeticFindings(markdown: string): ArithmeticFinding[] {
  const findings: ArithmeticFinding[] = [];
  const reported = new Set<string>();
  for (const section of sectionsOf(markdown)) {
    const scope = arithmeticScope(section);
    for (const match of section.matchAll(DELIMITED)) {
      const raw = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim();
      if (!raw || reported.has(raw)) continue;
      const reason = checkStatement(raw, scope);
      if (!reason) continue;
      reported.add(raw);
      findings.push({ quote: raw, reason });
    }
  }
  return findings;
}

/** The scope a run of text establishes for the statements inside it. */
export function arithmeticScope(text: string): ArithmeticScope {
  const moduli = new Set<bigint>();
  for (const match of text.matchAll(NAMED_MODULUS)) {
    const modulus = BigInt(match[1]!);
    if (modulus >= 2n) moduli.add(modulus);
  }
  return { moduli: [...moduli], modular: MODULAR_LANGUAGE.test(text) };
}

function sectionsOf(markdown: string): string[] {
  const sections: string[] = [];
  let start = 0;
  const headings = new RegExp(HEADING_LINE.source, "gm");
  for (const match of markdown.matchAll(headings)) {
    if (match.index > start) sections.push(markdown.slice(start, match.index));
    start = match.index;
  }
  sections.push(markdown.slice(start));
  return sections.filter((section) => section.trim().length > 0);
}

/**
 * `undefined` when the statement holds, holds under a modulus in scope, or is not fully numeric;
 * otherwise why it fails.
 */
export function checkStatement(statement: string, scope: ArithmeticScope = NO_SCOPE): string | undefined {
  let tokens: Token[];
  try { tokens = tokenize(statement); } catch (error) { if (error instanceof Unsupported) return undefined; throw error; }
  if (!tokens.some((token) => token.kind === "rel")) return undefined;
  // A trailing \pmod{n} sets the modulus every ≡ in the chain is read under.
  let modulus: bigint | undefined;
  const lastPmod = tokens.reduce((last, token, index) => (token.kind === "pmod" ? index : last), -1);
  if (lastPmod >= 0 && !tokens.slice(lastPmod + 1).some((token) => token.kind === "rel")) {
    try { modulus = new Parser(tokens.slice(lastPmod + 1)).parseAll(); } catch (error) { if (error instanceof Unsupported) return undefined; throw error; }
    tokens = tokens.slice(0, lastPmod);
    if (modulus <= 0n) return undefined;
  }
  // Split the chain on relations; the segments are evaluated left to right.
  const segments: Array<{ tokens: Token[]; relation: "=" | "≡" | undefined }> = [];
  let current: Token[] = [];
  let relation: "=" | "≡" | undefined;
  for (const token of tokens) {
    if (token.kind === "rel") { segments.push({ tokens: current, relation }); current = []; relation = token.value; }
    else current.push(token);
  }
  segments.push({ tokens: current, relation });
  if (segments.some((segment) => segment.tokens.length === 0)) return undefined;
  let values: bigint[];
  try { values = segments.map((segment) => new Parser(segment.tokens).parseAll()); } catch (error) { if (error instanceof Unsupported) return undefined; throw error; }
  for (let index = 1; index < segments.length; index += 1) {
    const left = values[index - 1]!, right = values[index]!;
    const rel = segments[index]!.relation!;
    const lhs = render(segments[index - 1]!.tokens), rhs = render(segments[index]!.tokens);
    if (rel === "≡") {
      if (modulus !== undefined) {
        if (mod(left, modulus) !== mod(right, modulus)) {
          return `${lhs} ≡ ${mod(left, modulus)} (mod ${modulus}), but the statement gives ${rhs}${right === mod(right, modulus) ? "" : ` ≡ ${mod(right, modulus)}`}.`;
        }
        continue;
      }
      // No modulus of its own: a congruence is read under the section's, and unreadable without one.
      if (scope.moduli.length === 0 || congruentUnderSome(left, right, scope.moduli)) return undefined;
      return `${residuesOf(lhs, left, scope.moduli)}, but the statement gives ${rhs}.`;
    }
    if (left === right) continue;
    // A failing equality inside a modular section may be a congruence with the modulus left unsaid —
    // but only a modulus the right-hand side is a residue of; `2^{10}=1000` is not excused by parity.
    const residueModuli = scope.moduli.filter((candidate) => right >= 0n && right < candidate);
    if (congruentUnderSome(left, right, residueModuli)) continue;
    if (scope.modular && scope.moduli.length === 0) return undefined;
    const value = `${lhs} = ${left}`;
    return `${residueModuli.length ? `${value}, ${residuesOf(undefined, left, residueModuli)}` : value}, but the statement gives ${rhs}${isLiteral(segments[index]!.tokens) ? "" : ` = ${right}`}.`;
  }
  return undefined;
}

function congruentUnderSome(left: bigint, right: bigint, moduli: bigint[]): boolean {
  return moduli.some((modulus) => mod(left, modulus) === mod(right, modulus));
}

/** `128^2 ≡ 115 (mod 187)`, or `which is ≡ 115 (mod 187)` when the subject was already named. */
function residuesOf(subject: string | undefined, value: bigint, moduli: bigint[]): string {
  const residues = moduli.map((modulus) => `${mod(value, modulus)} (mod ${modulus})`).join(" and ");
  return subject === undefined ? `which is ≡ ${residues}` : `${subject} ≡ ${residues}`;
}

function isLiteral(tokens: Token[]): boolean { return tokens.length === 1 && tokens[0]!.kind === "int"; }

function render(tokens: Token[]): string {
  let text = "";
  let previous: Token | undefined;
  for (const token of tokens) {
    const opensFactor = token.kind === "int" || token.kind === "fn" || (token.kind === "op" && (token.value === "(" || token.value === "{"));
    const closesFactor = previous && (previous.kind === "int" || (previous.kind === "op" && (previous.value === ")" || previous.value === "}")));
    if (opensFactor && closesFactor) text += "·";
    switch (token.kind) {
      case "int": text += token.value.toString(); break;
      case "op": text += token.value === "*" ? "·" : token.value; break;
      case "rel": text += token.value; break;
      case "mod": case "pmod": text += " mod "; break;
      case "fn": text += token.value === "gcd" ? "gcd" : "φ"; break;
    }
    previous = token;
  }
  return text.replace(/\{|\}/g, "");
}

function tokenize(statement: string): Token[] {
  const source = statement
    .replace(/\\(left|right|,|;|!|quad|qquad|displaystyle|mathrm|text|operatorname)\b/g, " ")
    .replace(/\\ /g, " ").replace(/~/g, " ").replace(/[.,;]\s*$/, "");
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s/.test(char)) { index += 1; continue; }
    if (/\d/.test(char)) {
      const digits = /^\d+/.exec(source.slice(index))![0];
      if (source[index + digits.length] === ".") throw new Unsupported("decimal");
      tokens.push({ kind: "int", value: BigInt(digits) });
      index += digits.length;
      continue;
    }
    if (char === "\\") {
      const command = /^\\([A-Za-z]+)/.exec(source.slice(index));
      if (!command) throw new Unsupported("command");
      index += command[0].length;
      switch (command[1]) {
        case "cdot": case "times": tokens.push({ kind: "op", value: "*" }); break;
        case "equiv": tokens.push({ kind: "rel", value: "≡" }); break;
        case "bmod": tokens.push({ kind: "mod" }); break;
        case "pmod": tokens.push({ kind: "pmod" }); break;
        case "gcd": tokens.push({ kind: "fn", value: "gcd" }); break;
        case "varphi": case "phi": tokens.push({ kind: "fn", value: "phi" }); break;
        default: throw new Unsupported(command[1]!);
      }
      continue;
    }
    if ("+-*^(){},".includes(char)) { tokens.push({ kind: "op", value: char as "+" | "-" | "*" | "^" | "(" | ")" | "{" | "}" | "," }); index += 1; continue; }
    if (char === "=") { tokens.push({ kind: "rel", value: "=" }); index += 1; continue; }
    if (char === "≡") { tokens.push({ kind: "rel", value: "≡" }); index += 1; continue; }
    if (char === "×" || char === "·") { tokens.push({ kind: "op", value: "*" }); index += 1; continue; }
    // A single-letter name leading the chain (`A = 5^6 \bmod 23 = 8`) is a definition of the rest.
    if (/[A-Za-z]/.test(char) && tokens.length === 0 && /^[A-Za-z](_\{?\w\}?)?\s*=/.test(source.slice(index))) {
      index += /^[A-Za-z](_\{?\w\}?)?\s*/.exec(source.slice(index))![0].length;
      continue;
    }
    throw new Unsupported(char);
  }
  return tokens;
}

class Parser {
  private index = 0;
  constructor(private readonly tokens: Token[]) {}

  parseAll(): bigint {
    const value = this.parseModded();
    if (this.index !== this.tokens.length) throw new Unsupported("trailing");
    return value;
  }

  private peek(): Token | undefined { return this.tokens[this.index]; }
  private take(): Token { const token = this.tokens[this.index]; if (!token) throw new Unsupported("end"); this.index += 1; return token; }
  private isOp(value: string): boolean { const token = this.peek(); return token?.kind === "op" && token.value === value; }

  /** `X \bmod n`, or `X \pmod{n}` standing before a relation, reduces X. */
  private parseModded(): bigint {
    let value = this.parseSum();
    while (this.peek()?.kind === "mod" || this.peek()?.kind === "pmod") {
      this.take();
      const modulus = this.parseSum();
      if (modulus <= 0n) throw new Unsupported("modulus");
      value = mod(value, modulus);
    }
    return value;
  }

  private parseSum(): bigint {
    let value = this.parseProduct();
    while (this.isOp("+") || this.isOp("-")) {
      const op = (this.take() as { value: string }).value;
      const right = this.parseProduct();
      value = op === "+" ? value + right : value - right;
    }
    return value;
  }

  private parseProduct(): bigint {
    let value = this.parsePower();
    for (;;) {
      if (this.isOp("*")) { this.take(); value *= this.parsePower(); continue; }
      const next = this.peek();
      // Implicit multiplication: a factor directly after a factor.
      if (next && (next.kind === "int" || next.kind === "fn" || (next.kind === "op" && (next.value === "(" || next.value === "{")))) { value *= this.parsePower(); continue; }
      return value;
    }
  }

  private parsePower(): bigint {
    const base = this.parseAtom();
    if (!this.isOp("^")) return base;
    this.take();
    const exponent = this.isOp("{") ? this.parseGroup("{", "}") : this.parseAtom();
    if (exponent < 0n) throw new Unsupported("negative exponent");
    const bits = base === 0n || base === 1n || base === -1n ? 1 : Number(exponent) * Math.log2(Math.abs(Number(base)));
    if (!Number.isFinite(bits) || bits > MAX_EXACT_POWER_BITS) throw new Unsupported("power too large");
    return base ** exponent;
  }

  private parseAtom(): bigint {
    const token = this.take();
    if (token.kind === "int") return token.value;
    if (token.kind === "op" && token.value === "-") return -this.parseAtom();
    if (token.kind === "op" && token.value === "+") return this.parseAtom();
    if (token.kind === "op" && token.value === "(") { this.index -= 1; return this.parseGroup("(", ")"); }
    if (token.kind === "op" && token.value === "{") { this.index -= 1; return this.parseGroup("{", "}"); }
    if (token.kind === "fn") {
      if (!this.isOp("(") && !this.isOp("{")) throw new Unsupported("function argument");
      const close = this.isOp("(") ? ")" : "}";
      this.take();
      const first = this.parseSum();
      if (token.value === "gcd") {
        if (!this.isOp(",")) throw new Unsupported("gcd arity");
        this.take();
        const second = this.parseSum();
        this.expect(close);
        return gcd(first, second);
      }
      this.expect(close);
      return totient(first);
    }
    throw new Unsupported("atom");
  }

  private parseGroup(open: string, close: string): bigint {
    this.expect(open);
    const value = this.parseModded();
    this.expect(close);
    return value;
  }

  private expect(value: string): void {
    if (!this.isOp(value)) throw new Unsupported(`expected ${value}`);
    this.take();
  }
}

function mod(value: bigint, modulus: bigint): bigint { const result = value % modulus; return result < 0n ? result + modulus : result; }

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a, y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** Euler's totient by trial division, for arguments small enough to factor instantly. */
function totient(n: bigint): bigint {
  if (n <= 0n || n > MAX_TOTIENT_ARGUMENT) throw new Unsupported("totient argument");
  let remaining = n, result = n;
  for (let p = 2n; p * p <= remaining; p += 1n) {
    if (remaining % p !== 0n) continue;
    while (remaining % p === 0n) remaining /= p;
    result -= result / p;
  }
  if (remaining > 1n) result -= result / remaining;
  return result;
}
