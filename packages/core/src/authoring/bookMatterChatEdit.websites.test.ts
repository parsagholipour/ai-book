import { describe, expect, it } from "vitest";

import { normalizeBookMatterChatAnswer, type BookMatterChatCurrent } from "./bookMatterChatEdit.js";
import { normalizeReviewedMatterAnswer } from "./testing/reviewedMatterAnswer.js";

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

function website(message: string, text: string, storedWebsite: string | null = null) {
  return normalizeBookMatterChatAnswer(
    { outcome: "change", changes: [{ field: "authorWebsite", action: "set", text, requestedBy: message }] },
    { message, current: { ...current, authorWebsite: storedWebsite } }
  );
}

describe("website grounding in matter chat", () => {
  it.each([
    "https://例子.公司",
    "例子.公司",
    "https://alice.dev?ref=book",
    "https://alice.dev:443",
    "https://alice.dev:8443/books?ref=Book#About",
    "https://alice.dev#about",
    "https://alice.dev?ref=/",
    "https://alice.dev?ref=book!",
    "https://例子.公司/著者?言語=日本語",
    "https://xn--fsqu00a.xn--55qx5d",
    "alice.dev?ref=book",
    "alice.dev:8443/about",
    "https://ALICE.dev/About?ref=Book"
  ])("prints the complete address as given: %s", (address) => {
    expect(website(`Set my website to ${address}`, address)).toEqual({
      kind: "change", patch: { authorWebsite: address }
    });
  });

  it.each([
    ["Set my website to (https://例子.公司).", "https://例子.公司"],
    ["Set my website to “https://alice.dev?ref=book”.", "https://alice.dev?ref=book"],
    ["我的网站是https://例子.公司。", "https://例子.公司"]
  ])("separates surrounding punctuation from the address", (message, address) => {
    expect(website(message, address)).toEqual({ kind: "change", patch: { authorWebsite: address } });
  });

  it.each([
    ["我的网站是example.com。", "example.com"],
    ["把网站改为alice.dev", "alice.dev"],
    ["我的网站是例子.公司。", "例子.公司"],
    ["ウェブサイトをexample.comに変更してください", "example.com"],
    ["웹사이트를example.com으로 변경해주세요", "example.com"],
    ["我的网站是alice.dev/About?ref=Book。", "alice.dev/About?ref=Book"],
    ["ウェブサイトを例子.公司に変更してください", "例子.公司"],
    ["웹사이트를例子.公司로 변경해주세요", "例子.公司"],
    ["ウェブサイトをexample.com/About?ref=Bookに変更してください", "example.com/About?ref=Book"],
    ["웹사이트를example.com/About?ref=Book으로 변경해주세요", "example.com/About?ref=Book"]
  ])("grounds the whole address beside an unspaced request: %s", (message, address) => {
    expect(website(message, address)).toEqual({ kind: "change", patch: { authorWebsite: address } });
  });

  it.each([
    ["我的网站是notexample.com。", "example.com"],
    ["我的网站是别的例子.公司。", "例子.公司"],
    ["我的网站是前缀example.com。", "example.com"],
    ["我的网站是example.com.别的公司。", "example.com"],
    ["我的网站是writer@example.com。", "example.com"],
    ["ウェブサイトをwriter@example.comに変更してください", "example.com"],
    ["웹사이트를writer@example.com으로 변경해주세요", "example.com"],
    ["我的网站是example.com/About?ref=Book。", "example.com/about?ref=Book"],
    ["ウェブサイトをexample.com/About?ref=Bookに変更してください", "example.com/About?ref=book"],
    ["웹사이트를example.com으로 변경해주세요", "example.com/invented"]
  ])("does not ground a different address from an unspaced request: %s", (message, address) => {
    expect(website(message, address)).toEqual({ kind: "refused", problem: { kind: "not_given", field: "authorWebsite" } });
  });

  it.each([
    "我的网站是例子.公司",
    "ウェブサイトを例子.公司",
    "웹사이트를例子.公司",
    "例子.公司に変更してください",
    "例子.公司으로"
  ])("keeps instruction-like text inside an explicitly supplied IDN: %s", (address) => {
    expect(website(`Set my website to ${address}`, address)).toEqual({ kind: "change", patch: { authorWebsite: address } });
    expect(website(`我的网站是https://${address}。`, `https://${address}`)).toEqual({
      kind: "change", patch: { authorWebsite: `https://${address}` }
    });
  });

  it.each([
    ["https://alice.dev?ref=book", "alice.dev"],
    ["https://alice.dev:8443/about", "alice.dev:8443"],
    ["https://例子.公司/著者", "例子.公司"]
  ])("allows the host of the supplied website", (given, host) => {
    expect(website(`Use the website ${given}`, host)).toEqual({ kind: "change", patch: { authorWebsite: host } });
  });

  it("grounds an international address from the book's existing matter", () => {
    expect(website("Print my website", "https://例子.公司?ref=book", "https://例子.公司?ref=book")).toEqual({
      kind: "change", patch: { authorWebsite: "https://例子.公司?ref=book" }
    });
  });

  it.each([
    ["alice.dev", "alice.dev?ref=invented"],
    ["alice.dev", "alice.dev?"],
    ["alice.dev", "alice.dev:443"],
    ["alice.dev", "alice.dev/about"],
    ["alice.dev", "alice.dev#invented"],
    ["alice.dev?ref=Book", "alice.dev?ref=book"],
    ["alice.dev/About", "alice.dev/about"],
    ["https://例子.公司", "https://別人.公司"],
    ["writer@例子.公司", "例子.公司"],
    ["writer@alice.dev", "alice.dev"],
    ["alice.dev", "writer@alice.dev"]
  ])("refuses a different address or invented component: %s to %s", (given, proposed) => {
    expect(website(`Set my website to ${given}`, proposed)).toEqual({
      kind: "refused", problem: { kind: "not_given", field: "authorWebsite" }
    });
  });

  it.each(["https://例子.公司", "https://alice.dev?ref=invented", "https://alice.dev:8443"])(
    "refuses an invented complete address in a biography: %s", (address) => {
      const message = "Write my bio: I write novels. My website is alice.dev";
      expect(normalizeBookMatterChatAnswer(
        { outcome: "change", changes: [{ field: "aboutAuthor", action: "set", text: `I write novels. Visit ${address}`, requestedBy: message }] },
        { message, current }
      )).toEqual({ kind: "refused", problem: { kind: "not_given", field: "aboutAuthor" } });
    }
  );

  it.each([
    ["alice.dev?ref=book", "I write novels. Visit alice.dev?ref=book."],
    ["https://例子.公司/著者", "I write novels. Visit https://例子.公司/著者。"],
    ["alice.dev?ref=book!", "I write novels. Visit alice.dev?ref=book!"]
  ])("keeps a supplied address in a biography with sentence punctuation", (address, text) => {
    const message = `Write my bio: I write novels. My website is ${address}`;
    expect(normalizeReviewedMatterAnswer(
      { outcome: "change", changes: [{ field: "aboutAuthor", action: "set", text, requestedBy: message }] },
      { message, current }
    )).toEqual({ kind: "change", patch: { aboutAuthor: text } });
  });
});
