import { describe, expect, it } from "vitest";

import { normalizeBookMatterChatAnswer, type BookMatterChatContext, type BookMatterChatCurrent } from "./bookMatterChatEdit.js";

const current: BookMatterChatCurrent = {
  authorName: null,
  dedication: null,
  aboutAuthor: null,
  authorWebsite: null,
  copyrightHolder: null,
  imprint: null,
  isbn: null,
  allRightsReserved: false
};

const decide = (message: string, text = "9780306406157", context: Partial<BookMatterChatContext> = {}) =>
  normalizeBookMatterChatAnswer(
    { outcome: "change", changes: [{ field: "isbn", action: "set", text }] },
    { message, bookLanguage: "en", current, ...context }
  );

describe("ISBN grounding", () => {
  it.each([
    "9780306406157000",
    "0009780306406157",
    "0009780306406157000",
    "978-0-306-40615-7-000",
    "000-978-0-306-40615-7",
    "۹۷۸-۰-۳۰۶-۴۰۶۱۵-۷۰۰۰"
  ])("refuses a valid ISBN embedded within the supplied identifier %s", (supplied) => {
    expect(decide(`Set the ISBN to ${supplied}`)).toEqual({ kind: "refused", problem: { kind: "not_given", field: "isbn" } });
  });

  it.each([
    "9780306406157",
    "978-0-306-40615-7",
    "978 0 306 40615 7",
    "ISBN-13 978-0-306-40615-7",
    "ISBN 13 978 0 306 40615 7",
    "ISBN-۱۳ ۹۷۸–۰–۳۰۶–۴۰۶۱۵–۷"
  ])("accepts the complete supplied identifier %s", (supplied) => {
    expect(decide(`Set the ISBN to ${supplied}`)).toEqual({ kind: "change", patch: { isbn: "9780306406157" } });
  });

  it.each(["0-8044-2957-X", "ISBN-10 0 8044 2957 x", "ISBN-۱۰ ۰‑۸۰۴۴‑۲۹۵۷‑x"])(
    "accepts a complete ISBN-10 with an X check digit: %s",
    (supplied) => {
      expect(decide(`Set the ISBN to ${supplied}`, "080442957X")).toEqual({ kind: "change", patch: { isbn: "080442957X" } });
    }
  );

  it.each(["080442957X000", "0-8044-2957-X-000", "۰‑۸۰۴۴‑۲۹۵۷‑x۰۰۰"])(
    "refuses an ISBN-10 truncated after its X check digit: %s",
    (supplied) => {
      expect(decide(`Set the ISBN to ${supplied}`, "080442957X")).toEqual({
        kind: "refused",
        problem: { kind: "not_given", field: "isbn" }
      });
    }
  );

  it("retains the current ISBN even beside numeric reader turns and current fields", () => {
    expect(
      decide("Format the ISBN without hyphens", "9780306406157", {
        readerTurns: ["2026"],
        current: { ...current, copyrightHolder: "2026", isbn: "978-0-306-40615-7" }
      })
    ).toEqual({ kind: "change", patch: { isbn: "9780306406157" } });
  });

  it("accepts a complete ISBN supplied in one earlier reader turn", () => {
    expect(decide("Set the ISBN", "9780306406157", { readerTurns: ["2026", "978 0 306 40615 7", "42"] })).toEqual({
      kind: "change",
      patch: { isbn: "9780306406157" }
    });
  });

  it("refuses an ISBN assembled from separate reader turns", () => {
    expect(
      decide("Set the ISBN", "9780306406157", { readerTurns: ["9780306", "406157"] })
    ).toEqual({ kind: "refused", problem: { kind: "not_given", field: "isbn" } });
  });
});
