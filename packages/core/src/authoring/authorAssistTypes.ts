import type { ManuscriptStyleProfile } from "../ingestion/manuscriptImport.js";
import type { StudioKind, StudioLayout } from "../schemas/mediaSettings.js";

/**
 * The vocabulary of the Writing Studio's AI tools.
 *
 * Every tool here *suggests*: the runners return text, corrections, ideas or
 * notes, and the author decides with a tap. None of them writes a chapter,
 * touches the database or the queue. The quick ones run synchronously in the
 * API (`runQuickAuthorAssist`); the long ones run in the worker's
 * `WRITING_ASSIST` job (`authorLongAssists.ts`).
 */

/** What the runners know about the book. Everything in it is the author's own content. */
export type AuthorAssistBook = {
  title: string;
  kind: StudioKind;
  /** The book's language (a code such as `fa`, or a name). Every suggestion is written in it. */
  language: string;
  /** `mediaSettings.mobile.studio.styleProfile` (or the import's) when one has been learned. */
  styleProfile?: ManuscriptStyleProfile | null;
  characters?: Array<{ name: string; description: string }>;
  /**
   * The Studio layout. Only the chapter draft reads it: a `picture` draft is
   * written as pages separated by `<!-- page -->` lines. Defaults to `picture`
   * for a picture book and `flow` otherwise.
   */
  layout?: StudioLayout;
};

/** A margin note. `quote` is verbatim from the chapter (verified), or null for a note about the whole. */
export type AuthorNote = { quote: string | null; note: string; severity: "suggestion" | "issue" };

export const QUICK_AUTHOR_ASSIST_KINDS = ["rewrite", "proofread", "continue", "describe", "brainstorm", "ask"] as const;
export type QuickAuthorAssistKind = (typeof QUICK_AUTHOR_ASSIST_KINDS)[number];

export const REWRITE_PRESETS = ["clearer", "vivid", "shorter", "longer", "simpler", "formal", "casual"] as const;
export type RewritePreset = (typeof REWRITE_PRESETS)[number];

/**
 * Provider-call purposes, which are also the stage ids in
 * `GENERATION_MODEL_STAGES` (group "Writing Studio"). The judgment ones —
 * proofread, chapter feedback, consistency — are in `MECHANICAL_TEXT_PURPOSES`.
 * The prompt builders spell each one as a literal at the call site too
 * (`authorAssistPrompts.ts`), because `textRouting.test.ts` reads purposes out
 * of the source and cannot follow a property access.
 */
export const AUTHOR_ASSIST_PURPOSES = {
  rewrite: "author-assist-rewrite",
  proofread: "author-assist-proofread",
  continue: "author-assist-continue",
  describe: "author-assist-describe",
  brainstorm: "author-assist-brainstorm",
  ask: "author-assist-ask",
  draftChapter: "author-draft-chapter",
  chapterFeedback: "author-chapter-feedback",
  consistency: "author-consistency",
  outline: "author-outline"
} as const;
export type AuthorAssistPurpose = (typeof AUTHOR_ASSIST_PURPOSES)[keyof typeof AUTHOR_ASSIST_PURPOSES];

const AUTHOR_ASSIST_PURPOSE_SET: ReadonlySet<string> = new Set(Object.values(AUTHOR_ASSIST_PURPOSES));

export function isAuthorAssistPurpose(purpose: string | undefined): purpose is AuthorAssistPurpose {
  return purpose !== undefined && AUTHOR_ASSIST_PURPOSE_SET.has(purpose);
}

/**
 * Request bounds. The first four are the wire contract of
 * `POST /manuscript/assist` and are *refused* past their limit
 * (`AuthorAssistInputError`), because the client chose to send them. The rest
 * bound context the server reads off its own rows (chapter notes, the cast,
 * the style profile) and are *clipped*: the author did not type them into this
 * request and should not be refused for them.
 */
export const AUTHOR_ASSIST_LIMITS = {
  selectionChars: 6000,
  beforeChars: 4000,
  afterChars: 1500,
  instructionChars: 500,
  chapterTitleChars: 200,
  chapterNotesChars: 3000,
  draftNotesChars: 6000,
  premiseChars: 2000,
  characters: 24,
  characterDescriptionChars: 400,
  styleExcerptChars: 600,
  proofreadCorrections: 40,
  ideaTitleChars: 60,
  noteQuoteChars: 200
} as const;

export type AuthorAssistInputErrorCode =
  | "SELECTION_REQUIRED"
  | "INSTRUCTION_REQUIRED"
  | "INPUT_TOO_LONG"
  | "INVALID_INPUT"
  | "NOTHING_TO_READ";

/** A request the runner refuses before any model call. The API maps it to 400 with `code`. */
export class AuthorAssistInputError extends Error {
  constructor(
    readonly code: AuthorAssistInputErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AuthorAssistInputError";
  }
}

/**
 * The model could not produce a usable suggestion: a provider failure, a reply
 * that would not parse after its repair, or one that was empty once cleaned.
 * The API maps it to 503 `ASSIST_UNAVAILABLE` (and returns the message slot);
 * the worker fails the assist and refunds. The provider error rides `cause`, so
 * `isRecoverableNetworkError` still sees a network failure through it, and a
 * cancellation is never wrapped at all.
 */
export class AuthorAssistUnavailableError extends Error {
  readonly code = "ASSIST_UNAVAILABLE";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AuthorAssistUnavailableError";
  }
}
