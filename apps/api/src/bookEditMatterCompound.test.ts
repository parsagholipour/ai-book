import { bookMatterMessageHasSeparateRequest } from "@book-maker/core";
import { describe, expect, it } from "vitest";
import { classifyProjectChatMessage } from "./bookEditIntent.js";
import { mentionsBookMatter } from "./bookEditMatter.js";
import { chapters, fakeFailingTextModel, pages } from "./testing/bookEditIntentFixtures.js";

const COMPOUND_REQUESTS = [
  "Change the publisher to Lantern and rewrite chapter 3",
  "Change the author name to Sam Lee and rewrite chapter 3",
  "Rewrite chapter 3 and change the publisher to Lantern",
  "Change the publisher to Lantern. Rewrite chapter 3",
  "Change the dedication to For Mom and rewrite the scene in chapter 3",
  "Modifie le nom de l’auteur pour Sam Lee et réécris le chapitre 3",
  "Réécris le chapitre 3 et modifie le nom de l’auteur pour Sam Lee",
  "Réécris la page 4, modifie le nom de l’auteur pour Sam Lee",
  "Change the ناشر to لانترن and rewrite chapter 3",
  "Cambia el nombre del autor a Sam Lee y reescribe el capítulo 3",
  "Reescribe el capítulo 3 y cambia el nombre del autor a Sam Lee",
  "Modifica il nome dell’autore in Sam Lee e riscrivi il capitolo 3",
  "نام نویسنده را به سارا تغییر بده و فصل 3 را بازنویسی کن",
  "فصل 3 را بازنویسی کن و نام نویسنده را به سارا تغییر بده",
  "Change the publisher to Lantern\nRewrite chapter 3",
  "Modifie le nom de l’auteur pour Sam Lee\nRéécris le chapitre 3"
];

describe("matter and prose edits in one message", () => {
  it.each(COMPOUND_REQUESTS)("recognizes the matter clause in %j", (message) => {
    expect(mentionsBookMatter(message)).toBe(true);
  });

  it.each(COMPOUND_REQUESTS)("keeps the matter free and the other request separate during an outage: %j", async (message) => {
    for (const textModel of [fakeFailingTextModel(), undefined]) {
      const intent = await classifyProjectChatMessage({ message, stage: "complete", pages, chapters, textModel });
      expect(intent).toMatchObject({ kind: "book_matter", scope: "none", affectedPageIndexes: [] });
    }
    expect(bookMatterMessageHasSeparateRequest(message)).toBe(true);
  });

  it.each([
    "Rewrite chapter 3 so the publisher sounds meaner",
    "Rewrite page 4 so the publisher sounds meaner",
    "Rewrite page 4, so the publisher sounds meaner",
    "Réécris le chapitre 3 pour changer le nom de l’auteur dans le dialogue",
    "Réécris le chapitre 3 pour parler de mon site web",
    "Réécris le chapitre 3 pour que le héros et l’éditeur soient plus gentils",
    "Réécris le chapitre 3 pour que le héros et le nom de l’auteur soient plus clairs",
    "Sur la page 4, modifie le nom de l’auteur pour mieux le décrire",
    "صفحه ۴ را طوری بازنویسی کن که ناشر مهربان‌تر باشد"
  ])("preserves a matter word used as prose in %j", (message) => {
    expect(mentionsBookMatter(message)).toBe(false);
  });
});
