import { describe, expect, it } from "vitest";

import { runQuickAuthorAssist, type QuickAuthorAssistRequest } from "../authoring/authorAssist.js";
import { AUTHOR_ASSIST_PURPOSES, QUICK_AUTHOR_ASSIST_KINDS, type AuthorAssistBook } from "../authoring/authorAssistTypes.js";
import {
  checkBookConsistency,
  draftChapterFromNotes,
  outlineAuthorBook,
  reviewChapterForAuthor
} from "../authoring/authorLongAssists.js";
import { FakeTextModelAdapter } from "./fake.js";
import { fakeAuthorAssist } from "./fakeAuthorAssist.js";

/**
 * Every Writing Studio purpose has a canned `MOCK_AI` answer that parses, and
 * survives the runner's own clean-up — the path a Studio dev session and the
 * API and widget tests take.
 */
const textModel = new FakeTextModelAdapter();
const book: AuthorAssistBook = { title: "The Salt Road", kind: "story", language: "en" };
const selection = "The well was dry. Mara looked down into teh dark. Nothing moved.";

function request(kind: QuickAuthorAssistRequest["kind"], overrides: Partial<QuickAuthorAssistRequest> = {}): QuickAuthorAssistRequest {
  return {
    kind,
    book,
    chapter: { title: "The Well", notes: "Mara finds the well dry." },
    selection,
    before: "They walked all morning.",
    instruction: "Is the pacing too slow?",
    ...overrides
  };
}

describe("fakeAuthorAssist through FakeTextModelAdapter", () => {
  it.each(QUICK_AUTHOR_ASSIST_KINDS)("%s returns a deterministic, usable suggestion", async (kind) => {
    const first = await runQuickAuthorAssist(request(kind), { textModel });
    const second = await runQuickAuthorAssist(request(kind), { textModel });
    expect(second).toEqual(first);
    const produced = first.suggestions.length + first.corrections.length + first.ideas.length + (first.answer ? 1 : 0);
    expect(produced).toBeGreaterThan(0);
    expect(first.kind).toBe(kind);
  });

  it("rewrites with a visible change the preset decides", async () => {
    const shorter = await runQuickAuthorAssist(request("rewrite", { preset: "shorter" }), { textModel });
    expect(shorter.suggestions[0]!.text).toBe("The well was dry. Mara looked down into teh dark.");
    const longer = await runQuickAuthorAssist(request("rewrite", { preset: "longer" }), { textModel });
    expect(longer.suggestions[0]!.text.startsWith(selection)).toBe(true);
    const clearer = await runQuickAuthorAssist(request("rewrite", { preset: "clearer" }), { textModel });
    expect(clearer.suggestions[0]!.text).toContain("[MOCK_AI clearer]");
  });

  it("proofreads one common typo, and nothing when there is none", async () => {
    const found = await runQuickAuthorAssist(request("proofread"), { textModel });
    expect(found.corrections).toEqual([{ find: "teh", replace: "the", reason: "[MOCK_AI] spelling" }]);
    const clean = await runQuickAuthorAssist(request("proofread", { selection: "All is well." }), { textModel });
    expect(clean.corrections).toEqual([]);
    const twice = await runQuickAuthorAssist(request("proofread", { selection: "teh cat and teh dog" }), { textModel });
    expect(twice.corrections).toEqual([]);
  });

  it("answers every long assist", async () => {
    const markdown = "The well was dry.\n\nMara looked down into the dark.";
    const draft = await draftChapterFromNotes({ book, chapter: { title: "The Well", notes: "Dry well." }, targetWords: 800 }, { textModel });
    expect(draft.markdown).toContain("[MOCK_AI]");
    const pictureDraft = await draftChapterFromNotes(
      { book: { ...book, kind: "picture" }, chapter: { title: "Fox", notes: "" }, targetWords: 200 },
      { textModel }
    );
    expect(pictureDraft.markdown).toContain("<!-- page -->");

    const feedback = await reviewChapterForAuthor({ book, chapter: { title: "The Well", markdown } }, { textModel });
    expect(feedback.notes).toHaveLength(2);
    expect(feedback.notes[0]!.quote).toBe("The well was dry.");

    const consistency = await checkBookConsistency(
      { book, chapters: [{ id: "c1", title: "One", markdown }, { id: "c2", title: "Two", markdown: "Mara was twelve." }] },
      { textModel }
    );
    expect(consistency.notes).toEqual([
      expect.objectContaining({ quote: "The well was dry.", chapterId: "c1" }),
      expect.objectContaining({ quote: null, chapterId: "c2" })
    ]);

    const outline = await outlineAuthorBook({ book }, { textModel });
    expect(outline.chapters).toHaveLength(6);
    const picture = await outlineAuthorBook({ book: { ...book, kind: "picture" } }, { textModel });
    expect(picture.chapters).toHaveLength(1);
    expect(picture.chapters[0]!.notes.split("\n").length).toBeGreaterThanOrEqual(10);
  });

  it("has an answer for every purpose", () => {
    for (const purpose of Object.values(AUTHOR_ASSIST_PURPOSES)) {
      expect(fakeAuthorAssist(purpose, { schema: undefined as never, messages: [{ role: "user", content: "{}" }] }), purpose).toBeTypeOf(
        "object"
      );
    }
  });
});
