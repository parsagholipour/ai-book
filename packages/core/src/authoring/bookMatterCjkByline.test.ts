import { describe, expect, it } from "vitest";

import {
  bookMatterFieldsNamedIn,
  localizedBookMatterFieldsNamedIn,
  normalizeBookMatterChatAnswer,
  type BookMatterChatAnswer,
  type BookMatterChatCurrent
} from "./bookMatterChatEdit.js";

const current: BookMatterChatCurrent = {
  authorName: "旧名",
  dedication: "For my family",
  aboutAuthor: "An author who gardens.",
  authorWebsite: null,
  copyrightHolder: null,
  imprint: null,
  isbn: null,
  allRightsReserved: false
};

function decide(message: string, bookLanguage: string, changes: BookMatterChatAnswer["changes"]) {
  return normalizeBookMatterChatAnswer({ outcome: "change", changes }, { message, bookLanguage, current });
}

describe("contextual Chinese and Japanese byline requests", () => {
  it.each([
    ["zh", "作者改为李四，并删除献辞", "李四"],
    ["zh", "把作者改成李四，并删除献辞", "李四"],
    ["zh-TW", "作者改為李四，並刪除獻詞", "李四"],
    ["zh-TW", "把作者設為李四，並刪除獻詞", "李四"],
    ["ja", "著者を山田太郎に変更して、献辞を削除してください", "山田太郎"],
    ["ja", "著者を山田 太郎に変更して、献辞を削除してください", "山田 太郎"],
    ["ja", "献辞を削除して、著者を山田太郎に変更してください", "山田太郎"]
  ])("keeps the byline beside a separately requested removal: %s / %s", (language, message, authorName) => {
    expect(decide(message, language, [
      { field: "authorName", action: "set", text: authorName, requestedBy: message },
      { field: "dedication", action: "remove", text: null, requestedBy: message },
      { field: "aboutAuthor", action: "remove", text: null, requestedBy: message },
      { field: "copyrightHolder", action: "set", text: authorName, requestedBy: message }
    ])).toEqual({ kind: "change", patch: { authorName, dedication: null } });
    expect(localizedBookMatterFieldsNamedIn(message)).toContain("authorName");
  });

  it("ends the name at its command before an unpunctuated biography request", () => {
    const message = "著者を山田太郎に変更して著者紹介を削除してください";
    expect(decide(message, "ja", [
      { field: "authorName", action: "set", text: "山田太郎", requestedBy: message },
      { field: "aboutAuthor", action: "remove", text: null, requestedBy: message }
    ])).toEqual({ kind: "change", patch: { authorName: "山田太郎", aboutAuthor: null } });
  });

  it.each([
    ["zh", "删除作者，并删除献辞"],
    ["zh", "把作者去掉，并删除献辞"],
    ["zh-TW", "刪除作者，並刪除獻詞"],
    ["zh-TW", "把作者移除，並刪除獻詞"],
    ["ja", "著者を削除して、献辞を削除してください"]
  ])("allows an explicit byline removal in a compound request: %s / %s", (language, message) => {
    expect(decide(message, language, [
      { field: "authorName", action: "remove", text: null, requestedBy: message },
      { field: "dedication", action: "remove", text: null, requestedBy: message },
      { field: "aboutAuthor", action: "remove", text: null, requestedBy: message }
    ])).toEqual({ kind: "change", patch: { authorName: null, dedication: null } });
  });

  it.each([
    ["zh", "删除作者简介", "aboutAuthor"],
    ["zh-TW", "刪除作者簡介", "aboutAuthor"],
    ["ja", "著者紹介を削除してください", "aboutAuthor"],
    ["zh", "删除关于作者的页面", "aboutAuthor"],
    ["zh-TW", "刪除關於作者的頁面", "aboutAuthor"],
    ["ja", "著者についてのページを削除してください", "aboutAuthor"],
    ["zh", "删除版权持有者", "copyrightHolder"],
    ["zh-TW", "刪除版權持有者", "copyrightHolder"],
    ["ja", "著作権者を削除してください", "copyrightHolder"]
  ] as const)("rejects a byline removal riding on another field: %s / %s", (language, message, field) => {
    expect(bookMatterFieldsNamedIn(message)).not.toContain("authorName");
    expect(decide(message, language, [
      { field, action: "remove", text: null, requestedBy: message },
      { field: "authorName", action: "remove", text: null, requestedBy: message }
    ])).toEqual({ kind: "change", patch: { [field]: null } });
  });

  it.each([
    "我是儿童故事的作者，也喜欢园艺",
    "我是兒童故事的作者，也喜歡園藝",
    "私は児童書の著者で、園芸も好きです",
    "作者的照片改为李四的照片",
    "作者的介紹改為李四的介紹",
    "把作者去掉眼镜后的照片放在封面上",
    "著者の写真を山田太郎の写真に変更してください",
    "著者を紹介する文章に変更してください",
    "著者を詳しく紹介する文章に変更してください",
    "关于作者：李四",
    "關於作者：李四"
  ])("does not interpret author prose or author-related pages as a byline request: %s", (message) => {
    expect(bookMatterFieldsNamedIn(message)).not.toContain("authorName");
    expect(decide(message, "zh", [
      { field: "authorName", action: "remove", text: null, requestedBy: message }
    ])).toEqual({ kind: "none", reason: "not_matter" });
  });
});
