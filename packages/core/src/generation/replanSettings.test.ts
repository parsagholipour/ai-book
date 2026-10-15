import { describe, expect, it } from "vitest";
import { createProjectSchema, mediaSettingsSchema } from "../schemas/book.js";
import {
  explicitTargetPagesFromText,
  inputWithReplanSettings,
  mediaSettingsRowWriteback,
  mediaSettingsWithReplanSettings,
  negativeMediaPreferenceFromMessage,
  replanSettingsFromMessage
} from "./replanSettings.js";

const illustratedMediaSettings = () =>
  mediaSettingsSchema.parse({
    fullIllustrations: true,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "business",
    finalReview: true,
    toneProfile: "confident",
    mobile: { imagesEnabled: true, targetPages: 8, lengthPreset: "short", pageCountMode: "custom" }
  });

const illustratedInput = () =>
  createProjectSchema.parse({
    prompt: "A practical guide to budget shops.",
    category: "BUSINESS",
    targetPages: 8,
    mediaSettings: illustratedMediaSettings()
  });

describe("explicitTargetPagesFromText", () => {
  it("reads a book length out of the phrasings the chats actually use", () => {
    expect(explicitTargetPagesFromText("make it 3 pages without illustrations")).toBe(3);
    expect(explicitTargetPagesFromText("I want a 24 page workbook")).toBe(24);
    expect(explicitTargetPagesFromText("page count: 12")).toBe(12);
  });

  it("takes the last number, so a message that revises itself means what it ended on", () => {
    expect(explicitTargetPagesFromText("8 pages, actually make it 3 pages")).toBe(3);
  });

  it("returns undefined when no length is named or the number is out of range", () => {
    expect(explicitTargetPagesFromText("make the tone warmer")).toBeUndefined();
    expect(explicitTargetPagesFromText("a 900 page book")).toBeUndefined();
  });

  it("reads a length written in the user's own script and numerals", () => {
    // The message that went unread: a Persian brief naming its own length.
    expect(explicitTargetPagesFromText("یک کتاب ۳ صفحه ای بساز از بهترین حکایت بوستان سعدی با توضیحات")).toBe(3);
    // Persian joins the suffix with a ZWNJ, so the page word is matched as a prefix.
    expect(explicitTargetPagesFromText("کتاب ۳ صفحه‌ای")).toBe(3);
    expect(explicitTargetPagesFromText("اريد كتاب من ٢٥ صفحة")).toBe(25);
    expect(explicitTargetPagesFromText("做一本12页的书")).toBe(12);
    expect(explicitTargetPagesFromText("3ページの本")).toBe(3);
    expect(explicitTargetPagesFromText("12페이지 책")).toBe(12);
    expect(explicitTargetPagesFromText("หนังสือ 8 หน้า")).toBe(8);
    expect(explicitTargetPagesFromText("20 पेज की किताब")).toBe(20);
    expect(explicitTargetPagesFromText("un libro de 30 páginas")).toBe(30);
    expect(explicitTargetPagesFromText("ein Buch mit 15 Seiten")).toBe(15);
    expect(explicitTargetPagesFromText("ספר של 8 עמודים")).toBe(8);
  });

  it("mixes scripts, because the numerals and the page word need not agree", () => {
    expect(explicitTargetPagesFromText("۲۴ pages please")).toBe(24);
    expect(explicitTargetPagesFromText("24 صفحه")).toBe(24);
  });

  it("says nothing rather than the wrong thing when a length is ruled out or bounded", () => {
    // Asking is the right answer: none of these say what the book SHOULD be,
    // and a guess here sizes and charges for a book the user refused.
    expect(explicitTargetPagesFromText("it shouldn't be 10 pages")).toBeUndefined();
    expect(explicitTargetPagesFromText("don't make it 10 pages")).toBeUndefined();
    expect(explicitTargetPagesFromText("not a 10 page book")).toBeUndefined();
    expect(explicitTargetPagesFromText("no more than 10 pages")).toBeUndefined();
    expect(explicitTargetPagesFromText("more than 10 pages")).toBeUndefined();
    expect(explicitTargetPagesFromText("at least 20 pages")).toBeUndefined();
    expect(explicitTargetPagesFromText("fewer than 30 pages")).toBeUndefined();
    expect(explicitTargetPagesFromText("نباید ۱۰ صفحه باشد")).toBeUndefined();
    expect(explicitTargetPagesFromText("kein 10 Seiten Buch")).toBeUndefined();
  });

  it("reads pages being added as a delta, never as the book's new length", () => {
    // The incident: "add 3 pages" routed as a whole-book replan, which priced,
    // planned and regenerated a THREE page book. The reader asked for N+3.
    expect(explicitTargetPagesFromText("add 3 pages at the end")).toBeUndefined();
    expect(explicitTargetPagesFromText("insert 2 pages before the ending")).toBeUndefined();
    expect(explicitTargetPagesFromText("append another 4 pages")).toBeUndefined();
    expect(explicitTargetPagesFromText("I want 2 more pages")).toBeUndefined();
    expect(explicitTargetPagesFromText("give me 5 extra pages")).toBeUndefined();
    // Postposed, the quantifier is stranded — nothing follows for it to modify.
    expect(explicitTargetPagesFromText("I want 3 pages more")).toBeUndefined();
    expect(explicitTargetPagesFromText("3 pages more please")).toBeUndefined();
    expect(explicitTargetPagesFromText("3 pages more, please")).toBeUndefined();
    expect(explicitTargetPagesFromText("I want 3 pages more at the end")).toBeUndefined();
    expect(explicitTargetPagesFromText("I need 5 pages extra")).toBeUndefined();
    // Verb-last languages state the same delta on the other side of the count.
    expect(explicitTargetPagesFromText("۳ صفحه اضافه کن")).toBeUndefined();
  });

  it("still reads a length when the word after it is a degree adverb, not a delta", () => {
    // "more" here modifies an adjective, so the count beside it is the book's
    // length. Read as a delta it dropped the number entirely and the request
    // routed as a page rewrite or a clarify — the opposite of the bug the
    // additive guard was added for.
    expect(explicitTargetPagesFromText("make it 20 pages more detailed")).toBe(20);
    expect(explicitTargetPagesFromText("make it 30 pages more colorful")).toBe(30);
    expect(explicitTargetPagesFromText("make it 12 pages more suitable for kids")).toBe(12);
    expect(explicitTargetPagesFromText("make it 20 pages extra detailed")).toBe(20);
    // "more or less" approximates the length; it does not add to it.
    expect(explicitTargetPagesFromText("make it 20 pages more or less")).toBe(20);
    expect(explicitTargetPagesFromText("make it 20 pages, more or less")).toBe(20);
    expect(explicitTargetPagesFromText("20 pages more or less")).toBe(20);
  });

  it("still reads a length that merely sits beside an addition", () => {
    // "add" here is about a dragon, not about pages — a flat window would read
    // it as a delta and stop sizing a book the reader plainly described.
    expect(explicitTargetPagesFromText("make it 3 pages and add a picture of a dragon")).toBe(3);
    expect(explicitTargetPagesFromText("a 24 page workbook, and add an index")).toBe(24);
  });

  it("keeps a negation inside its own clause", () => {
    expect(explicitTargetPagesFromText("make it 5 pages, not 10")).toBe(5);
    expect(explicitTargetPagesFromText("I do not want illustrations, 10 pages")).toBe(10);
    expect(explicitTargetPagesFromText("no cover please. 12 pages")).toBe(12);
    expect(explicitTargetPagesFromText("بدون تصویر، ۱۵ صفحه")).toBe(15);
    // An approximator is a real intent, not a refusal.
    expect(explicitTargetPagesFromText("about 12 pages please")).toBe(12);
    expect(explicitTargetPagesFromText("around 20 pages")).toBe(20);
    // "نه" is a substring of ordinary Persian words like "خانه"; suppressing on
    // it would re-break the very message this reader exists to understand.
    expect(explicitTargetPagesFromText("داستانی درباره خانه ۵ صفحه")).toBe(5);
  });
});

