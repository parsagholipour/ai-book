import { describe, expect, it } from "vitest";

import { fakeBookMatterChatEdit } from "../adapters/fakeBookMatterChatEdit.js";
import {
  BOOK_MATTER_CHAT_PURPOSE,
  bookMatterChatAnswerSchema,
  bookMatterChatMessages,
  bookMatterProseReviewCandidates,
  normalizeBookMatterChatAnswer,
  type BookMatterChatAnswer,
  type BookMatterChatCurrent
} from "./bookMatterChatEdit.js";
import { namesAuthorProfile, type BookMatterChatProfile } from "./bookMatterProfile.js";

/** "The Last Table" (2026-10-17): made at 15:48, the profile saved at 16:56, so the book printed no name. */
const empty: BookMatterChatCurrent = {
  authorName: null,
  dedication: null,
  aboutAuthor: null,
  authorWebsite: null,
  copyrightHolder: null,
  imprint: null,
  isbn: null,
  allRightsReserved: false
};
const parsa: BookMatterChatProfile = { authorName: "Parsa Gholipour", allRightsReserved: true };
const full: BookMatterChatProfile = {
  authorName: "Ana Ruiz",
  aboutAuthor: "Ana Ruiz writes about the sea from Lisbon.\nShe has two dogs.",
  authorWebsite: "anaruiz.pt",
  imprint: "Lantern Press",
  allRightsReserved: true
};

type Change = BookMatterChatAnswer["changes"][number];
const answer = (changes: Change[]): BookMatterChatAnswer => bookMatterChatAnswerSchema.parse({ outcome: "change", changes });
const set = (field: Change["field"], text: string | null, requestedBy: string): Change => ({ field, action: "set", text, requestedBy });

const FIRST = "I added my author info. I wanna remake this book or modify it to include my info in the cover pages";
const FOLLOW_UP = `${FIRST}\n\nFollow-up from the user: Whatever I added in my profile`;

