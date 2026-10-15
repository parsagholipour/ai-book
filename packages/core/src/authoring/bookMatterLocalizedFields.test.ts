import { describe, expect, it } from "vitest";

import {
  normalizeBookMatterChatAnswer,
  type BookMatterChatAnswer,
  type BookMatterChatCurrent,
  type BookMatterChatLanguage
} from "./bookMatterChatEdit.js";

const current: BookMatterChatCurrent = {
  authorName: "Ana Ruiz", dedication: "For Mom", aboutAuthor: "Ana writes books.", authorWebsite: "ana.dev",
  copyrightHolder: "Ruiz Media", imprint: "Lantern Press", isbn: null, allRightsReserved: true
};

function decide(message: string, changes: BookMatterChatAnswer["changes"], bookLanguage: BookMatterChatLanguage) {
  return normalizeBookMatterChatAnswer({ outcome: "change", changes }, { message, current, bookLanguage });
}

const rightsRequests = [
  ["zh", "添加保留所有权利声明", "删除保留所有权利声明"],
  ["ja", "権利留保の表示を追加してください", "権利留保の表示を削除してください"],
  ["de", "Füge den Rechtevorbehalt hinzu", "Entferne den Rechtevorbehalt"],
  ["ko", "권리 보유 문구를 추가해 주세요", "권리 보유 문구를 삭제해 주세요"],
  ["ru", "Добавь строку об охране прав", "Удали строку об охране прав"],
  ["tr", "Haklar saklıdır satırını ekle", "Haklar saklıdır satırını kaldır"]
] as const;

describe("requests using translated matter field labels", () => {
  it.each(rightsRequests)("sets and removes the %s rights line without changing the holder or byline", (language, add, remove) => {
    for (const [message, action] of [[add, "set"], [remove, "remove"]] as const) {
      expect(decide(message, [
        { field: "allRightsReserved", action, requestedBy: message },
        { field: "copyrightHolder", action: "remove", requestedBy: message },
        { field: "authorName", action: "remove", requestedBy: message }
      ], language)).toEqual({ kind: "change", patch: { allRightsReserved: action === "set" } });
    }
  });

  it.each([
    ["fr", "Supprime mon site web"],
    ["pt", "Remova meu site"]
  ] as const)("removes the %s website without removing the biography", (language, message) => {
    expect(decide(message, [
      { field: "authorWebsite", action: "remove", requestedBy: message },
      { field: "aboutAuthor", action: "remove", requestedBy: message }
    ], language)).toEqual({ kind: "change", patch: { authorWebsite: null } });
  });

  it("keeps a Chinese imprint change beside a separately requested dedication removal", () => {
    const imprint = "出版方改为晨星";
    const removal = "删除献辞";
    expect(decide(`${imprint}，并${removal}`, [
      { field: "imprint", action: "set", text: "晨星", requestedBy: imprint },
      { field: "dedication", action: "remove", requestedBy: removal },
      { field: "allRightsReserved", action: "set", requestedBy: imprint }
    ], "zh")).toEqual({ kind: "change", patch: { imprint: "晨星", dedication: null } });
  });

  it("changes the Urdu holder without changing rights or the byline", () => {
    const message = "حقوق کے مالک کو علی رضا کریں";
    expect(decide(message, [
      { field: "copyrightHolder", action: "set", text: "علی رضا", requestedBy: message },
      { field: "authorName", action: "set", text: "علی رضا", requestedBy: message },
      { field: "allRightsReserved", action: "remove", requestedBy: message }
    ], "ur")).toEqual({ kind: "change", patch: { copyrightHolder: "علی رضا" } });
  });

  it.each(["Rimuovi la pagina L’autore", "Rimuovi la sezione «L'autore»"])("removes the Italian biography page in %j while retaining the byline", (message) => {
    expect(decide(message, [
      { field: "aboutAuthor", action: "remove", requestedBy: message },
      { field: "authorName", action: "remove", requestedBy: message }
    ], "it")).toEqual({ kind: "change", patch: { aboutAuthor: null } });
  });

  it("keeps an Italian byline request from also naming the biography", () => {
    const message = "Cambia l’autore in Luca Rossi";
    expect(decide(message, [
      { field: "authorName", action: "set", text: "Luca Rossi", requestedBy: message },
      { field: "aboutAuthor", action: "remove", requestedBy: message }
    ], "it")).toEqual({ kind: "change", patch: { authorName: "Luca Rossi" } });
  });

  it("writes text after the Italian page label without also removing the byline", () => {
    const value = "Scrive racconti brevi";
    const message = `Aggiorna la pagina L’autore: ${value}`;
    expect(decide(message, [
      { field: "aboutAuthor", action: "set", text: value, requestedBy: message },
      { field: "authorName", action: "remove", requestedBy: message }
    ], "it")).toEqual({ kind: "change", patch: { aboutAuthor: value } });
  });

  it.each(rightsRequests)("keeps a quoted %s rights request as biography text", (language, value) => {
    const message = `Bio: «${value}»`;
    expect(decide(message, [
      { field: "aboutAuthor", action: "set", text: value, requestedBy: message },
      { field: "allRightsReserved", action: "set", requestedBy: value }
    ], language)).toEqual({ kind: "change", patch: { aboutAuthor: value } });
  });

  it.each([
    ["fr", "Elle construit mon site web", "authorWebsite"],
    ["pt", "Ela administra meu site", "authorWebsite"],
    ["it", "L’autore passeggia ogni mattina", "authorName"],
    ["zh", "她在出版方工作", "imprint"],
    ["ur", "وہ حقوق کے مالک کی مدد کرتی ہیں", "copyrightHolder"]
  ] as const)("keeps %s biography prose from removing a mentioned field", (language, value, field) => {
    const message = `Bio: ${value}`;
    expect(decide(message, [
      { field: "aboutAuthor", action: "set", text: value, requestedBy: message },
      { field, action: "remove", requestedBy: message }
    ], language)).toEqual({ kind: "change", patch: { aboutAuthor: value } });
  });
});