describe("explicitTargetPagesFromText keeps every answer across the linear rewrite", () => {
  // Captured by running the reader as it stood before its patterns were made
  // linear (each optional word now carries its own trailing whitespace). The
  // rewrite was meant to change the backtracking and nothing else, so every
  // entry here — including the odd ones, like a bare "page 3" reading as 3,
  // which `replanTargetPagesFromMessage` guards in the API — must not move.
  const CORPUS: ReadonlyArray<readonly [string, number | undefined]> = [
    ["make it 3 pages without illustrations", 3],
    ["I want a 24 page workbook", 24],
    ["page count: 12", 12],
    ["about 30 pages", 30],
    ["around 20 pages", 20],
    ["roughly 15 pages please", 15],
    ["approximately 40 pages", 40],
    ["~25 pages", 25],
    ["make it 40 pages long", 40],
    ["40 pages long, please", 40],
    ["it should be 18 pages", 18],
    ["I need it to be 45 pages", 45],
    ["a 45 page", 45],
    ["make it 3pages", 3],
    ["Create a 64-page picture book", 64],
    ["a 12 - page story", 12],
    ["a 12–page booklet", 12],
    ["Write a 200 page novel", 200],
    ["write a 1,000 page epic", undefined],
    ["make it 1200 pages", undefined],
    ["make it 0 pages", undefined],
    ["make it 600 pages", 600],
    ["make it 601 pages", undefined],
    ["set the book to 50 pages", 50],
    ["keep it at 32 pages", 32],
    ["turn this into 16 pages", 16],
    ["write the story as 10 pages", 10],
    ["make the guide 22 pages", 22],
    ["make it to 9 pages", 9],
    ["make itto 7 pages", 7],
    ["pages: 20", 20],
    ["page length should be 25", 25],
    ["pg count = 15", 15],
    ["Page Count Is 14", 14],
    ["PAGES = 9", 9],
    ["page length: 22", 22],
    ["pages should be 35", 35],
    ["pagecount12", 12],
    ["a 24 page ebook", 24],
    ["a 10 pg guide", 10],
    ["10pgs", 10],
    ["a 5 pgs story", 5],
    ["8 pages, actually make it 3 pages", 3],
    ["12 pages? no, 14 pages", 14],
    ["make it 99 pages long and 3 chapters", 99],
    ["make it 20 pages and add a picture of a dragon", 20],
    ["a 24 page workbook, and add an index", 24],
    ["make it 5 pages, not 10", 5],
    ["I do not want illustrations, 10 pages", 10],
    ["no cover please. 12 pages", 12],
    ["Brief:\nA book about bees.\nLength: 30 pages", 30],
    ["make it\t12\tpages", 12],
    ["12 pages", 12],
    ["MAKE IT 30 PAGES", 30],
    // Ranges read as their upper end, because the last number wins.
    ["10-12 pages", 12],
    ["10 to 12 pages", 12],
    ["between 20 and 30 pages", 30],
    ["20-30 pages", 30],
    ["۲۰ تا ۳۰ صفحه", 30],
    ["somewhere in the 15–20 page range", 20],
    // Word-then-number reads as a count here; the API's guard drops it.
    ["page 3", 3],
    ["the title page", undefined],
    ["remove the title page", undefined],
    ["rewrite pages 3-5", 3],
    ["fix page 7", 7],
    ["on page 12, change the ending", 12],
    ["pages 2, 5 and 7", 2],
    ["page 3 has a typo", 3],
    ["the title page should say 2024", undefined],
    ["move page 4 after page 9", 9],
    ["chapter 3 should be longer", undefined],
    ["make the tone warmer", undefined],
    ["", undefined],
    ["   ", undefined],
    ["it shouldn't be 10 pages", undefined],
    ["not a 10 page book", undefined],
    ["no more than 10 pages", undefined],
    ["at least 20 pages", undefined],
    ["fewer than 30 pages", undefined],
    ["up to 40 pages", undefined],
    ["under 50 pages", undefined],
    ["over 60 pages", undefined],
    ["instead of 20 pages", undefined],
    ["نباید ۱۰ صفحه باشد", undefined],
    ["حداقل ۲۰ صفحه", undefined],
    ["أكثر من 20 صفحة", undefined],
    ["kein 10 Seiten Buch", undefined],
    ["nicht 10 Seiten", undefined],
    ["más de 20 páginas", undefined],
    ["add 3 pages at the end", undefined],
    ["I want 2 more pages", undefined],
    ["3 pages more please", undefined],
    ["append another 4 pages", undefined],
    ["give me 5 extra pages", undefined],
    ["۳ صفحه اضافه کن", undefined],
    ["3 صفحات أضف", undefined],
    ["make it 20 pages more detailed", 20],
    ["20 pages more or less", 20],
    ["یک کتاب ۳ صفحه ای بساز", 3],
    ["کتاب ۳۰ صفحه‌ای", 30],
    ["۲۴ صفحه", 24],
    ["اريد كتاب من ٢٥ صفحة", 25],
    ["كتاب من 25 صفحات", 25],
    ["اردو میں ۲۰ صفحہ کی کتاب", 20],
    ["२० पृष्ठ की किताब", 20],
    ["20 पेज की किताब", 20],
    ["หนังสือ ๘ หน้า", 8],
    ["做一本１２页的书", 12],
    ["做一本12页的书", 12],
    ["12頁の本", 12],
    ["3ページの本", 3],
    ["12페이지 책", 12],
    ["30쪽 책", 30],
    ["ספר של 8 עמודים", 8],
    ["ספר של 1 עמוד", 1],
    ["১২ pages", 12],
    ["ein Buch mit 15 Seiten", 15],
    ["eine Seite", undefined],
    ["un libro de 30 páginas", 30],
    ["um livro de 20 paginas", 20],
    ["un libro di 25 pagine", 25],
    ["una pagina", undefined],
    ["книга на 40 страниц", 40],
    ["книга на 12 страницах", 12],
    ["صفحه ۵ را عوض کن", undefined],
    ["۲۴ pages please", 24]
  ];

  it("reads the same count, or none, from every phrasing it read before", () => {
    const moved = CORPUS.flatMap(([text, before]) => {
      const after = explicitTargetPagesFromText(text);
      return after === before ? [] : [{ text, before, after }];
    });
    expect(moved).toEqual([]);
  });
});

