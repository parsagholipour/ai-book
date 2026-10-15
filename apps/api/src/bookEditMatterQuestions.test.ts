import { describe, expect, it } from "vitest";
import { classifyProjectChatMessage } from "./bookEditIntent.js";
import { mentionsBookMatter } from "./bookEditMatter.js";
import { chapters, fakeFailingTextModel, pages } from "./testing/bookEditIntentFixtures.js";

/**
 * A question changes nothing, but "have" and "do" open imperatives too, and a
 * message that opens on a question may ask for the change in a later sentence.
 * The detector read only the message's first word and last mark, so with the
 * router down these went to clarify and then to the whole-book rewrite card.
 */
const REQUESTS = [
  "Have the dedication read: For Mom",
  "Do remove the ISBN",
  "Is the dedication ok? Add a dedication: For my sources of strength",
  "Please do add a dedication: For Mom",
  "Do not print my website",
  "Have my bio say I live in Lisbon",
  "Does it have an ISBN?\nSet the ISBN to 978-0-306-40615-7",
  "Is the dedication ok? Can you make the dedication shorter?",
  "Change the dedication to For Mom. Is that ok?",
  "著者紹介を短くして。献辞はありますか？",
  "تقدیم‌نامه را به مادرم تقدیم کن. درست است؟"
];

const QUESTIONS = [
  "Is there a dedication?",
  "Is there a dedication",
  "Does the book have an ISBN?",
  "Does the book have an ISBN",
  "Do I need an ISBN?",
  "Do I need an ISBN",
  "Do you add a dedication",
  "Have you added a dedication",
  "Have the ISBNs been registered",
  "Is there a dedication? Thanks",
  "What's the ISBN? Who is the publisher?",
  "Who is Dr. Smith in the dedication?",
  // A later sentence is still read with its own exclusions.
  "Is the dedication ok? Make page 4 about the publisher",
  "¿Qué dice la dedicatoria?",
  "تقدیم‌نامه برای کیست؟"
];

describe("a matter request beside a question", () => {
  it.each(REQUESTS)("reads %j as a matter request", (message) => {
    expect(mentionsBookMatter(message)).toBe(true);
  });

  it.each(QUESTIONS)("leaves the question %j alone", (message) => {
    expect(mentionsBookMatter(message)).toBe(false);
  });

  it.each(REQUESTS.slice(0, 3))("keeps %j a free matter edit when the router is down", async (message) => {
    for (const textModel of [fakeFailingTextModel(), undefined]) {
      for (const clarifyExhausted of [false, true]) {
        const intent = await classifyProjectChatMessage({ message, stage: "complete", pages, chapters, textModel, clarifyExhausted });
        expect(intent).toMatchObject({ kind: "book_matter", scope: "none", affectedPageIndexes: [] });
      }
    }
  });
});
