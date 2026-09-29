import { isCancellationError } from "../adapters/retry.js";
import type { TextModelAdapter } from "../adapters/types.js";
import { generateJsonWithRetry } from "../generation/generateJsonWithRetry.js";
import {
  askCall,
  brainstormCall,
  continueCall,
  describeCall,
  proofreadCall,
  rewriteCall,
  type AuthorAssistCall,
  type QuickAssistPromptInput
} from "./authorAssistPrompts.js";
import {
  cleanAssistText,
  cleanBrainstormIdeas,
  clipAtSentence,
  filterProofreadCorrections,
  joinContinuationAtCursor,
  stripEchoedLead,
  withSelectionEndPunctuation,
  withSelectionWhitespace
} from "./authorAssistSchemas.js";
import {
  AUTHOR_ASSIST_LIMITS,
  AuthorAssistInputError,
  AuthorAssistUnavailableError,
  QUICK_AUTHOR_ASSIST_KINDS,
  REWRITE_PRESETS,
  type AuthorAssistBook,
  type QuickAuthorAssistKind,
  type RewritePreset
} from "./authorAssistTypes.js";

/**
 * The Writing Studio's quick assists — rewrite, proofread, continue, describe,
 * "what happens next" and ask — each one model call, run synchronously by
 * `POST /api/mobile/projects/:id/manuscript/assist` under the chat message
 * allowance. Nothing here writes anything: the result is a suggestion the
 * author accepts or discards.
 */

export type QuickAuthorAssistRequest = {
  kind: QuickAuthorAssistKind;
  book: AuthorAssistBook;
  chapter: { title: string; notes: string };
  selection?: string;
  before?: string;
  after?: string;
  preset?: RewritePreset;
  instruction?: string;
};

export type QuickAuthorAssistResult = {
  kind: QuickAuthorAssistKind;
  /** rewrite, continue and describe: exactly one. */
  suggestions: Array<{ text: string }>;
  /** proofread: exact, unique, non-overlapping spans of `selection`, in text order. */
  corrections: Array<{ find: string; replace: string; reason: string }>;
  /** brainstorm: up to three. */
  ideas: Array<{ title: string; text: string }>;
  /** ask. */
  answer: string | null;
};

const ANSWER_MAX_CHARS = 1_400;
const CONTINUATION_MAX_CHARS = 2_000;

/**
 * Runs one quick assist.
 *
 * Throws `AuthorAssistInputError` (before any model call) for a request that
 * cannot be served — no selection for rewrite, proofread or describe, no
 * question for ask, a field past its wire limit, an unknown kind or preset.
 * Throws `AuthorAssistUnavailableError` when the model fails or its reply is
 * unusable once cleaned. A cancellation through `signal` propagates as is.
 *
 * A proofread that finds nothing is a successful, empty result, not an error.
 *
 * `continue` returns text ready to insert at the cursor: it carries its own
 * leading separator (a space, or a paragraph break when the model opened one)
 * when `before` does not end in whitespace, and a trailing space when `after`
 * starts a word right at the cursor. `rewrite` and `describe` keep the
 * selection's own leading and trailing whitespace.
 */
export async function runQuickAuthorAssist(
  request: QuickAuthorAssistRequest,
  deps: { textModel: TextModelAdapter; signal?: AbortSignal }
): Promise<QuickAuthorAssistResult> {
  const input = validateQuickAuthorAssistRequest(request);
  const empty: QuickAuthorAssistResult = { kind: input.kind, suggestions: [], corrections: [], ideas: [], answer: null };
  switch (input.kind) {
    case "rewrite":
    case "describe": {
      const call = input.kind === "rewrite" ? rewriteCall(input) : describeCall(input);
      const reply = await runAuthorAssistCall(deps.textModel, call, deps.signal);
      const text = requireText(cleanAssistText(reply.text, input.selection), input.kind);
      const closed = withSelectionEndPunctuation(input.selection, text);
      return { ...empty, suggestions: [{ text: withSelectionWhitespace(input.selection, closed) }] };
    }
    case "continue": {
      const reply = await runAuthorAssistCall(deps.textModel, continueCall(input), deps.signal);
      const openedParagraph = /^[ \t]*\n/.test(reply.text);
      const echo = stripEchoedLead(input.before, cleanAssistText(reply.text, input.before));
      const text = requireText(clipAtSentence(echo.text, CONTINUATION_MAX_CHARS), input.kind);
      const lead = { openedParagraph: openedParagraph && !echo.continuesWord, continuesWord: echo.continuesWord };
      return { ...empty, suggestions: [{ text: joinContinuationAtCursor(input, text, lead) }] };
    }
    case "proofread": {
      const reply = await runAuthorAssistCall(deps.textModel, proofreadCall(input), deps.signal);
      return { ...empty, corrections: filterProofreadCorrections(input.selection, reply.corrections) };
    }
    case "brainstorm": {
      const reply = await runAuthorAssistCall(deps.textModel, brainstormCall(input), deps.signal);
      const ideas = cleanBrainstormIdeas(reply.ideas);
      if (ideas.length === 0) throw new AuthorAssistUnavailableError("The brainstorm came back without a usable idea.");
      return { ...empty, ideas };
    }
    case "ask": {
      const reply = await runAuthorAssistCall(deps.textModel, askCall(input), deps.signal);
      const answer = requireText(clipAtSentence(cleanAssistText(reply.answer), ANSWER_MAX_CHARS), input.kind);
      return { ...empty, answer };
    }
  }
}