describe("explicitTargetPagesFromText on adversarial input", () => {
  // Chat text is read on the API's only thread. The patterns once let three
  // adjacent `\s*` split one run of spaces every possible way before failing,
  // so "page" plus 2,000 spaces took about a second and "remove the title page"
  // padded to the 5,000-character chat limit ~20 s, freezing every user. Each
  // input is timed at 1k characters before any runs at 10k, so a super-linear
  // regression fails in a fraction of a second instead of hanging the suite.
  const fill =
    (head: string, filler: string) =>
    (length: number): string => {
      const room = length - head.length;
      return head + filler.repeat(Math.ceil(room / filler.length)).slice(0, room);
    };
  /** The words, separated by equal runs of spaces: one run per optional slot. */
  const spread =
    (words: string[]) =>
    (length: number): string => {
      const gap = Math.floor((length - words.join("").length) / (words.length - 1));
      return words.join(" ".repeat(gap)).padEnd(length, " ");
    };
  const ADVERSARIAL: ReadonlyArray<readonly [string, (length: number) => string]> = [
    ["page + spaces", fill("page", " ")],
    ["pages + tabs", fill("pages", "\t")],
    ["page + newlines", fill("page", "\n")],
    ["page + mixed whitespace", fill("page", " \t\n\r  　")],
    ["the incident: remove the title page + spaces", fill("remove the title page", " ")],
    ["page count + spaces", fill("page count", " ")],
    ["page / count / is across long runs", spread(["page", "count", "is", "x"])],
    ["page should + spaces", fill("page should", " ")],
    ["page + separators", fill("page", " : = ")],
    ["page + digits", fill("page ", "1")],
    ["make + spaces", fill("make", " ")],
    ["make it + spaces", fill("make it", " ")],
    ["make the + spaces", fill("make the", " ")],
    ["make / it / to across long runs", spread(["make", "it", "to", "x"])],
    ["make it 3 + spaces", fill("make it 3", " ")],
    ["digit + spaces", fill("3", " ")],
    ["digit + tabs and newlines", fill("3", "\t\n")],
    ["digit / hyphen across long runs", spread(["3", "-", "x"])],
    ["digit / en dash across long runs", spread(["3", "–", "x"])],
    ["Persian digit + spaces", fill("۳", " ")],
    ["صفحه + spaces", fill("صفحه", " ")],
    ["Seiten + spaces", fill("Seiten", " ")],
    ["a length + spaces", fill("3 pages", " ")],
    ["a postposed delta + spaces", fill("3 pages more", " ")],
    ["a postposed delta + punctuation", fill("3 pages more", " .")],
    ["repeated lengths", fill("", "1 page ")],
    ["repeated references", fill("", "page 1 ")],
    ["repeated Persian lengths", fill("", "۳ صفحه ")],
    ["repeated digits", fill("", "1 ")],
    ["repeated digits and hyphens", fill("", "1 - ")],
    ["one long number", fill("", "1")],
    ["no + spaces", fill("no", " ")],
    ["repeated negations", fill("", "no ")]
  ];

  const elapsedMs = (run: () => unknown): number => {
    const start = performance.now();
    run();
    return performance.now() - start;
  };

  it("stays linear on long runs of whatever its patterns accept between words", () => {
    for (const [length, budgetMs] of [
      [1_000, 200],
      [10_000, 1_000]
    ] as const) {
      for (const [label, build] of ADVERSARIAL) {
        const text = build(length);
        expect(text).toHaveLength(length);
        const lengthMs = elapsedMs(() => explicitTargetPagesFromText(text));
        expect(lengthMs, `${label} at ${length} chars: ${lengthMs.toFixed(1)} ms`).toBeLessThan(budgetMs);
        // The same message goes through the media reader on the same thread.
        const mediaMs = elapsedMs(() => replanSettingsFromMessage(text));
        expect(mediaMs, `${label} at ${length} chars (media): ${mediaMs.toFixed(1)} ms`).toBeLessThan(budgetMs);
      }
    }
  });
});

