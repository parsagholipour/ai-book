import { describe, expect, it } from "vitest";

import { normalizeBookMatterChatAnswer, type BookMatterChatAnswer, type BookMatterChatCurrent } from "./bookMatterChatEdit.js";

const current: BookMatterChatCurrent = {
  authorName: null, dedication: null, aboutAuthor: null, authorWebsite: null,
  copyrightHolder: null, imprint: null, isbn: null, allRightsReserved: false
};

const names = [
  ["en", "copyrightHolder", "Set the copyright holder to All Rights Press", "All Rights Press"],
  ["en", "imprint", "Set the publisher to All Rights Reserved Press", "All Rights Reserved Press"],
  ["en", "authorName", "Set the author to All Rights", "All Rights"],
  ["ar", "imprint", "الناشر: دار جميع الحقوق", "دار جميع الحقوق"],
  ["fa", "imprint", "ناشر: انتشارات کلیه حقوق", "انتشارات کلیه حقوق"]
] as const;

describe("rights cues inside supplied matter text", () => {
  it.each(names)("keeps the %s %s value without toggling rights: %s", (bookLanguage, field, message, text) => {
    for (const action of ["set", "remove"] as const) {
      expect(normalizeBookMatterChatAnswer({ outcome: "change", changes: [
        { field, action: "set", text, requestedBy: message },
        { field: "allRightsReserved", action, requestedBy: message }
      ] }, { message, current: { ...current, allRightsReserved: action === "remove" }, bookLanguage })).toEqual({
        kind: "change", patch: { [field]: text }
      });
    }
  });

  it.each(names)("does not authorize rights from a %s clarification's original %s request", (bookLanguage, field, originalRequest, text) => {
    const message = `${originalRequest}\n\nFollow-up from the user: Yes`;
    expect(normalizeBookMatterChatAnswer({ outcome: "change", changes: [
      { field, action: "set", text, requestedBy: "Yes" },
      { field: "allRightsReserved", action: "set", requestedBy: "Yes" }
    ] }, { message, originalRequest, current, bookLanguage })).toEqual({ kind: "change", patch: { [field]: text } });
  });

  it("does not treat a clarification answer's publisher name as a rights request", () => {
    const originalRequest = "Set the publisher";
    const message = `${originalRequest}\n\nFollow-up from the user: All Rights Press`;
    expect(normalizeBookMatterChatAnswer({ outcome: "change", changes: [
      { field: "imprint", action: "set", text: "All Rights Press", requestedBy: "All Rights Press" },
      { field: "allRightsReserved", action: "set", requestedBy: "All Rights Press" }
    ] }, { message, originalRequest, current, bookLanguage: "en" })).toEqual({ kind: "change", patch: { imprint: "All Rights Press" } });
  });

  it.each(["", " and add all rights reserved"])("excludes the same supplied name in two field requests%s", (rightsRequest) => {
    const message = `Set the copyright holder to All Rights Press and set the publisher to All Rights Press${rightsRequest}`;
    expect(normalizeBookMatterChatAnswer({ outcome: "change", changes: [
      { field: "copyrightHolder", action: "set", text: "All Rights Press", requestedBy: message },
      { field: "imprint", action: "set", text: "All Rights Press", requestedBy: message },
      { field: "allRightsReserved", action: "set", requestedBy: message }
    ] }, { message, current, bookLanguage: "en" })).toEqual({
      kind: "change", patch: { copyrightHolder: "All Rights Press", imprint: "All Rights Press", ...(rightsRequest ? { allRightsReserved: true } : {}) }
    });
  });

  it.each(["Set the copyright holder and publisher to All Rights; add all rights", "Add all rights; set the copyright holder and publisher to All Rights"])("keeps the independent toggle when one name supplies two fields: %s", (message) => {
    expect(normalizeBookMatterChatAnswer({ outcome: "change", changes: [
      { field: "copyrightHolder", action: "set", text: "All Rights", requestedBy: message },
      { field: "imprint", action: "set", text: "All Rights", requestedBy: message },
      { field: "allRightsReserved", action: "set", requestedBy: message }
    ] }, { message, current, bookLanguage: "en" })).toEqual({
      kind: "change", patch: { copyrightHolder: "All Rights", imprint: "All Rights", allRightsReserved: true }
    });
  });

  it.each(["All Rights", "All Rights Reserved Press"])("keeps an explicit rights removal beside the supplied name %s", (text) => {
    const nameRequest = `Set the publisher to ${text}`;
    const rightsRequest = "Remove rights reserved";
    for (const requests of [[nameRequest, rightsRequest], [rightsRequest, nameRequest]]) {
      const message = requests.join("; ");
      for (const requestedBy of [message, rightsRequest]) {
        expect(normalizeBookMatterChatAnswer({ outcome: "change", changes: [
          { field: "imprint", action: "set", text, requestedBy: message },
          { field: "allRightsReserved", action: "remove", requestedBy }
        ] }, { message, current: { ...current, allRightsReserved: true }, bookLanguage: "en" })).toEqual({
          kind: "change", patch: { imprint: text, allRightsReserved: false }
        });
      }
    }
  });

  it.each([
    ["en", "Set the publisher to All Rights Reserved Press", "All Rights Reserved Press", "Add rights reserved"],
    ["en", "Set the publisher to All Rights", "All Rights", "Add all rights"],
    ["ar", "الناشر: دار جميع الحقوق", "دار جميع الحقوق", "أضف عبارة جميع الحقوق محفوظة"],
    ["fa", "ناشر: انتشارات کلیه حقوق", "انتشارات کلیه حقوق", "عبارت کلیه حقوق محفوظ است را اضافه کن"]
  ])("keeps an independent %s rights request beside the supplied name", (bookLanguage, nameRequest, text, rightsRequest) => {
    for (const requests of [[nameRequest, rightsRequest], [rightsRequest, nameRequest]]) {
      const message = requests.join("; ");
      for (const requestedBy of [message, rightsRequest]) {
        expect(normalizeBookMatterChatAnswer({ outcome: "change", changes: [
          { field: "imprint", action: "set", text, requestedBy: message },
          { field: "allRightsReserved", action: "set", requestedBy }
        ] }, { message, current, bookLanguage })).toEqual({ kind: "change", patch: { imprint: text, allRightsReserved: true } });
      }
    }
  });

  it("keeps an explicit rights request from the original clarification", () => {
    const originalRequest = "Set the publisher to All Rights Press and add all rights reserved";
    const message = `${originalRequest}\n\nFollow-up from the user: Yes`;
    expect(normalizeBookMatterChatAnswer({ outcome: "change", changes: [
      { field: "imprint", action: "set", text: "All Rights Press", requestedBy: "Yes" },
      { field: "allRightsReserved", action: "set", requestedBy: "Yes" }
    ] }, { message, originalRequest, current, bookLanguage: "en" })).toEqual({
      kind: "change", patch: { imprint: "All Rights Press", allRightsReserved: true }
    });
  });

  it("keeps a rights follow-up after an earlier rights change", () => {
    const message = "Put it back";
    expect(normalizeBookMatterChatAnswer({ outcome: "change", changes: [
      { field: "allRightsReserved", action: "set", requestedBy: message }
    ] }, { message, current: { ...current, imprint: "All Rights Press" }, lastTurnFields: ["allRightsReserved"] })).toEqual({
      kind: "change", patch: { allRightsReserved: true }
    });
  });

  it("does not let an unasked printed field consume the explicit rights request", () => {
    const message = "Add all rights reserved";
    const changes: BookMatterChatAnswer["changes"] = [
      { field: "allRightsReserved", action: "set", requestedBy: message },
      { field: "copyrightHolder", action: "set", text: "All Rights Reserved", requestedBy: message }
    ];
    expect(normalizeBookMatterChatAnswer({ outcome: "change", changes }, { message, current })).toEqual({
      kind: "change", patch: { allRightsReserved: true }
    });
  });
});
