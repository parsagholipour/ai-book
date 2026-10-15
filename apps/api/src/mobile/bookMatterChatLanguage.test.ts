import { describe, expect, it } from "vitest";
import { CONVERSATION_LANGUAGES } from "@book-maker/core";
import { establishedChatLanguage, matterChatLanguage } from "./bookMatterChatLanguage.js";

describe("model-selected conversation language", () => {
  it.each(CONVERSATION_LANGUAGES)("uses the current model decision %s ahead of saved context", (language) => {
    expect(matterChatLanguage(language, [
      { role: "ASSISTANT", metadata: { replyLanguage: "fa" } }
    ])).toBe(language);
  });

  it("retains the latest saved language when the model has no decision", () => {
    expect(matterChatLanguage(undefined, [
      { role: "ASSISTANT", metadata: { replyLanguage: "fa" } },
      { role: "ASSISTANT", metadata: { replyLanguage: "ar" } },
      { role: "USER", metadata: { replyLanguage: "fr" } },
      { role: "ASSISTANT", metadata: null }
    ])).toBe("ar");
  });

  it("retains a language established by another routed chat action", () => {
    expect(matterChatLanguage(undefined, [
      { role: "ASSISTANT", metadata: { replyLanguage: "fa" } },
      { role: "ASSISTANT", metadata: { intent: { kind: "answer", responseLanguage: "es" } } }
    ])).toBe("es");
  });

  it("prefers the composer's final language to the router's earlier hint on the same turn", () => {
    expect(matterChatLanguage(undefined, [
      { role: "ASSISTANT", metadata: { replyLanguage: "fr", intent: { responseLanguage: "en" } } }
    ])).toBe("fr");
  });

  it.each([undefined, null, "French", "xx", {}, 42])("ignores an unsupported model hint %j", (hint) => {
    expect(matterChatLanguage(hint, [
      { role: "ASSISTANT", metadata: { replyLanguage: "es" } },
      { role: "ASSISTANT", metadata: { replyLanguage: "not-a-locale", intent: { responseLanguage: "French" } } }
    ])).toBe("es");
    expect(matterChatLanguage(hint)).toBe("en");
  });

  it("tells a prompt no language when nothing was recorded, rather than an English one", () => {
    // A Persian chat from before reply languages were saved: the English
    // default is a reply's fallback, never a language the conversation set.
    const legacy = [
      { role: "USER", metadata: {} },
      { role: "ASSISTANT", metadata: { charged: false, intent: { kind: "answer" } } }
    ];
    expect(establishedChatLanguage(undefined, legacy)).toBeUndefined();
    expect(establishedChatLanguage("French", legacy)).toBeUndefined();
    expect(establishedChatLanguage(undefined)).toBeUndefined();
    expect(matterChatLanguage(undefined, legacy)).toBe("en");
    expect(establishedChatLanguage(undefined, [
      ...legacy, { role: "ASSISTANT", metadata: { replyLanguage: "en" } }
    ])).toBe("en");
    expect(establishedChatLanguage("fa", legacy)).toBe("fa");
  });

  it("does not infer language from shared vocabulary, quoted names or reply wording", () => {
    const recent = [
      { role: "USER", content: "هل يمكنك حذف عبارة Tomeza؟" },
      { role: "ASSISTANT", content: "عبارت Tomeza را از کتاب حذف می‌کنم." },
      { role: "USER", content: "김민수" }
    ];
    expect(matterChatLanguage(undefined, recent)).toBe("en");
    expect(matterChatLanguage("ar", recent)).toBe("ar");
  });
});
