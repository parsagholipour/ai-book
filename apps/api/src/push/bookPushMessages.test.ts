import { describe, expect, it } from "vitest";
import { bookProgressMessage, bookSettledMessage, fcmRequestBody } from "./bookPushMessages.js";

const ANDROID = { token: "android-token", platform: "ANDROID" as const };
const IOS = { token: "ios-token", platform: "IOS" as const };
const SENT_AT = Date.parse("2026-10-03T09:00:00.000Z");

describe("book push messages", () => {
  it("carries the status route's own phrase and a whole, bounded percent", () => {
    const message = bookProgressMessage({
      projectId: "project-1",
      title: "  The   Lost Fox ",
      percent: 41.6,
      detail: "Writing chapter 3 of 8",
      sentAt: SENT_AT
    });
    expect(message).toEqual({
      kind: "book_progress",
      projectId: "project-1",
      sentAt: SENT_AT,
      title: "The Lost Fox",
      body: "Writing chapter 3 of 8",
      percent: 42
    });
    expect(bookProgressMessage({ projectId: "p", title: "", percent: 140, detail: "  ", sentAt: SENT_AT })).toMatchObject({
      title: "Your book",
      body: "Writing your book",
      percent: 100
    });
  });

  it("says how a book ended, and tells a finished book under review apart", () => {
    const base = { projectId: "project-1", title: "The Lost Fox", sentAt: SENT_AT };
    expect(bookSettledMessage({ ...base, kind: "book_ready" })).toMatchObject({
      title: "Your book is ready",
      body: "“The Lost Fox” is ready to read."
    });
    expect(bookSettledMessage({ ...base, kind: "book_ready", needsReview: true }).body).toBe(
      "“The Lost Fox” is finished. Open it to look it over."
    );
    expect(bookSettledMessage({ ...base, kind: "book_failed" })).toMatchObject({
      title: "Your book needs attention",
      body: "We hit a problem writing “The Lost Fox”. Open it to try again."
    });
    expect(bookSettledMessage({ ...base, kind: "book_clear" })).toMatchObject({ title: "", body: "" });
  });

  it("clips a long title by characters, not UTF-16 units", () => {
    const title = "🦊".repeat(120);
    const message = bookProgressMessage({ projectId: "p", title, percent: 10, detail: null, sentAt: SENT_AT });
    expect(Array.from(message.title)).toHaveLength(80);
    expect(message.title.endsWith("…")).toBe(true);
    expect(message.title).not.toMatch(/\uD83E$/);
  });

  it("sends Android a data-only message, collapsed per book, urgent only at the end", () => {
    const progress = fcmRequestBody(
      ANDROID,
      bookProgressMessage({ projectId: "project-1", title: "Fox", percent: 30, detail: "Writing", sentAt: SENT_AT })
    );
    expect(progress).toEqual({
      message: {
        token: "android-token",
        data: {
          kind: "book_progress",
          projectId: "project-1",
          sentAt: String(SENT_AT),
          title: "Fox",
          body: "Writing",
          percent: "30"
        },
        android: { collapse_key: "book-project-1", priority: "NORMAL", ttl: "300s" }
      }
    });
    expect(progress).not.toHaveProperty("message.notification");

    const ready = fcmRequestBody(ANDROID, bookSettledMessage({ kind: "book_ready", projectId: "project-1", title: "Fox", sentAt: SENT_AT }));
    expect(ready).toMatchObject({
      message: { android: { collapse_key: "book-project-1", priority: "HIGH", ttl: "86400s" } }
    });
    expect(ready).not.toHaveProperty("message.data.percent");
  });

  it("sends iOS only how a book ended, as an alert the system draws", () => {
    const progress = bookProgressMessage({ projectId: "p", title: "Fox", percent: 30, detail: "Writing", sentAt: SENT_AT });
    expect(fcmRequestBody(IOS, progress)).toBeNull();
    expect(fcmRequestBody(IOS, bookSettledMessage({ kind: "book_clear", projectId: "p", title: "Fox", sentAt: SENT_AT }))).toBeNull();
    expect(
      fcmRequestBody(IOS, bookSettledMessage({ kind: "book_failed", projectId: "p", title: "Fox", sentAt: SENT_AT }))
    ).toMatchObject({
      message: {
        token: "ios-token",
        apns: {
          payload: { aps: { alert: { title: "Your book needs attention" }, sound: "default" } }
        }
      }
    });
  });
});
