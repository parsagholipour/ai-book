import { describe, expect, it } from "vitest";

import { normalizeBookMatterChatAnswer, type BookMatterChatCurrent } from "./bookMatterChatEdit.js";
import { bookMatterFieldsNamedIn, localizedBookMatterFieldsNamedIn } from "./bookMatterWords.js";

const current: BookMatterChatCurrent = {
  authorName: null, dedication: null, aboutAuthor: null, authorWebsite: null,
  copyrightHolder: null, imprint: null, isbn: null, allRightsReserved: false
};

describe("Chinese copyright holders and rights reservation", () => {
  it.each([
    ["zh", "把版权所有者改为李四"],
    ["zh", "把版权所有人改为李四"],
    ["zh-TW", "把版權所有者改為李四"],
    ["zh-TW", "把版權所有人改為李四"]
  ])("keeps the %s holder edit without a model-added rights toggle: %s", (bookLanguage, message) => {
    expect(normalizeBookMatterChatAnswer({
      outcome: "change",
      changes: [
        { field: "copyrightHolder", action: "set", text: "李四", requestedBy: message },
        { field: "allRightsReserved", action: "set", requestedBy: message }
      ]
    }, { message, current, bookLanguage })).toEqual({ kind: "change", patch: { copyrightHolder: "李四" } });

    expect([...bookMatterFieldsNamedIn(message)]).toEqual(["copyrightHolder"]);
    expect([...localizedBookMatterFieldsNamedIn(message)]).toEqual(["copyrightHolder"]);
  });

  it.each([
    ["zh", "把版权所有者改为李四", "set"],
    ["zh", "把版权所有人改为李四", "remove"],
    ["zh-TW", "把版權所有者改為李四", "remove"],
    ["zh-TW", "把版權所有人改為李四", "set"]
  ] as const)("rejects a rights-only answer to a %s holder request: %s (%s)", (bookLanguage, message, action) => {
    expect(normalizeBookMatterChatAnswer({
      outcome: "change", changes: [{ field: "allRightsReserved", action, requestedBy: message }]
    }, { message, current: { ...current, allRightsReserved: action === "remove" }, bookLanguage })).toEqual({
      kind: "none", reason: "not_matter"
    });
  });

  it.each([
    ["zh", "添加版权所有声明", "set", true],
    ["zh", "删除版权所有声明", "remove", false],
    ["zh-TW", "添加版權所有聲明", "set", true],
    ["zh-TW", "刪除版權所有聲明", "remove", false]
  ] as const)("keeps an explicit %s rights request: %s", (bookLanguage, message, action, allRightsReserved) => {
    expect(normalizeBookMatterChatAnswer({
      outcome: "change", changes: [{ field: "allRightsReserved", action, requestedBy: message }]
    }, { message, current: { ...current, allRightsReserved: !allRightsReserved }, bookLanguage })).toEqual({
      kind: "change", patch: { allRightsReserved }
    });
  });

  it.each([
    ["zh", "把版权所有者改为李四，并添加版权所有声明"],
    ["zh-TW", "把版權所有人改為李四，並添加版權所有聲明"]
  ])("keeps both changes when a %s request names both: %s", (bookLanguage, message) => {
    expect(normalizeBookMatterChatAnswer({
      outcome: "change",
      changes: [
        { field: "copyrightHolder", action: "set", text: "李四", requestedBy: message },
        { field: "allRightsReserved", action: "set", requestedBy: message }
      ]
    }, { message, current, bookLanguage })).toEqual({
      kind: "change", patch: { copyrightHolder: "李四", allRightsReserved: true }
    });
  });
});
