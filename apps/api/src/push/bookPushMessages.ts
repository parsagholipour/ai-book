/**
 * What a book push says, and the FCM request that carries it.
 *
 * Every message is data-only on Android: the app draws the notification itself
 * (`apps/mobile/lib/features/notifications/`), because a progress bar, an
 * in-place update and an ordering guard are not things a system-drawn FCM
 * notification can do. The copy is composed here rather than in the app, the
 * way the app renders whatever progress text the status route serializes.
 *
 * The data keys and `kind` values are a wire contract with every installed
 * build: the app ignores a kind it does not know, so adding one is safe, but
 * renaming a key or a kind silences the builds already on phones.
 */

export type BookPushKind = "book_progress" | "book_ready" | "book_failed" | "book_clear";

export type BookPushMessage = {
  kind: BookPushKind;
  projectId: string;
  /**
   * When the sweep claimed this message, in ms. FCM does not keep order, so the
   * app drops a message older than the last one it showed for the book — which
   * is what stops a late progress update from covering "your book is ready".
   */
  sentAt: number;
  title: string;
  body: string;
  /** 0–100, progress messages only. */
  percent?: number;
};

export type PushPlatformName = "ANDROID" | "IOS";

export type PushTarget = { token: string; platform: PushPlatformName };

const TITLE_LIMIT = 80;
const BODY_LIMIT = 160;
/** A progress message is worth nothing once a newer one could have been sent. */
const PROGRESS_TTL = "300s";
/** "Your book is ready" is still news to a phone that was off for the evening. */
const SETTLED_TTL = "86400s";

export function bookProgressMessage(input: {
  projectId: string;
  title: string;
  percent: number;
  detail: string | null;
  sentAt: number;
}): BookPushMessage {
  return {
    kind: "book_progress",
    projectId: input.projectId,
    sentAt: input.sentAt,
    title: clip(bookTitle(input.title), TITLE_LIMIT),
    body: clip(input.detail?.trim() || "Writing your book", BODY_LIMIT),
    percent: Math.max(0, Math.min(100, Math.round(input.percent)))
  };
}

export function bookSettledMessage(input: {
  kind: Exclude<BookPushKind, "book_progress">;
  projectId: string;
  title: string;
  /** REVIEW_REQUIRED: finished, with a verdict the reader should look at. */
  needsReview?: boolean;
  sentAt: number;
}): BookPushMessage {
  const quoted = `“${clip(bookTitle(input.title), TITLE_LIMIT - 2)}”`;
  const base = { kind: input.kind, projectId: input.projectId, sentAt: input.sentAt };
  switch (input.kind) {
    case "book_ready":
      return {
        ...base,
        title: "Your book is ready",
        body: input.needsReview ? `${quoted} is finished. Open it to look it over.` : `${quoted} is ready to read.`
      };
    case "book_failed":
      return {
        ...base,
        title: "Your book needs attention",
        body: `We hit a problem writing ${quoted}. Open it to try again.`
      };
    case "book_clear":
      return { ...base, title: "", body: "" };
  }
}

/**
 * The FCM HTTP v1 request for one device, or null when this platform is not
 * sent this kind.
 *
 * iOS has no progress bar to update and drops most silent pushes, so an iOS
 * device is sent only how a book ended, as an APNs alert the system draws.
 */
export function fcmRequestBody(target: PushTarget, message: BookPushMessage): Record<string, unknown> | null {
  const settled = message.kind !== "book_progress";
  const data: Record<string, string> = {
    kind: message.kind,
    projectId: message.projectId,
    sentAt: String(message.sentAt),
    title: message.title,
    body: message.body,
    ...(message.percent === undefined ? {} : { percent: String(message.percent) })
  };
  if (target.platform === "IOS") {
    if (message.kind !== "book_ready" && message.kind !== "book_failed") {
      return null;
    }
    return {
      message: {
        token: target.token,
        data,
        apns: {
          headers: { "apns-priority": "10", "apns-collapse-id": collapseKey(message.projectId) },
          payload: { aps: { alert: { title: message.title, body: message.body }, sound: "default" } }
        }
      }
    };
  }
  return {
    message: {
      token: target.token,
      data,
      android: {
        // One key per book, so a phone that was offline is handed only the
        // newest word about it — the ending, if there is one — not the backlog.
        collapse_key: collapseKey(message.projectId),
        // Progress can wait out Doze; the ending should not.
        priority: settled ? "HIGH" : "NORMAL",
        ttl: settled ? SETTLED_TTL : PROGRESS_TTL
      }
    }
  };
}

function collapseKey(projectId: string): string {
  return `book-${projectId}`;
}

function bookTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim() || "Your book";
}

function clip(value: string, limit: number): string {
  const chars = Array.from(value);
  return chars.length <= limit ? value : `${chars.slice(0, limit - 1).join("").trimEnd()}…`;
}