describe("negativeMediaPreferenceFromMessage", () => {
  it("separates dropping illustrations from dropping the cover", () => {
    expect(negativeMediaPreferenceFromMessage("make it 3 pages without illustrations")).toEqual({
      disableIllustrations: true,
      disableCover: false
    });
    // A broad word covers both; nobody saying "no images" means "except the cover".
    expect(negativeMediaPreferenceFromMessage("no images please")).toEqual({
      disableIllustrations: true,
      disableCover: true
    });
    expect(negativeMediaPreferenceFromMessage("make it longer")).toBeNull();
  });

  it("has no positive form", () => {
    expect(negativeMediaPreferenceFromMessage("add illustrations to every chapter")).toBeNull();
    expect(replanSettingsFromMessage("add illustrations to every chapter")).toEqual({});
  });

  it("never fires on the console's question-response message", () => {
    // The real format from buildQuestionResponseMessage: "no preference" sits
    // within 80 characters of a prompt naming the cover and illustrations. This
    // used to de-illustrate a paid plan on Skip.
    const message = [
      "Planning question responses:",
      "1. Should the book include illustrations on every page?",
      "Answer: Yes, watercolor style",
      "Skipped questions with no preference:",
      "- What style should the cover art use?"
    ].join("\n");
    expect(negativeMediaPreferenceFromMessage(message)).toBeNull();
    expect(replanSettingsFromMessage(message)).toEqual({});
  });

  it("never fires on the app's question-answer message", () => {
    const message = [
      "Please revise the plan using these planning answers:",
      "- Should the illustrations be watercolor or ink? Answer: No preference.",
      "- How detailed should the cover be? Answer: No preference."
    ].join("\n");
    expect(negativeMediaPreferenceFromMessage(message)).toBeNull();
  });

  it("keeps a free-typed negation inside its own clause", () => {
    // Clause punctuation between the "no" and the media noun means the "no"
    // was about something else entirely.
    expect(negativeMediaPreferenceFromMessage("no preference. Keep the cover simple")).toBeNull();
    expect(negativeMediaPreferenceFromMessage("no thanks, just fix the typos; the illustrations are fine")).toBeNull();
    // Genuine requests still read as before.
    expect(negativeMediaPreferenceFromMessage("make it without illustrations")).toEqual({
      disableIllustrations: true,
      disableCover: false
    });
    expect(negativeMediaPreferenceFromMessage("remove the pictures and shorten it")).toEqual({
      disableIllustrations: true,
      disableCover: true
    });
  });
});

