import { randomUUID } from "node:crypto";
import { convertToXmlComponent, ImportedXmlComponent } from "docx";
import { Marked, type Token, type Tokens } from "marked";
import { mml2omml } from "mathml2omml-plus";
import { js2xml, xml2js, type Element } from "xml-js";
import { renderMathMl, replaceMarkdownMath, type MarkdownMath } from "./markdownMath.js";

export type DocxMathToken = Tokens.Generic & {
  type: "bookMath" | "bookMathBlock";
  expression: MarkdownMath;
};

// The converter flattens unknown MathML nodes. Refuse those rather than silently
// changing an equation's meaning (for example a phantom or padded expression).
const SUPPORTED_MATHML = new Set([
  "math", "semantics", "menclose", "mfrac", "mi", "mmultiscripts", "mn", "mo",
  "mover", "mroot", "mrow", "ms", "mspace", "msqrt", "mstyle", "msub", "msubsup",
  "msup", "mtable", "mtd", "mtext", "mtr", "munder", "munderover"
]);

const TOKEN_ELEMENTS = new Set(["mi", "mn", "mo", "ms", "mtext"]);

function nodeText(node: Element): string {
  return String(node.text ?? "") + (node.elements ?? []).map(nodeText).join("");
}

function plainTokenContent(node: Element): boolean {
  return node.type === "text" || (["mi", "mn", "mo", "mtext", "mrow", "mstyle"].includes(node.name ?? "")
    && (node.elements ?? []).every(plainTokenContent));
}

function normalizeMathMl(node: Element): void {
  for (const child of node.elements ?? []) normalizeMathMl(child);
  if (!TOKEN_ELEMENTS.has(node.name ?? "")) return;
  const value = nodeText(node);
  // KaTeX's \\bmod emits <mo><mrow><mi>m</mi>…</mrow></mo>. The
  // converter otherwise nests runs inside m:t, which readers silently hide.
  if (node.elements?.some((child) => child.type === "element")) {
    if (!node.elements.every(plainTokenContent)) {
      throw new Error("Unsupported nested math token");
    }
    node.elements = [{ type: "text", text: value }];
  }
  // Its parser trims whitespace-only tokens. Use a spacing element instead.
  if ((node.name === "mtext" && /^\s+$/.test(value)) || (node.name === "mo" && value === "\u2061")) {
    node.name = "mspace";
    node.attributes = { width: "0.1667em" };
    node.elements = [];
  } else if ((node.name === "mi" || node.name === "mo") && [...value].length > 1 && !node.attributes?.mathvariant) {
    // MathML's default for multi-letter identifiers (sin, log, gcd) is upright.
    node.attributes = { ...node.attributes, mathvariant: "normal" };
  }
}

function validMathText(node: Element): boolean {
  if (node.name === "m:t" && node.elements?.some((child) => child.type !== "text")) return false;
  return (node.elements ?? []).every(validMathText);
}

function element(name: string, children: Element[], attributes?: Element["attributes"]): Element {
  return { type: "element", name, elements: children, ...(attributes ? { attributes } : {}) };
}

/** The converter prints matrix fences as single-height text. Make them grow. */
function growMatrixFences(node: Element): void {
  const children = node.elements ?? [];
  for (const child of children) growMatrixFences(child);
  const runText = (run: Element | undefined) => run?.name === "m:r"
    ? run.elements?.find((child) => child.name === "m:t") : undefined;
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}", "|": "|", "‖": "‖" };
  for (let at = 1; at + 1 < children.length; at += 1) {
    const matrix = children[at]!;
    if (matrix.name !== "m:m") continue;
    const before = runText(children[at - 1]);
    const after = runText(children[at + 1]);
    if (!before || !after) continue;
    const left = nodeText(before);
    const right = nodeText(after);
    const opening = left.at(-1)!;
    const closing = right[0]!;
    if (!pairs[opening] || pairs[opening] !== closing) continue;
    before.elements = [{ type: "text", text: left.slice(0, -1) }];
    after.elements = [{ type: "text", text: right.slice(1) }];
    children[at] = element("m:d", [
      element("m:dPr", [
        element("m:begChr", [], { "m:val": opening }),
        element("m:endChr", [], { "m:val": closing }),
        element("m:grow", [], { "m:val": "1" })
      ]),
      element("m:e", [matrix])
    ]);
  }
}

/** Editable Office Math, built only from KaTeX's untrusted-mode MathML. */
export function wordEquation(expression: MarkdownMath): ImportedXmlComponent | undefined {
  const mathml = renderMathMl(expression)?.match(/<math\b[\s\S]*<\/math>/)?.[0];
  if (!mathml || [...mathml.matchAll(/<([a-z][a-z0-9-]*)\b/g)].some((tag) => !SUPPORTED_MATHML.has(tag[1]!))) {
    return undefined;
  }
  try {
    const input = xml2js(mathml, { compact: false, captureSpacesBetweenElements: true }) as Element;
    normalizeMathMl(input);
    const omml = mml2omml(js2xml(input, { compact: false }));
    const document = xml2js(omml, { compact: false, captureSpacesBetweenElements: true }) as Element;
    const root = document.elements?.[0];
    if (root?.name !== "m:oMath" || !validMathText(root)) return undefined;
    growMatrixFences(root);
    const component = convertToXmlComponent(root);
    return component instanceof ImportedXmlComponent ? component : undefined;
  } catch {
    return undefined;
  }
}

/** Local lexer: math never changes the global Markdown parser or other exports. */
export function lexDocxMarkdown(text: string): Token[] {
  const prefix = `WORDMATH${randomUUID().replaceAll("-", "")}X`;
  const expressions: MarkdownMath[] = [];
  const protectedText = replaceMarkdownMath(text, (expression) => {
    const placeholder = `${prefix}${expressions.length}END`;
    expressions.push(expression);
    return placeholder;
  });
  const matchInline = new RegExp(`^${prefix}(\\d+)END`);
  const matchBlock = new RegExp(`^${prefix}(\\d+)END[ \\t]*(?:\\n|$)`);
  const lexer = new Marked({
    gfm: true,
    extensions: [
      {
        name: "bookMath",
        level: "inline",
        start: (source) => source.indexOf(prefix),
        tokenizer(source) {
          const match = matchInline.exec(source);
          if (!match) return undefined;
          const expression = expressions[Number(match[1])];
          return expression ? { type: "bookMath", raw: match[0], expression } : undefined;
        }
      },
      {
        name: "bookMathBlock",
        level: "block",
        start(source) {
          const at = source.indexOf(prefix);
          return at >= 0 && (at === 0 || source[at - 1] === "\n") ? at : undefined;
        },
        tokenizer(source) {
          const match = matchBlock.exec(source);
          if (!match) return undefined;
          const expression = expressions[Number(match[1])];
          return expression?.display ? { type: "bookMathBlock", raw: match[0], expression } : undefined;
        }
      }
    ]
  });
  const tokens = lexer.lexer(protectedText);
  const restore = (value: string) => value.replace(new RegExp(`${prefix}(\\d+)END`, "g"),
    (placeholder, index: string) => expressions[Number(index)]?.raw ?? placeholder);
  // Marked knows nested code fences and reference-link destinations better than
  // the preprocessor. Any placeholder it treats as literal must stay literal.
  lexer.walkTokens(tokens, (token) => {
    if (token.type === "bookMath" || token.type === "bookMathBlock") return;
    const fields: Tokens.Generic = token;
    for (const key of ["raw", "text", "href", "title"] as const) {
      if (typeof fields[key] === "string") fields[key] = restore(fields[key]);
    }
  });
  return tokens;
}
