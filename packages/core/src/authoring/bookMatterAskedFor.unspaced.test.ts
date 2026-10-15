import { describe, expect, it } from "vitest";

import {
  bookMatterChatAnswerSchema,
  normalizeBookMatterChatAnswer,
  type BookMatterChatAnswer,
  type BookMatterChatContext,
  type BookMatterChatCurrent
} from "./bookMatterChatEdit.js";

const current: BookMatterChatCurrent = {
  authorName: null,
  dedication: null,
  aboutAuthor: null,
  authorWebsite: null,
  copyrightHolder: null,
  imprint: "山田出版",
  isbn: null,
  allRightsReserved: false
};

function decide(message: string, changes: BookMatterChatAnswer["changes"], context: Partial<BookMatterChatContext> = {}) {
  return normalizeBookMatterChatAnswer(bookMatterChatAnswerSchema.parse({ outcome: "change", changes }), {
    message,
    bookLanguage: "zh",
    current,
    ...context
  });
}

describe("unspaced matter content owning field cues", () => {
  it("does not remove the publisher mentioned only in a supplied Chinese dedication", () => {
    const message = "把献辞改为献给在出版社工作的母亲";
    expect(
      decide(message, [
        { field: "dedication", action: "set", text: "献给在出版社工作的母亲", requestedBy: message },
        { field: "imprint", action: "remove", text: null, requestedBy: message }
      ])
    ).toEqual({ kind: "change", patch: { dedication: "献给在出版社工作的母亲" } });
  });

  it.each([
    ["把献辞改为献给在出版社工作的母亲和在出版社工作的父亲", "献给在出版社工作的母亲和在出版社工作的父亲"],
    ["把献辞改为献给在出版社工作的母亲，和在出版社工作的父亲", "献给在出版社工作的母亲，和在出版社工作的父亲"],
    ["把献辞改为献给在ＡＢＣ出版社工作２０年的母亲", "献给在abc出版社工作20年的母亲"],
    ["把献辞改为献给在ABC出版社工作۲۰年的母亲", "献给在ＡＢＣ出版社工作２０年的母亲"]
  ])("keeps repeated and normalized publisher references as dedication content: %s", (message, text) => {
    expect(
      decide(message, [
        { field: "dedication", action: "set", text, requestedBy: message },
        { field: "imprint", action: "remove", text: null, requestedBy: message }
      ])
    ).toEqual({ kind: "change", patch: { dedication: text } });
  });

  it.each([
    "删除出版社并把献辞改为献给在出版社工作的母亲",
    "把献辞改为献给在出版社工作的母亲并删除出版社",
    "删除出版社。把献辞改为献给在出版社工作的母亲",
    "把献辞改为献给在出版社工作的母亲。删除出版社",
    "删除出版社并把献辞改为献给在出版社工作的母亲和在出版社工作的父亲",
    "把献辞改为献给在出版社工作的母亲和在出版社工作的父亲并删除出版社"
  ])("keeps a separately requested removal before or after the printed content: %s", (message) => {
    const text = message.includes("父亲") ? "献给在出版社工作的母亲和在出版社工作的父亲" : "献给在出版社工作的母亲";
    expect(
      decide(message, [
        { field: "dedication", action: "set", text, requestedBy: message },
        { field: "imprint", action: "remove", text: null, requestedBy: message }
      ])
    ).toEqual({ kind: "change", patch: { dedication: text, imprint: null } });
  });

  it("keeps a removal quoting only its own clause, beside content that prints the same cue", () => {
    const message = "删除出版社并把献辞改为献给在出版社工作的母亲";
    expect(
      decide(message, [
        { field: "dedication", action: "set", text: "献给在出版社工作的母亲", requestedBy: "把献辞改为献给在出版社工作的母亲" },
        { field: "imprint", action: "remove", text: null, requestedBy: "删除出版社" }
      ])
    ).toEqual({ kind: "change", patch: { dedication: "献给在出版社工作的母亲", imprint: null } });
  });

  it.each(["把献辞改为出版社并删除出版社", "删除出版社并把献辞改为出版社"])(
    "reserves the separately supplied content when the removal quotes only its own clause: %s",
    (message) => {
      expect(
        decide(message, [
          { field: "dedication", action: "set", text: "出版社", requestedBy: message },
          { field: "imprint", action: "remove", text: null, requestedBy: "删除出版社" }
        ])
      ).toEqual({ kind: "change", patch: { dedication: "出版社", imprint: null } });
    }
  );

  it("does not let a reprinted existing dedication absorb the publisher removal", () => {
    const message = "删除出版社";
    const dedication = "献给在出版社工作的母亲";
    expect(
      decide(message, [
        { field: "dedication", action: "set", text: dedication, requestedBy: message },
        { field: "imprint", action: "remove", text: null, requestedBy: message }
      ], { current: { ...current, dedication }, lastTurnFields: ["dedication"] })
    ).toEqual({ kind: "change", patch: { imprint: null } });
  });
});
