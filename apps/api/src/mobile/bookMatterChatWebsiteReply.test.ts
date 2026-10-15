import { describe, expect, it, vi } from "vitest";
import { CONVERSATION_LANGUAGES, type BookMatterChatCurrent } from "@book-maker/core";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { bookMatterChangeReply } from "./bookMatterChatEdits.js";
import { localizedMatterChatCopy } from "./bookMatterChatCopy.js";
import { localizedMatterChatReplies } from "./bookMatterChatReplies.js";

const current: BookMatterChatCurrent = {
  authorName: null, dedication: null, aboutAuthor: null, authorWebsite: null,
  copyrightHolder: null, imprint: null, isbn: null, allRightsReserved: false
};
const nextCompile = { reprint: "next_compile", cover: "unchanged" } as const;

describe("website confirmations respect the biography required to print the website", () => {
  it.each([null, "", " \n "])("explains a saved website is waiting for a biography (%j)", (aboutAuthor) => {
    const reply = bookMatterChangeReply({ authorWebsite: "alice.dev" }, { ...current, aboutAuthor }, "2026", nextCompile);
    expect(reply).toContain("the website is saved as “alice.dev”");
    expect(reply).toContain("once you add a biography");
    expect(reply).not.toContain("the website on About the Author is now");
    expect(reply).not.toContain("It’ll be printed when the book is put together");
  });

  it("can report the real export refresh while explaining the website remains hidden", () => {
    const reply = bookMatterChangeReply({ authorWebsite: "alice.dev" }, current, "2026", { ...nextCompile, reprint: "queued" });
    expect(reply).toContain("once you add a biography");
    expect(reply).toContain("I’m refreshing the exports");
  });

  it("explains the condition for an unchanged saved website too", () => {
    const reply = bookMatterChangeReply(
      { authorWebsite: "alice.dev" }, { ...current, authorWebsite: "alice.dev" }, "2026", { ...nextCompile, reprint: "none" }
    );
    expect(reply).toContain("Nothing changed");
    expect(reply).toContain("the website is already saved as “alice.dev”");
    expect(reply).toContain("once you add a biography");
    expect(reply).not.toContain("refreshing");
  });

  it.each([
    [{ authorWebsite: "alice.dev" }, { ...current, aboutAuthor: "Alice writes." }],
    [{ authorWebsite: "alice.dev", aboutAuthor: "Alice writes." }, current]
  ] as const)("uses the biography after merging the saved patch", (patch, before) => {
    const reply = bookMatterChangeReply(patch, before, "2026", nextCompile);
    expect(reply).toContain("the website on About the Author is now “alice.dev”");
    expect(reply).toContain("It’ll be printed when the book is put together");
    expect(reply).not.toContain("once you add a biography");
  });

  it.each([
    { aboutAuthor: null },
    { aboutAuthor: null, authorWebsite: "alice.dev" }
  ])("warns that clearing the biography also hides a retained website", (patch) => {
    const reply = bookMatterChangeReply(patch, { ...current, aboutAuthor: "Alice writes.", authorWebsite: "alice.dev" }, "2026", nextCompile);
    expect(reply).toContain("the About the Author page is gone");
    expect(reply).toContain("once you add a biography");
    expect(reply).not.toContain("It’ll be printed when the book is put together");
  });

  it("does not promise to print a website that was removed", () => {
    const reply = bookMatterChangeReply({ authorWebsite: null }, { ...current, authorWebsite: "alice.dev" }, "2026", nextCompile);
    expect(reply).toContain("the website is gone");
    expect(reply).not.toContain("once you add a biography");
  });

  it("keeps a simultaneous printable change while explaining the website prerequisite", () => {
    const reply = bookMatterChangeReply({ authorWebsite: "alice.dev", dedication: "For Mom" }, current, "2026", nextCompile);
    expect(reply).toContain("the dedication now reads “For Mom”");
    expect(reply).toContain("the website is saved as “alice.dev”");
    expect(reply).toContain("once you add a biography");
  });

  for (const language of CONVERSATION_LANGUAGES) {
    if (language === "en") continue;
    it(`keeps ${language} export claims conditional on the saved biography`, () => {
      const replies = localizedMatterChatReplies(language);
      const copy = localizedMatterChatCopy(language);
      const patch = { authorWebsite: "alice.dev" };
      const hidden = replies.change(patch, current, "2026", nextCompile);
      expect(hidden).toContain("“alice.dev”");
      expect(hidden).not.toContain(copy.text("next"));
      expect(hidden).toContain(copy.text("websiteNeedsBio"));
      const withBiography = replies.change({ ...patch, aboutAuthor: "Alice writes." }, current, "2026", nextCompile);
      expect(withBiography).toContain(copy.text("next"));
      expect(withBiography).not.toContain(copy.text("websiteNeedsBio"));
      const removedBiography = replies.change({ aboutAuthor: null }, { ...current, aboutAuthor: "Alice writes.", ...patch }, "2026", nextCompile);
      expect(removedBiography).not.toContain(copy.text("next"));
      expect(removedBiography).toContain(copy.text("websiteNeedsBio"));
      const mixed = replies.change({ ...patch, dedication: "For Mom" }, current, "2026", nextCompile);
      expect(mixed).toContain("“For Mom”");
      expect(mixed).toContain(copy.text("websiteNeedsBio"));
      const refreshed = replies.change(patch, current, "2026", { ...nextCompile, reprint: "queued" });
      expect(refreshed).toContain(copy.text("queued"));
      expect(refreshed).toContain(copy.text("websiteNeedsBio"));
      const unchanged = replies.change(patch, { ...current, ...patch }, "2026", { ...nextCompile, reprint: "none" });
      expect(unchanged).toContain(copy.text("unchanged"));
      expect(unchanged).toContain(copy.text("websiteNeedsBio"));
      expect(unchanged).not.toContain(copy.text("queued"));
      const cleared = replies.change({ authorWebsite: null }, { ...current, ...patch }, "2026", nextCompile);
      expect(cleared).toContain(copy.text("removed", { field: copy.field("authorWebsite") }));
      expect(cleared).not.toContain(copy.text("websiteNeedsBio"));
    });
  }
});
