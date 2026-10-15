import { describe, expect, it } from "vitest";

import { normalizeBookMatterChatAnswer, type BookMatterChatCurrent, type BookMatterChatLanguage } from "./bookMatterChatEdit.js";

const current: BookMatterChatCurrent = {
  authorName: null, dedication: null, aboutAuthor: null, authorWebsite: null,
  copyrightHolder: null, imprint: null, isbn: null, allRightsReserved: false
};

const cases = [
  {
    language: "it", field: "Biografia", value: "Cambia la copertina del suo quaderno ogni anno.",
    request: "Cambia la copertina del libro.", joined: "e"
  },
  {
    language: "es", field: "Biografía", value: "Cambia la portada de sus cuadernos cada año.",
    request: "Cambia la portada del libro.", joined: "y"
  },
  {
    language: "fr", field: "Biographie", value: "Change la couverture de son carnet chaque année.",
    request: "Change la couverture du livre.", joined: "et"
  }
] as const;

function decide(message: string, value: string, bookLanguage: BookMatterChatLanguage) {
  return normalizeBookMatterChatAnswer({
    outcome: "change", changes: [{ field: "aboutAuthor", action: "set", text: value, requestedBy: message }], unhandled: null
  }, { message, current, bookLanguage });
}

describe("supplied Romance biography prose with an ambiguous edit verb", () => {
  it.each(cases)("keeps $language prose about the cover of someone else's notebook", ({ language, field, value }) => {
    expect(decide(`${field}: ${value}`, value, language)).toEqual({ kind: "change", patch: { aboutAuthor: value } });
  });

  it.each(cases)("still identifies an actual $language book edit after supplied prose", ({ language, field, value, request, joined }) => {
    for (const separator of [". ", ` ${joined} `]) {
      const content = value.slice(0, -1);
      const message = `${field}: ${content}${separator}${request}`;
      expect(decide(message, value, language)).toEqual({
        kind: "change", patch: { aboutAuthor: value }, unhandledUnquoted: true
      });
      expect(decide(message, `${content}${separator}${request}`, language)).toEqual({
        kind: "refused", problem: { kind: "runs_on", field: "aboutAuthor" }, unhandledUnquoted: true
      });
    }
  });

  it.each(cases)("still refuses an actual $language book edit at the start of supplied words", ({ language, field, request }) => {
    expect(decide(`${field}: ${request}`, request, language)).toEqual({
      kind: "refused", problem: { kind: "runs_on", field: "aboutAuthor" }, unhandledUnquoted: true
    });
  });

  it.each(cases)("keeps quoted $language book commands as literal biography prose", ({ language, field, request }) => {
    expect(decide(`${field}: «${request}»`, request, language)).toEqual({ kind: "change", patch: { aboutAuthor: request } });
  });
});
