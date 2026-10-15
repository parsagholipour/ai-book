import { createHash } from "node:crypto";
import { isCancellationError, sexualContentRefusal, type ContentRestrictionRefusal } from "@book-maker/core";
import { sexualContentFilterEnabled } from "./contentSafety.js";
import {
  moderateUserText,
  type UserTextModerationDeps,
  type UserTextModerationResult,
  type UserTextSurface
} from "./userTextModeration.js";

/**
 * The model screens of the operator's sexual-content filter, run only while
 * the filter is on (`contentSafety.ts`). Both are the share note's Jev gate
 * (`moderateUserText`) on a surface of their own, and a confident `sexual` or
 * `child_safety` verdict is the refusal; nothing else about a text is asked.
 *
 * - {@link screenRequestForSexualContent} reads what a reader asks a book to
 *   contain, at the doors where that request becomes a book: the creation
 *   build, the first plan, a plan revision, plan approval and every book-chat
 *   message. **It fails open**: no verdict (no route, a routing outage, both
 *   attempts failed, its deadline) lets the request through with a warning,
 *   because the rule every prompt carries still stands behind it and the
 *   product must not go down with its moderator.
 * - {@link screenBookTextForSexualContent} reads a book about to be shared
 *   publicly, in windows — and a shared book again whenever its text changes
 *   (`mobile/shares/shareRescreen.ts`, with a longer budget, since no request
 *   waits on it). **It holds rather than allows**: windows without a verdict
 *   send the share live with a system review for an operator, the share
 *   note's held-for-review answer, because a stranger reads what passes.
 *
 * The deterministic screens (`contentRestrictions.ts`, the CSAM names
 * included) run before these and do not depend on the switch.
 */

type ScreenLog = {
  warn(details: Record<string, unknown>, message: string): void;
  info(details: Record<string, unknown>, message: string): void;
};

const consoleLog: ScreenLog = {
  warn: (details, message) => console.warn(message, details),
  info: () => {}
};

/** A book-chat message is at most 5,000 characters; a build can carry pasted notes as well. */
export const REQUEST_SCREEN_WINDOW_CHARS = 6_000;
/** What a request screen reads at most: the planner reads the rest under the prompt rule alone. */
export const REQUEST_SCREEN_MAX_WINDOWS = 8;
/**
 * One request window's budget, retries and fallback included. Jev answers in
 * 0.5–1.5 s; a request screen fails open, so waiting the share note's 25 s on
 * a sick moderator would only hold a reader's request past the app's 20 s
 * receive timeout to reach the same answer.
 */
export const REQUEST_SCREEN_TIMEOUT_MS = 8_000;
export const BOOK_TEXT_WINDOW_CHARS = 8_000;
export const BOOK_TEXT_MAX_WINDOWS = 300;
/** The whole share screen's budget: the app gives a request 20 s, and the share does more than this. */
export const BOOK_TEXT_SCREEN_BUDGET_MS = 12_000;
const WINDOW_OVERLAP_CHARS = 400;
const REQUEST_CONCURRENCY = 4;
const BOOK_TEXT_CONCURRENCY = 8;

/**
 * Text cut into windows a screen can read, each overlapping the one before so a
 * passage across a cut is whole in one of them. Whitespace-only text is none.
 */
export function textWindows(text: string, size: number, overlap = WINDOW_OVERLAP_CHARS): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  const windows: string[] = [];
  const step = Math.max(1, size - overlap);
  for (let start = 0; start < trimmed.length; start += step) {
    windows.push(trimmed.slice(start, start + size));
    if (start + size >= trimmed.length) {
      break;
    }
  }
  return windows;
}

export async function screenRequestForSexualContent(input: {
  text: string;
  /** Which door asked, for the log. */
  door: string;
  deps: UserTextModerationDeps;
  log?: ScreenLog | undefined;
}): Promise<ContentRestrictionRefusal | null> {
  if (!(await sexualContentFilterEnabled())) {
    return null;
  }
  const log = input.log ?? consoleLog;
  const windows = textWindows(input.text, REQUEST_SCREEN_WINDOW_CHARS).slice(0, REQUEST_SCREEN_MAX_WINDOWS);
  if (!windows.length) {
    return null;
  }
  let results: UserTextModerationResult[];
  try {
    const deps = { ...input.deps, timeoutMs: input.deps.timeoutMs ?? REQUEST_SCREEN_TIMEOUT_MS };
    results = await mapWithConcurrency(windows, REQUEST_CONCURRENCY, (window) => moderateCached(window, "book_request", deps));
  } catch (error) {
    log.warn(
      { event: "content_safety.request_screen_failed", door: input.door, err: errorSummary(error) },
      "Sexual-content request screen failed; the request goes through under the prompt rule"
    );
    return null;
  }
  const violation = strongestViolation(results);
  if (violation) {
    log.info({ event: "content_safety.request_refused", door: input.door, violation }, "Request refused by the sexual-content filter");
    return sexualContentRefusal(violation);
  }
  const undecided = results.filter((result) => result.verdict === "undecided");
  if (undecided.length) {
    log.warn(
      {
        event: "content_safety.request_undecided",
        door: input.door,
        windows: windows.length,
        undecided: undecided.length,
        reasons: [...new Set(undecided.map((result) => (result.verdict === "undecided" ? result.reason : "")))]
      },
      "Sexual-content request screen gave no verdict; the request goes through under the prompt rule"
    );
  }
  return null;
}

