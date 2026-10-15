import { describe, expect, it } from "vitest";
import { normalizeBookMatterChatAnswer, type BookMatterChatCurrent } from "./bookMatterChatEdit.js";
import { bookMatterFieldsNamedIn, localizedBookMatterFieldsNamedIn } from "./bookMatterWords.js";

const current: BookMatterChatCurrent = {
  authorName: "Deniz Kaya", dedication: null, aboutAuthor: null, authorWebsite: null,
  copyrightHolder: null, imprint: null, isbn: null, allRightsReserved: false
};

describe("Turkish matter field requests", () => {
  it("keeps both the requested byline and dedication in a compound request", () => {
    const message = "Yazar adını Ayşe Yılmaz yap ve ithafı anneme değiştir";
    const result = normalizeBookMatterChatAnswer({ outcome: "change", changes: [
      { field: "authorName", action: "set", text: "Ayşe Yılmaz", requestedBy: "Yazar adını Ayşe Yılmaz yap" },
      { field: "dedication", action: "set", text: "Anneme", requestedBy: "ithafı anneme değiştir" }
    ] }, { message, current, bookLanguage: "tr" });
    expect(result).toEqual({ kind: "change", patch: { authorName: "Ayşe Yılmaz", dedication: "Anneme" } });
  });

  it.each([
    ["Yazar adını Ayşe Yılmaz yap", ["authorName"]],
    ["Yazar adımı Ayşe Yılmaz yap", ["authorName"]],
    ["Yazarın ismini Ayşe Yılmaz olarak değiştir", ["authorName"]],
    ["YAZAR İSMİNİ Ayşe Yılmaz yap", ["authorName"]],
    ["Kalem adımı Deniz yap", ["authorName"]],
    ["Takma adımı Deniz yap", ["authorName"]],
    ["Mahlasımı Deniz yap", ["authorName"]],
    ["İthafı anneme değiştir", ["dedication"]],
    ["Yazar: Ayşe Yılmaz", ["authorName"]],
    ["Ayşe Yılmaz'ı yazar olarak ekle", ["authorName"]],
    ["Ayşe Yılmaz'ı yazar olarak kaydedin", ["authorName"]],
    ["Yazarı kaldırın", ["authorName"]],
    ["Biyografimi kısalt", ["aboutAuthor"]],
    ["Yazar hakkındaki bölümü kısalt", ["aboutAuthor"]],
    ["Özgeçmişimi kaldır", ["aboutAuthor"]],
    ["Telif hakkı sahibini Deniz yap", ["copyrightHolder"]],
    ["Telif haklarının sahibini Deniz yap", ["copyrightHolder"]],
    ["Yayınevini Deniz yap", ["imprint"]],
    ["Yayıncıyı Deniz yap", ["imprint"]],
    ["İnternet sitemi kaldır", ["authorWebsite"]],
    ["Yazarın sitesini kaldır", ["authorWebsite"]],
    ["Tüm hakları saklıdır satırını ekle", ["allRightsReserved"]],
    ["Bütün hakları saklıdır satırını kaldır", ["allRightsReserved"]]
  ])("recognizes %s in the shared and localized cue readers", (message, fields) => {
    expect([...bookMatterFieldsNamedIn(message)]).toEqual(fields);
    expect([...localizedBookMatterFieldsNamedIn(message)]).toEqual(fields);
  });

  it.each([
    ["Ben bir yazar ve öğretmenim", []],
    ["Yazar olarak çalışıyorum", []],
    ["İki romanın yazarıyım", []],
    ["Ana karakteri yazar yap", []],
    ["Yazarın sesini değiştir", []],
    ["Yazarın fotoğrafını kapağa koy", []],
    ["Yazarın biyografisini kısalt", ["aboutAuthor"]],
    ["Yazar hakkında: Ben öğretmenim", ["aboutAuthor"]],
    ["Kitabı yazara ithaf et", ["dedication"]]
  ])("keeps profession and prose out of the byline cue: %s", (message, fields) => {
    expect([...bookMatterFieldsNamedIn(message)]).toEqual(fields);
  });

  it("does not let a dedication request change other fields", () => {
    const message = "Kitabı anneme ithaf et";
    const result = normalizeBookMatterChatAnswer({ outcome: "change", changes: [
      { field: "dedication", action: "set", text: "Anneme", requestedBy: message },
      { field: "authorName", action: "set", text: "Anneme", requestedBy: message },
      { field: "copyrightHolder", action: "set", text: "Anneme", requestedBy: message },
      { field: "allRightsReserved", action: "set", text: null, requestedBy: message }
    ] }, { message, current, bookLanguage: "tr" });
    expect(result).toEqual({ kind: "change", patch: { dedication: "Anneme" } });
  });

  it("does not treat the author's profession in biography prose as a second requested field", () => {
    const message = "Biyografimi yaz: Ben bir yazar ve öğretmenim";
    const result = normalizeBookMatterChatAnswer({ outcome: "change", changes: [
      { field: "aboutAuthor", action: "set", text: "Ben bir yazar ve öğretmenim.", requestedBy: message },
      { field: "authorName", action: "remove", text: null, requestedBy: "yazar" }
    ] }, { message, current, bookLanguage: "tr" });
    expect(result).toEqual({ kind: "change", patch: { aboutAuthor: "Ben bir yazar ve öğretmenim." } });
  });
});