/** Normalizes a request and refuses what cannot be served. Exported for the API's own early check. */
export function validateQuickAuthorAssistRequest(request: QuickAuthorAssistRequest): QuickAssistPromptInput {
  if (!QUICK_AUTHOR_ASSIST_KINDS.includes(request.kind)) {
    throw new AuthorAssistInputError("INVALID_INPUT", `Unknown assist kind: ${String(request.kind)}.`);
  }
  if (request.preset !== undefined && !REWRITE_PRESETS.includes(request.preset)) {
    throw new AuthorAssistInputError("INVALID_INPUT", `Unknown rewrite preset: ${String(request.preset)}.`);
  }
  const selection = bounded(request.selection, AUTHOR_ASSIST_LIMITS.selectionChars, "selection");
  const before = bounded(request.before, AUTHOR_ASSIST_LIMITS.beforeChars, "before");
  const after = bounded(request.after, AUTHOR_ASSIST_LIMITS.afterChars, "after");
  const instruction = bounded(request.instruction, AUTHOR_ASSIST_LIMITS.instructionChars, "instruction").trim();
  const needsSelection = request.kind === "rewrite" || request.kind === "proofread" || request.kind === "describe";
  if (needsSelection && selection.trim().length === 0) {
    throw new AuthorAssistInputError("SELECTION_REQUIRED", "Select some text first.");
  }
  if (request.kind === "ask" && instruction.length === 0) {
    throw new AuthorAssistInputError("INSTRUCTION_REQUIRED", "Type a question first.");
  }
  return {
    kind: request.kind,
    book: request.book,
    chapter: { title: request.chapter.title ?? "", notes: request.chapter.notes ?? "" },
    selection,
    before,
    after,
    preset: request.kind === "rewrite" ? (request.preset ?? null) : null,
    instruction
  };
}

function bounded(value: string | undefined, max: number, field: string): string {
  const text = value ?? "";
  if (text.length > max) {
    throw new AuthorAssistInputError("INPUT_TOO_LONG", `${field} is longer than ${max} characters.`);
  }
  return text;
}

function requireText(text: string, kind: QuickAuthorAssistKind): string {
  if (text.trim().length === 0) {
    throw new AuthorAssistUnavailableError(`The ${kind} assist came back empty.`);
  }
  return text;
}

/**
 * One model call with one repair attempt (and, outside it, one wider budget
 * when the provider cut the reply off at `maxTokens`). Every failure but a
 * cancellation becomes `AuthorAssistUnavailableError`, with the provider's
 * error kept as `cause` so network-retry predicates still read through it.
 */
export async function runAuthorAssistCall<T>(
  textModel: TextModelAdapter,
  call: AuthorAssistCall<T>,
  signal?: AbortSignal
): Promise<T> {
  try {
    const result = await generateJsonWithRetry(textModel, {
      purpose: call.purpose,
      schema: call.schema,
      messages: call.messages,
      maxTokens: call.maxTokens,
      temperature: call.temperature,
      repairAttempts: 1,
      ...(signal ? { signal } : {})
    });
    return result.data;
  } catch (error) {
    if (isCancellationError(error) || error instanceof AuthorAssistUnavailableError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new AuthorAssistUnavailableError(`The ${call.purpose} call failed: ${detail.slice(0, 300)}`, { cause: error });
  }
}