describe("mediaSettingsWithReplanSettings", () => {
  it("drops illustrations without dropping the cover, and keeps the app's flag on", () => {
    const result = mediaSettingsWithReplanSettings(illustratedMediaSettings(), { fullIllustrations: false });
    expect(result.fullIllustrations).toBe(false);
    expect(result.illustrationCadence).toBe("manual");
    expect(result.includeCover).toBe(true);
    // imagesEnabled is the app's single "this book has pictures" flag, and a
    // cover is still a picture.
    expect((result.mobile as Record<string, unknown>).imagesEnabled).toBe(true);
  });

  it("turns the app's flag off only when nothing visual survives", () => {
    const result = mediaSettingsWithReplanSettings(illustratedMediaSettings(), {
      fullIllustrations: false,
      includeCover: false
    });
    expect((result.mobile as Record<string, unknown>).imagesEnabled).toBe(false);
  });

  it("records a chat-chosen page count as a custom count, not a leftover", () => {
    const mobile = mediaSettingsWithReplanSettings(illustratedMediaSettings(), { targetPages: 3 }).mobile as Record<
      string,
      unknown
    >;
    expect(mobile).toMatchObject({
      targetPages: 3,
      lengthPreset: "custom",
      pageCountMode: "custom",
      pageCountSource: "chat"
    });
  });

  it("leaves everything alone when the request named nothing", () => {
    const settings = illustratedMediaSettings();
    expect(mediaSettingsWithReplanSettings(settings, {})).toBe(settings);
    expect(mediaSettingsWithReplanSettings(settings, null)).toBe(settings);
  });
});