describe("the reader's saved profile in the matter chat", () => {
  it("reads the words that point at a profile, and not the ones that only sound like it", () => {
    for (const words of [
      FIRST,
      "Whatever I added in my profile",
      "use my profile",
      "put the author's details on it",
      "از پروفایلم استفاده کن",
      "usa mi perfil",
      "nimm mein Profil",
      "プロフィールの情報を使って",
      "프로필 정보를 넣어 줘",
      "используй мой профиль"
    ]) {
      expect(namesAuthorProfile(words), words).toBe(true);
    }
    for (const words of ["Dedicate it to my mom", "add more information about the author's childhood to page 3", "the author is Sam Lee"]) {
      expect(namesAuthorProfile(words), words).toBe(false);
    }
  });

  it("prints what the profile holds when the reader points at it — the chat that asked them to type it again", () => {
    const changes = [set("authorName", "Parsa Gholipour", "include my info in the cover pages"), set("allRightsReserved", null, "include my info in the cover pages")];
    const decision = normalizeBookMatterChatAnswer(answer(changes), { message: FIRST, current: empty, profile: parsa });
    expect(decision).toMatchObject({ kind: "change", patch: { authorName: "Parsa Gholipour", allRightsReserved: true } });

    // The follow-up turn the reader actually sent, merged with the request the question was about.
    const followUp = [set("authorName", "Parsa Gholipour", "Whatever I added in my profile"), set("allRightsReserved", null, "Whatever I added in my profile")];
    expect(
      normalizeBookMatterChatAnswer(answer(followUp), { message: FOLLOW_UP, originalRequest: FIRST, current: empty, profile: parsa })
    ).toMatchObject({ kind: "change", patch: { authorName: "Parsa Gholipour", allRightsReserved: true } });
  });

  it("copies every field of a full profile, the multi-line bio needing no grounding review", () => {
    const words = "use my profile";
    const changes = [
      set("authorName", "Ana Ruiz", words),
      set("aboutAuthor", full.aboutAuthor!, words),
      set("authorWebsite", "anaruiz.pt", words),
      set("imprint", "Lantern Press", words),
      set("allRightsReserved", null, words)
    ];
    const context = { message: words, current: empty, profile: full };
    expect(bookMatterProseReviewCandidates(answer(changes), context)).toEqual([]);
    expect(normalizeBookMatterChatAnswer(answer(changes), context)).toEqual({
      kind: "change",
      patch: { authorName: "Ana Ruiz", aboutAuthor: full.aboutAuthor, authorWebsite: "anaruiz.pt", imprint: "Lantern Press", allRightsReserved: true }
    });
  });

  it("takes a field the reader names without its value from the profile, by the field's own cue", () => {
    const words = "add my website";
    expect(
      normalizeBookMatterChatAnswer(answer([set("authorWebsite", "anaruiz.pt", words)]), { message: words, current: empty, profile: full })
    ).toEqual({ kind: "change", patch: { authorWebsite: "anaruiz.pt" } });
    // The same address with no profile behind it is one the reader never typed.
    expect(normalizeBookMatterChatAnswer(answer([set("authorWebsite", "anaruiz.pt", words)]), { message: words, current: empty })).toMatchObject({
      kind: "refused",
      problem: { kind: "not_given", field: "authorWebsite" }
    });
  });

  it("opens the profile door to its own values only", () => {
    const words = "use my profile";
    // A value the profile does not hold is still a fact nobody gave.
    expect(
      normalizeBookMatterChatAnswer(answer([set("authorName", "Parsa G.", words)]), { message: words, current: empty, profile: parsa })
    ).toMatchObject({ kind: "refused", problem: { kind: "not_given", field: "authorName" } });
    // A message that never points at the profile gets no profile rider beside what it asked for.
    const dedicate = "add a dedication: For Mom";
    const rider = [set("dedication", "For Mom", dedicate), set("authorName", "Parsa Gholipour", dedicate), set("allRightsReserved", null, dedicate)];
    expect(normalizeBookMatterChatAnswer(answer(rider), { message: dedicate, current: empty, profile: parsa })).toEqual({
      kind: "change",
      patch: { dedication: "For Mom" }
    });
    // Pointing at a profile with no bio takes no bio off the book.
    const removal = answer([set("authorName", "Parsa Gholipour", words), { field: "aboutAuthor", action: "remove", requestedBy: words }]);
    expect(normalizeBookMatterChatAnswer(removal, { message: words, current: { ...empty, aboutAuthor: "Old bio." }, profile: parsa })).toEqual({
      kind: "change",
      patch: { authorName: "Parsa Gholipour" }
    });
  });

  it("shows the composer the profile, and tells it the truth when there is none", () => {
    const [withProfile, withPayload] = bookMatterChatMessages({ message: FIRST, current: empty, authorProfile: parsa });
    expect(withProfile!.content).toContain("authorProfile is the author information the reader saved");
    expect(JSON.parse(withPayload!.content as string).authorProfile).toEqual(parsa);

    const [without, payload] = bookMatterChatMessages({ message: FIRST, current: empty });
    expect(without!.content).toContain("The reader has no saved author profile.");
    expect(JSON.parse(payload!.content as string)).not.toHaveProperty("authorProfile");
  });

  it("answers a dry run from the profile, through the same checks", () => {
    const messages = bookMatterChatMessages({ message: "Whatever I added in my profile", current: empty, authorProfile: parsa });
    const reply = bookMatterChatAnswerSchema.parse(
      fakeBookMatterChatEdit({ purpose: BOOK_MATTER_CHAT_PURPOSE, messages, schema: bookMatterChatAnswerSchema })
    );
    expect(normalizeBookMatterChatAnswer(reply, { message: "Whatever I added in my profile", current: empty, profile: parsa })).toEqual({
      kind: "change",
      patch: { authorName: "Parsa Gholipour", allRightsReserved: true }
    });
  });
});
