import type { AdminShare, CaptionVerdict, ModerationAttempt, ShareModerationAction } from "./types.js";

/**
 * Pure reads behind the Moderation screen's shared-book cards.
 *
 * The caption verdict and the report snapshot are JSON columns on the server:
 * the verdict gains an `operator` key once someone decides, and an older row can
 * predate a field. So both are read defensively here instead of being cast where
 * they come off the wire — a malformed record renders as "no record", never as a
 * crash in the middle of the queue.
 */

/** `POST /api/admin/shares/:id/moderation` refuses a longer reason; the author reads it in the app. */
export const TAKEDOWN_REASON_MAX = 500;

export type ShareSnapshot = {
  /**
   * Who filed it: the note's gate that had no verdict, the sexual-content
   * filter's book-text screen that had none (`book_text_review`), or a reader
   * on the public page.
   */
  kind: "caption_review" | "book_text_review" | "public_report" | null;
  caption: string | null;
  slug: string | null;
  title: string | null;
  verdict: CaptionVerdict | null;
  /** On a `book_text_review`: how much of the book the screen read and could not decide. */
  bookText: BookTextReview | null;
};

/** `bookTextReview` in apps/api/src/mobile/shares/shareRecords.ts. */
export type BookTextReview = {
  /** 8,000-character windows of title, matter and pages. */
  windows: number;
  /** Windows a model answered without a confident verdict. */
  undecided: number;
  /** Windows never read: the screen's budget or window cap ran out first. */
  unscreened: number;
  reasons: string[];
  decidedAt: string | null;
};

export function readShareSnapshot(value: unknown): ShareSnapshot {
  const record = asRecord(value);
  const kind = record?.kind;
  return {
    kind: kind === "caption_review" || kind === "book_text_review" || kind === "public_report" ? kind : null,
    caption: text(record?.caption),
    slug: text(record?.slug),
    title: text(record?.title),
    verdict: readCaptionVerdict(record?.verdict),
    bookText: kind === "book_text_review" ? readBookTextReview(record?.verdict) : null
  };
}

export function readBookTextReview(value: unknown): BookTextReview | null {
  const record = asRecord(value);
  if (!record || record.surface !== "book_text") return null;
  const count = (raw: unknown) => (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0);
  return {
    windows: count(record.windows),
    undecided: count(record.undecidedWindows),
    unscreened: count(record.unscreenedWindows),
    reasons: Array.isArray(record.reasons) ? record.reasons.filter((reason): reason is string => text(reason) !== null) : [],
    decidedAt: text(record.decidedAt)
  };
}

export function readCaptionVerdict(value: unknown): CaptionVerdict | null {
  const record = asRecord(value);
  if (!record) return null;
  const verdict = record.verdict;
  if (verdict !== "allowed" && verdict !== "refused" && verdict !== "undecided") return null;
  const attempts = Array.isArray(record.attempts) ? record.attempts.map(readAttempt) : [];
  const operator = asRecord(record.operator);
  return {
    surface: text(record.surface),
    verdict,
    reason: text(record.reason),
    decidedBy: text(record.decidedBy),
    violation: text(record.violation),
    decidedAt: text(record.decidedAt),
    attempts: attempts.filter((attempt): attempt is ModerationAttempt => attempt !== null),
    operator:
      operator && text(operator.action)
        ? {
            action: text(operator.action)!,
            reviewerUserId: text(operator.reviewerUserId),
            at: text(operator.at),
            reason: text(operator.reason)
          }
        : null
  };
}

function readAttempt(value: unknown): ModerationAttempt | null {
  const record = asRecord(value);
  const role = record?.role;
  if (!record || (role !== "primary" && role !== "fallback")) return null;
  const probabilities = asRecord(record.probabilities);
  const selectedOption = text(record.selectedOption);
  const escalationReason = text(record.escalationReason);
  const error = text(record.error);
  return {
    role,
    provider: text(record.provider) ?? "unknown",
    model: text(record.model) ?? "unknown",
    durationMs: typeof record.durationMs === "number" && Number.isFinite(record.durationMs) ? record.durationMs : 0,
    ...(selectedOption ? { selectedOption } : {}),
    ...(probabilities
      ? {
          probabilities: Object.fromEntries(
            Object.entries(probabilities).filter((entry): entry is [string, number] => isProbability(entry[1]))
          )
        }
      : {}),
    ...(escalationReason ? { escalationReason } : {}),
    ...(error ? { error } : {})
  };
}

/** Highest first; ties by option id so the order is stable between renders. */
export function rankedProbabilities(
  probabilities: Record<string, number> | undefined
): Array<{ option: string; probability: number }> {
  return Object.entries(probabilities ?? {})
    .filter((entry): entry is [string, number] => isProbability(entry[1]))
    .map(([option, probability]) => ({ option, probability }))
    .sort((a, b) => b.probability - a.probability || a.option.localeCompare(b.option));
}

/** A share of 1 as a percentage a reader can compare at a glance. */
export function probabilityLabel(probability: number): string {
  if (probability > 0 && probability < 0.001) return "<0.1%";
  return `${(probability * 100).toFixed(1)}%`;
}

/** Option and reason ids are snake_case; the screen reads them as words. */
export function words(id: string): string {
  return id.replace(/_/g, " ");
}

export type ShareActionAvailability = Record<ShareModerationAction, { enabled: boolean; why: string | null }>;

/**
 * Which of the four actions apply to this share. The server answers 409
 * NO_CAPTION to a caption action on a share with no note, and NO_TEXT_REVIEW to
 * approving a book text nothing is holding; a second take-down would only
 * overwrite the reason the author was already shown. `heldBookText` is whether
 * the queue holds a pending `book_text_review` for this share.
 */
export function shareActionAvailability(share: AdminShare, heldBookText = false): ShareActionAvailability {
  const noCaption = share.caption?.trim() ? null : "This share has no note.";
  const takenDown = share.status === "taken_down" ? "Already taken down." : null;
  const noTextReview = heldBookText ? null : "No book text is waiting for review on this share.";
  return {
    approve_caption: { enabled: noCaption === null, why: noCaption },
    remove_caption: { enabled: noCaption === null, why: noCaption },
    approve_book_text: { enabled: noTextReview === null, why: noTextReview },
    take_down: { enabled: takenDown === null, why: takenDown }
  };
}

/** The shares the queue holds a pending book-text review for: the one approval that closes it is a share action. */
export function sharesWithHeldBookText(reports: ReadonlyArray<{ status: string; bookShareId: string | null; targetSnapshot?: unknown }>): Set<string> {
  return new Set(
    reports
      .filter((report) => report.status === "pending" && report.bookShareId && readShareSnapshot(report.targetSnapshot).kind === "book_text_review")
      .map((report) => report.bookShareId!)
  );
}

export type ShareModerationBody = { action: ShareModerationAction; reason?: string; reportId?: string };

export function shareModerationBody(
  action: ShareModerationAction,
  reason: string | undefined,
  reportId: string | undefined
): ShareModerationBody {
  const trimmed = reason?.trim().slice(0, TAKEDOWN_REASON_MAX);
  return {
    action,
    ...(trimmed ? { reason: trimmed } : {}),
    ...(reportId ? { reportId } : {})
  };
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