describe("mediaSettingsRowWriteback", () => {
  it("lets the revision's generation settings win while row-owned preferences survive", () => {
    const row = {
      fullIllustrations: true,
      includeCover: true,
      // Free presentation edits write these onto the row; the schema strips
      // them from every snapshot, so a replacement write reverted them.
      chapterHeadingStyle: "title_only",
      chapterHeadingLabel: "Part",
      includeSources: false
    };
    const snapshot = { fullIllustrations: false, includeCover: false, coverArtSource: "design" };

    expect(mediaSettingsRowWriteback(row, snapshot)).toEqual({
      fullIllustrations: false,
      includeCover: false,
      coverArtSource: "design",
      chapterHeadingStyle: "title_only",
      chapterHeadingLabel: "Part",
      includeSources: false
    });
  });

  it("never resurrects a row-owned field from a stale snapshot", () => {
    // The row no longer holds includeSources; a snapshot that still does must
    // not bring it back.
    expect(mediaSettingsRowWriteback({ fullIllustrations: true }, { includeSources: true, fullIllustrations: false })).toEqual({
      fullIllustrations: false
    });
  });

  it("preserves unknown row keys so future row-only fields are safe by default", () => {
    expect(mediaSettingsRowWriteback({ someFutureRowField: 7 }, { includeCover: false })).toEqual({
      includeCover: false,
      someFutureRowField: 7
    });
  });

  it("merges mobile metadata per key so a replan copy keeps its provenance", () => {
    const row = { mobile: { revisionOfProjectId: "project-src", targetPages: 3, imagesEnabled: true } };
    const snapshot = { mobile: { targetPages: 3, imagesEnabled: false } };

    expect(mediaSettingsRowWriteback(row, snapshot)).toEqual({
      mobile: { revisionOfProjectId: "project-src", targetPages: 3, imagesEnabled: false }
    });
  });
});

describe("inputWithReplanSettings", () => {
  it("resizes the book and de-illustrates it together", () => {
    const result = inputWithReplanSettings(illustratedInput(), { targetPages: 3, fullIllustrations: false });
    expect(result.targetPages).toBe(3);
    expect(result.mediaSettings.fullIllustrations).toBe(false);
    expect((result.mediaSettings.mobile as Record<string, unknown>).targetPages).toBe(3);
  });

  it("is a no-op for a replan that named no settings", () => {
    const input = illustratedInput();
    expect(inputWithReplanSettings(input, undefined)).toBe(input);
    expect(inputWithReplanSettings(input, {})).toBe(input);
  });
});
