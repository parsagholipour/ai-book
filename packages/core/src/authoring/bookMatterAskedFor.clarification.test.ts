import { describe, expect, it } from "vitest";

import {
  normalizeBookMatterChatAnswer,
  type BookMatterChatAnswer,
  type BookMatterChatCurrent
} from "./bookMatterChatEdit.js";

const current: BookMatterChatCurrent = {
  authorName: "Ana Ruiz", dedication: null, aboutAuthor: null, authorWebsite: null,
  copyrightHolder: null, imprint: "Lantern Press", isbn: null, allRightsReserved: false
};

function clarify(originalRequest: string, followUp: string, changes: BookMatterChatAnswer["changes"], bookLanguage = "en") {
  return normalizeBookMatterChatAnswer({ outcome: "change", changes }, {
    message: `${originalRequest}\n\nFollow-up from the user: ${followUp}`,
    originalRequest,
    current,
    bookLanguage
  });
}

describe("field ownership through a matter clarification", () => {
  it.each(["publisher", "Write my bio: I am a publisher", "Add that I write novels"])(
    "does not remove an imprint mentioned only in biography content, quoting %s",
    (requestedBy) => {
      const originalRequest = "Write my bio: I am a publisher";
      expect(clarify(originalRequest, "Add that I write novels", [
        { field: "aboutAuthor", action: "set", text: "I am a publisher", requestedBy: originalRequest },
        { field: "imprint", action: "remove", requestedBy }
      ])).toEqual({ kind: "change", patch: { aboutAuthor: "I am a publisher" } });
    }
  );

  it.each([
    ["es", "aboutAuthor", "Escribe mi biografía: trabajo en una editorial", "trabajo en una editorial"],
    ["fa", "aboutAuthor", "زندگینامه من را بنویس: من ناشر هستم", "من ناشر هستم"],
    ["zh", "dedication", "把献辞改为献给在出版社工作的母亲", "献给在出版社工作的母亲"]
  ] as const)("keeps %s supplied prose from authorizing an imprint deletion", (bookLanguage, field, originalRequest, text) => {
    expect(clarify(originalRequest, "Yes", [
      { field, action: "set", text, requestedBy: "Yes" },
      { field: "imprint", action: "remove", requestedBy: "Yes" }
    ], bookLanguage)).toEqual({ kind: "change", patch: { [field]: text } });
  });

  it.each(["Remove the publisher and write my bio: I am a publisher", "Write my bio: I am a publisher. Remove the publisher"])(
    "retains the independently requested deletion: %s", (originalRequest) => {
      for (const requestedBy of [originalRequest, "Yes"]) {
        expect(clarify(originalRequest, "Yes", [
          { field: "aboutAuthor", action: "set", text: "I am a publisher", requestedBy },
          { field: "imprint", action: "remove", requestedBy }
        ])).toEqual({ kind: "change", patch: { aboutAuthor: "I am a publisher", imprint: null } });
      }
    }
  );

  it("keeps a Chinese deletion requested beside the supplied dedication", () => {
    const originalRequest = "把献辞改为献给在出版社工作的母亲并删除出版社";
    expect(clarify(originalRequest, "是", [
      { field: "dedication", action: "set", text: "献给在出版社工作的母亲", requestedBy: "是" },
      { field: "imprint", action: "remove", requestedBy: "是" }
    ], "zh")).toEqual({ kind: "change", patch: { dedication: "献给在出版社工作的母亲", imprint: null } });
  });

  it("does not let newly supplied follow-up prose consume an original removal request", () => {
    const followUp = "I am a publisher";
    expect(clarify("Remove the publisher and write my bio", followUp, [
      { field: "aboutAuthor", action: "set", text: followUp, requestedBy: followUp },
      { field: "imprint", action: "remove", requestedBy: followUp }
    ])).toEqual({ kind: "change", patch: { aboutAuthor: followUp, imprint: null } });
  });

  it.each(["Change the publisher", "Change the publisher to Moss Books"])("keeps a terse value answer attached to %s", (originalRequest) => {
    expect(clarify(originalRequest, "Moss Books", [
      { field: "imprint", action: "set", text: "Moss Books", requestedBy: "Moss Books" },
      { field: "copyrightHolder", action: "set", text: "Moss Books", requestedBy: "Moss Books" }
    ])).toEqual({ kind: "change", patch: { imprint: "Moss Books" } });
  });

  it("keeps a field named by its existing value in the original request", () => {
    expect(clarify("Remove Lantern Press", "Yes", [
      { field: "imprint", action: "remove", requestedBy: "Remove Lantern Press" },
      { field: "copyrightHolder", action: "remove", requestedBy: "Yes" }
    ])).toEqual({ kind: "change", patch: { imprint: null } });
  });

  it("does not remove a field whose existing value is supplied biography content", () => {
    const originalRequest = "Write my bio: I worked at Lantern Press";
    expect(clarify(originalRequest, "Yes", [
      { field: "aboutAuthor", action: "set", text: "I worked at Lantern Press", requestedBy: "Yes" },
      { field: "imprint", action: "remove", requestedBy: "Yes" }
    ])).toEqual({ kind: "change", patch: { aboutAuthor: "I worked at Lantern Press" } });
  });
});
