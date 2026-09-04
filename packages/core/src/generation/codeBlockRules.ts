import type { BookPlan, CreateProjectInput } from "../schemas/book.js";

/**
 * How a book about code fences its code. The first algorithms book tagged
 * every fence `text` and indented the rest, so highlight.js — which keys on
 * the fence's language name and is wired for the PDF only — coloured
 * nothing. Shown only to a book about code, so no other book's prompt moves.
 */

const CODE_CUE =
  /\b(?:code|coding|programming|programmer|algorithm|software|python|javascript|typescript|java|kotlin|swift|rust|golang|c\+\+|c#|sql|bash|shell|regex|api|compiler|data structures?|scripts?)\b/i;

/** Whether the book is about code: the one case where how a code block is fenced decides whether it is typeset with colour. */
export function bookMentionsCode(input: CreateProjectInput, plan: BookPlan): boolean {
  const text = [input.prompt, plan.title, plan.premise, ...plan.chapters.flatMap((chapter) => [chapter.title, chapter.summary])].join("\n");
  return CODE_CUE.test(text);
}

/**
 * The first algorithms book tagged every fence `text` and indented the rest,
 * so highlight.js had nothing to colour; the PDF's highlighter keys on the
 * fence's language name. Shown only to a book about code.
 */
export function codeBlockRules(input: CreateProjectInput, plan: BookPlan): string[] {
  if (!bookMentionsCode(input, plan)) return [];
  return [
    "Code and pseudocode go in fenced blocks, never indented with spaces. A fence tagged with the language name (python, javascript, typescript, java, c, cpp, go, rust, sql, bash) is typeset with syntax colouring, so never tag a code block text; tag pseudocode as pseudocode. Keep each block short enough to read on a page, and say in the prose what it does."
  ];
}