export type BookTextScreen =
  | { verdict: "allowed"; windows: number }
  | { verdict: "refused"; refusal: ContentRestrictionRefusal; windows: number }
  /** Some windows had no verdict, or were never read: the share goes live and an operator reviews it. */
  | { verdict: "held"; windows: number; undecided: number; unscreened: number; reasons: string[] };

/**
 * A book's printed text, screened in windows before it is shared publicly.
 * `null` when the filter is off. Windows run eight at a time inside one budget;
 * the first confident violation stops new windows from starting, and a window
 * the budget never reached counts as unscreened, which holds the share for review.
 */
export async function screenBookTextForSexualContent(input: {
  sections: string[];
  deps: UserTextModerationDeps;
  log?: ScreenLog | undefined;
  budgetMs?: number;
  now?: () => number;
}): Promise<BookTextScreen | null> {
  if (!(await sexualContentFilterEnabled())) {
    return null;
  }
  const now = input.now ?? Date.now;
  const budgetMs = input.budgetMs ?? BOOK_TEXT_SCREEN_BUDGET_MS;
  const startedAt = now();
  const all = textWindows(input.sections.filter((section) => section.trim()).join("\n\n"), BOOK_TEXT_WINDOW_CHARS);
  const windows = all.slice(0, BOOK_TEXT_MAX_WINDOWS);
  let stop = false;
  const results = await mapWithConcurrency(windows, BOOK_TEXT_CONCURRENCY, async (window) => {
    const remaining = budgetMs - (now() - startedAt);
    if (stop || remaining <= 0) {
      return null;
    }
    try {
      const result = await moderateCached(window, "book_text", { ...input.deps, timeoutMs: remaining });
      if (result.verdict === "refused" && isFilterViolation(result.violation)) {
        stop = true;
      }
      return result;
    } catch (error) {
      if (isCancellationError(error)) {
        throw error;
      }
      return { verdict: "undecided", reason: "provider_failure", attempts: [] } satisfies UserTextModerationResult;
    }
  });
  const decided = results.filter((result): result is UserTextModerationResult => result !== null);
  const violation = strongestViolation(decided);
  if (violation) {
    input.log?.info({ event: "content_safety.share_refused", violation, windows: all.length }, "Share refused by the sexual-content filter");
    return { verdict: "refused", refusal: sexualContentRefusal(violation), windows: all.length };
  }
  const undecided = decided.filter((result) => result.verdict === "undecided");
  const unscreened = all.length - decided.length;
  if (undecided.length || unscreened) {
    const reasons = [
      ...new Set([
        ...undecided.map((result) => (result.verdict === "undecided" ? result.reason : "")),
        ...(unscreened ? ["not_reached"] : [])
      ])
    ];
    (input.log ?? consoleLog).warn(
      { event: "content_safety.share_held", windows: all.length, undecided: undecided.length, unscreened, reasons },
      "Sexual-content share screen gave no verdict on part of the book; the share is held for review"
    );
    return { verdict: "held", windows: all.length, undecided: undecided.length, unscreened, reasons };
  }
  return { verdict: "allowed", windows: all.length };
}

function isFilterViolation(violation: string): violation is "sexual" | "child_safety" {
  return violation === "sexual" || violation === "child_safety";
}

/** A minor beats an adult: the refusal names the stricter rule when windows disagree. */
function strongestViolation(results: UserTextModerationResult[]): "sexual" | "child_safety" | null {
  const violations = results.flatMap((result) =>
    result.verdict === "refused" && isFilterViolation(result.violation) ? [result.violation] : []
  );
  return violations.includes("child_safety") ? "child_safety" : violations.includes("sexual") ? "sexual" : null;
}

/**
 * A verdict is a fact about the words, so the same words are not paid for twice
 * inside ten minutes: the creation preflight and the build read one request, and
 * re-sharing a book in another mode reads the same pages. Only verdicts are kept;
 * a window with none is asked again.
 */
const VERDICT_TTL_MS = 10 * 60_000;
const VERDICT_CACHE_LIMIT = 5_000;
const verdicts = new Map<string, { result: UserTextModerationResult; at: number }>();

async function moderateCached(text: string, surface: UserTextSurface, deps: UserTextModerationDeps): Promise<UserTextModerationResult> {
  const key = `${surface}:${createHash("sha256").update(text).digest("hex")}`;
  const hit = verdicts.get(key);
  if (hit && Date.now() - hit.at < VERDICT_TTL_MS) {
    return hit.result;
  }
  const result = await moderateUserText({ text, surface }, deps);
  if (result.verdict !== "undecided") {
    verdicts.delete(key);
    verdicts.set(key, { result, at: Date.now() });
    while (verdicts.size > VERDICT_CACHE_LIMIT) {
      const oldest = verdicts.keys().next().value;
      if (oldest === undefined) break;
      verdicts.delete(oldest);
    }
  }
  return result;
}

/** Tests only: forget every cached verdict. */
export function forgetContentSafetyVerdicts(): void {
  verdicts.clear();
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function errorSummary(error: unknown): Record<string, unknown> | string {
  return error instanceof Error ? { name: error.name, message: error.message } : String(error);
}
