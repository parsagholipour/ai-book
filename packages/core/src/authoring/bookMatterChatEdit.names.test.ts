import { describe, expect, it } from "vitest";

import {
  normalizeBookMatterChatAnswer,
  type BookMatterChatCurrent
} from "./bookMatterChatEdit.js";

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

function byline(bookLanguage: string, authorName: string, message: string, text: string) {
  return normalizeBookMatterChatAnswer(
    { outcome: "change", changes: [{ field: "authorName", action: "set", text, requestedBy: message }] },
    { message, current: { ...current, authorName }, bookLanguage }
  );
}

describe("unspaced coauthor names", () => {
  it.each([
    ["zh", "张三", "把李四也加为作者", "张三和李四"],
    ["zh", "张三", "把李四也加为作者", "张三与李四"],
    ["zh-TW", "張三", "把李四也加為作者", "張三與李四"],
    ["zh", "张三", "把李四也加为作者", "张三及李四"],
    ["ja", "山田太郎", "佐藤花子も著者名に追加してください", "山田太郎と佐藤花子"],
    ["ja", "山田太郎", "佐藤花子も著者名に追加してください", "山田太郎および佐藤花子"],
    ["Japanese", "山田太郎", "佐藤花子も著者名に追加してください", "山田太郎及び佐藤花子"],
    ["ko", "김민수", "이영희를 저자 이름에 추가해주세요", "김민수와이영희"],
    ["ko", "김민수", "이영희를 저자 이름에 추가해주세요", "김민수및이영희"],
    ["ko", "김민수", "이영희를 저자 이름에 추가해주세요", "김민수과이영희"],
    ["th", "สมชาย", "เพิ่มสมหญิงเป็นผู้เขียนร่วม", "สมชายและสมหญิง"]
  ])("joins the current author and the requested coauthor in %s", (language, author, message, text) => {
    expect(byline(language, author, message, text)).toEqual({ kind: "change", patch: { authorName: text } });
  });

  it.each([
    ["ko", "김민수", "이영희를 저자 이름에 추가해주세요", "김민수와 이영희"],
    ["ko", "김민수", "이영희를 저자 이름에 추가해주세요", "김민수 와이영희"],
    ["ko", "김민수", "이영희를 저자 이름에 추가해주세요", "김민수 와 이영희"],
    ["ko", "김민수", "이영희를 저자 이름에 추가해주세요", "김민수 및 이영희"],
    ["ko", "김 민수", "이영희를 저자 이름에 추가해주세요", "김 민수와 이영희"],
    ["ko", "김민수와 이영희", "박지훈을 저자 이름에 추가해주세요", "김민수와 이영희 및 박지훈"],
    ["ko", "김민수", "이영희와 박지훈을 저자 이름에 추가해주세요", "김민수와 이영희및 박지훈"],
    ["ja", "山田太郎", "佐藤花子も著者名に追加してください", "山田太郎と 佐藤花子"],
    ["ja", "山田太郎", "佐藤花子も著者名に追加してください", "山田太郎 と佐藤花子"],
    ["ja", "山田太郎と 佐藤花子", "鈴木一郎も著者名に追加してください", "山田太郎と 佐藤花子および 鈴木一郎"],
    ["ja", "さとみ", "ともこも著者名に追加してください", "さとみと ともこ"],
    ["zh", "王和明", "把李四也加为作者", "王和明和 李四"]
  ])("preserves whitespace around grounded localized connectors in %s: %s / %s / %s", (language, author, message, text) => {
    expect(byline(language, author, message, text)).toEqual({ kind: "change", patch: { authorName: text } });
  });

  it.each([
    ["zh", "张三与李四", "把王五也加为作者", "张三与李四和王五"],
    ["ja", "さとみ", "ともこも著者名に追加してください", "さとみとともこ"],
    ["ja", "さとみとたかし", "ともこも著者名に追加してください", "さとみとたかしとともこ"],
    ["zh", "王和明", "把李四也加为作者", "王和明和李四"]
  ])("preserves a connector inside a grounded name or existing byline in %s", (language, author, message, text) => {
    expect(byline(language, author, message, text)).toEqual({ kind: "change", patch: { authorName: text } });
  });

  it.each([
    ["zh", "张三", "把李四也加为作者", "张三和王五"],
    ["ja", "山田太郎", "佐藤花子も著者名に追加してください", "山田太郎と鈴木一郎"],
    ["ko", "김민수", "이영희를 저자 이름에 추가해주세요", "김민수와박지훈"],
    ["th", "สมชาย", "เพิ่มสมหญิงเป็นผู้เขียนร่วม", "สมชายและกิตติ"],
    ["en", "张三", "Add 李四 as coauthor", "张三和李四"],
    ["zh", "张三", "把李四也加为作者", "张三と李四"],
    ["zh", "张三", "把李四也加为作者", "和张三李四"],
    ["zh", "张三", "把李四也加为作者", "张三李四和"],
    ["zh", "张三", "把李四也加为作者", "张三和和李四"],
    ["ja", "山田太郎", "佐藤花子も著者名に追加してください", "山田太郎とと佐藤花子"],
    ["ja", "山田太郎", "佐藤花子も著者名に追加してください", "山田太郎E.と佐藤花子"],
    ["zh", "张三", "把李四也加为作者", "张三和I.李四"],
    ["ko", "김민수", "이영희를 저자 이름에 추가해주세요", "김민수와 박지훈"],
    ["ko", "김민수", "이영희를 저자 이름에 추가해주세요", "김민수와 와 이영희"],
    ["ko", "김민수", "이영희를 저자 이름에 추가해주세요", "김민수 と 이영희"],
    ["ko", "김민수", "이영희를 저자 이름에 추가해주세요", "김민수 E.와 이영희"],
    ["ko", "김 민수", "이영희를 저자 이름에 추가해주세요", "김민수와 이영희"],
    ["ja", "山田太郎", "佐藤花子も著者名に追加してください", "山田太郎と と佐藤花子"],
    ["ja", "山田太郎", "佐藤花子も著者名に追加してください", "山田太郎と 鈴木一郎"],
    ["en", "김민수", "Add 이영희 as coauthor", "김민수와 이영희"]
  ])("refuses invented names, initials, or unsupported connectors in %s: %s / %s / %s", (language, author, message, text) => {
    expect(byline(language, author, message, text)).toEqual({
      kind: "refused", problem: { kind: "not_given", field: "authorName" }
    });
  });
});
