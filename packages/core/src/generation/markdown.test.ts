import { describe, expect, it } from "vitest";
import {
  assertBookLikeMarkdown,
  chapterHeadingLabelPreference,
  chapterHeadingStylePreference,
  chapterPresentationFor,
  compileBookMarkdown,
  findBookLikeMarkdownIssues,
  type MarkdownPage
} from "./markdown.js";
import { makeFallbackPlan } from "../prompting/templates.js";

describe("compileBookMarkdown", () => {
  it("compiles Markdown pages without metadata frontmatter and with chapter contents", () => {
    const plan = withTwoMultiPageChapters(makeFallbackPlan({
      prompt: "A story about a careful clockmaker.",
      category: "STORY",
      targetPages: 8,
      complexity: 5,
      temperature: 0.8,
      language: "en",
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven",
        includeCover: true,
        coverTemplate: "auto",
        finalReview: true,
        toneProfile: "neutral" as const
      }
    }));

    const markdown = compileBookMarkdown({
      plan,
      pages: chapteredPages([
        { index: 5, title: "Second", markdown: "The second page." },
        { index: 1, title: "First", markdown: "The first page.", imagePath: "/assets/images/p1.png" }
      ])
    });

    expect(markdown).toMatch(/^# /);
    expect(markdown).not.toMatch(/^---/);
    expect(markdown).not.toContain("generatedAt");
    expect(markdown).not.toMatch(/^pages:\s*\d+/m);
    expect(markdown).toContain('<section class="book-contents"');
    expect(markdown).toContain('<h2 id="book-contents-title">Contents</h2>');
    expect(markdown).toContain('<span class="book-contents__chapter">Chapter 1</span>');
    expect(markdown).toContain('<span class="book-contents__name">Opening Move</span>');
    expect(markdown).toContain('<span class="book-contents__chapter">Chapter 2</span>');
    expect(markdown).toContain('<span class="book-contents__name">Second Movement</span>');
    expect(markdown).toContain('href="#chapter-1"');
    expect(markdown).toContain("## Chapter 1: Opening Move");
    expect(markdown).toContain("## Chapter 2: Second Movement");
    expect(markdown).toContain("![Illustration](/assets/images/p1.png)");
    expect(markdown).not.toContain("## Page 1:");
    expect(markdown).not.toContain("- [Page 1:");
    expect(markdown).not.toContain('<div class="page-break"></div>');
    expect(markdown.indexOf("The first page.")).toBeLessThan(markdown.indexOf("The second page."));
    expect(findBookLikeMarkdownIssues(markdown)).toEqual([]);
  });

  it("strips generated page headings and prompt-like image alt text", () => {
    const plan = makeFallbackPlan({
      prompt: "A story about a careful clockmaker.",
      category: "STORY",
      targetPages: 1,
      complexity: 5,
      temperature: 0.8,
      language: "en",
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven",
        includeCover: true,
        coverTemplate: "auto",
        finalReview: true,
        toneProfile: "neutral" as const
      }
    });

    const markdown = compileBookMarkdown({
      plan,
      pages: [
        {
          index: 1,
          title: "Page 1: Page 1: Chapter 1: The Door Opens",
          markdown: "## Page 1: Page 1: Chapter 1: The Door Opens\n\nThe first page.",
          imagePath: "/assets/images/p1.png",
          imageAlt: "Global visual style: cinematic. Continuity rules: keep characters consistent."
        }
      ]
    });

    expect(markdown).toContain("The first page.");
    expect(markdown).toContain("![Illustration](/assets/images/p1.png)");
    expect(markdown).not.toContain("Page 1: Page 1");
    expect(markdown).not.toContain("## Page 1:");
    expect(markdown).not.toContain("Global visual style");
  });

  it("localizes visible Markdown scaffolding for non-English books", () => {
    const plan = withTwoMultiPageChapters(makeFallbackPlan({
      prompt: "یک داستان کودکانه درباره کتابخانه ماه.",
      category: "KIDS",
      targetPages: 8,
      complexity: 3,
      temperature: 0.8,
      language: "Persian",
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "every-page",
        includeCover: true,
        coverTemplate: "auto",
        finalReview: true,
        toneProfile: "neutral" as const
      }
    }));

    const markdown = compileBookMarkdown({
      plan,
      language: "Persian",
      pages: chapteredPages([
        { index: 1, title: "آغاز", markdown: "صفحه نخست.", imagePath: "/assets/images/p1.png", imageAlt: "Illustration" },
        { index: 5, title: "پایان", markdown: "صفحه دوم." }
      ])
    });

    expect(markdown).toContain('<h2 id="book-contents-title">فهرست</h2>');
    expect(markdown).toContain('<span class="book-contents__chapter">فصل 1</span>');
    expect(markdown).toContain("## فصل 1: Opening Move");
    expect(markdown).toContain("![تصویر](/assets/images/p1.png)");
    expect(markdown).not.toContain(">Contents<");
    expect(markdown).not.toContain("![Illustration]");
  });

  it("unwraps whole-page Markdown fences so prose does not render as code", () => {
    const plan = makeFallbackPlan({
      prompt: "A story about a careful clockmaker.",
      category: "STORY",
      targetPages: 1,
      complexity: 5,
      temperature: 0.8,
      language: "en",
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven",
        includeCover: true,
        coverTemplate: "auto",
        finalReview: true,
        toneProfile: "neutral" as const
      }
    });

    const markdown = compileBookMarkdown({
      plan,
      pages: [
        {
          index: 1,
          title: "First",
          markdown: "```markdown\nThe first page should be manuscript prose.\n```"
        }
      ]
    });

    expect(markdown).toContain("The first page should be manuscript prose.");
    expect(markdown).not.toContain("```");
  });

  it("suppresses page-like chapter plans instead of creating a heading per page", () => {
    const plan = withPageLikeChapters(makeFallbackPlan({
      prompt: "A story about a careful clockmaker.",
      category: "STORY",
      targetPages: 6,
      complexity: 5,
      temperature: 0.8,
      language: "en",
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven",
        includeCover: true,
        coverTemplate: "auto",
        finalReview: true,
        toneProfile: "neutral" as const
      }
    }));

    const markdown = compileBookMarkdown({
      plan,
      pages: Array.from({ length: 6 }, (_, index) => ({
        index: index + 1,
        title: `Page Title ${index + 1}`,
        markdown: `Page ${index + 1} prose.`
      }))
    });

    expect(markdown).not.toContain("book-contents");
    expect(markdown).not.toContain("## Chapter");
    expect(markdown).not.toContain("## Page");
  });

  it("titles a short book's movements without calling three paragraphs a chapter", () => {
    // The shape the planner writes for a three-page book: one beat per page.
    // The beats are worth titling — they are why the pages differ — but none of
    // them is a chapter, and a Contents page listing three costs a quarter of
    // the PDF.
    const plan = withThreeOnePageChapters(storyPlan());
    const markdown = compileBookMarkdown({
      plan,
      language: "Persian",
      pages: Array.from({ length: 3 }, (_, offset) => ({
        index: offset + 1,
        title: `Movement ${offset + 1}`,
        markdown: `Prose for page ${offset + 1}.`
      }))
    });

    expect(markdown).toContain("## Opening Move");
    expect(markdown).toContain("## Second Movement");
    expect(markdown).toContain("## Closing Move");
    expect(markdown).not.toContain("فصل");
    expect(markdown).not.toContain("Chapter 1");
    expect(markdown).not.toContain("book-contents");
    expect(findBookLikeMarkdownIssues(markdown)).toEqual([]);
  });

  it("still numbers a short book's chapters when the reader asked for a label", () => {
    const markdown = compileBookMarkdown({
      plan: withThreeOnePageChapters(storyPlan()),
      pages: Array.from({ length: 3 }, (_, offset) => ({
        index: offset + 1,
        title: `Movement ${offset + 1}`,
        markdown: `Prose for page ${offset + 1}.`
      })),
      chapterHeadingLabel: "Part",
      chapterHeadingStyle: "label_number_title"
    });

    // A stated preference outranks the book's size; only the default is sized.
    expect(markdown).toContain("## Part 1: Opening Move");
  });

  it("sizes the chapter apparatus to the book", () => {
    const pages = (count: number) => Array.from({ length: count }, (_, offset) => ({ index: offset + 1 }));
    const startsAt = (...pageIndexes: number[]) => pageIndexes.map((pageIndex) => ({ pageIndex }));

    // Nothing to divide.
    expect(chapterPresentationFor(startsAt(1), pages(8))).toBe("none");
    expect(chapterPresentationFor([], pages(8))).toBe("none");

    // Multi-page divisions in a book long enough to carry them.
    expect(chapterPresentationFor(startsAt(1, 4, 6), pages(8))).toBe("chapters");
    expect(chapterPresentationFor(startsAt(1, 9, 17), pages(24))).toBe("chapters");

    // Real divisions, book too short for the word "Chapter".
    expect(chapterPresentationFor(startsAt(1, 3, 5), pages(7))).toBe("sections");

    // A division per page: a structure in a leaflet, a page index above that.
    expect(chapterPresentationFor(startsAt(1, 2, 3), pages(3))).toBe("sections");
    expect(chapterPresentationFor(startsAt(1, 2, 3, 4), pages(4))).toBe("sections");
    expect(chapterPresentationFor(startsAt(1, 2, 3, 4, 5), pages(5))).toBe("none");
    expect(chapterPresentationFor(startsAt(1, 2, 3, 4, 5, 6, 7, 8), pages(8))).toBe("none");

    // Sliced uniformly too fine: fourteen divisions over twenty-four pages
    // averages under two pages each, even though few of them are single pages.
    expect(chapterPresentationFor(startsAt(1, 3, 5, 6, 8, 10, 11, 13, 15, 16, 18, 20, 21, 23), pages(24))).toBe("none");

    // One long division cannot carry four single-page ones: the average here is
    // 3.6 pages, which forgives them, and the share of single pages does not.
    expect(chapterPresentationFor(startsAt(1, 2, 3, 4, 5), pages(18))).toBe("none");

    // Order is not assumed, and the last division runs to the final page.
    expect(chapterPresentationFor(startsAt(6, 1, 4), pages(8))).toBe("chapters");
  });

  it("prefers reader chapters over page-like generation chapters", () => {
    const plan = {
      ...makeFallbackPlan({
        prompt: "A long argument that resolves across several editorial movements.",
        category: "CUSTOM",
        targetPages: 10,
        complexity: 5,
        temperature: 0.8,
        language: "en",
        mediaSettings: {
          fullIllustrations: false,
          illustrationCadence: "template-driven",
          includeCover: false,
          coverTemplate: "auto",
          finalReview: true,
          toneProfile: "neutral" as const
        }
      }),
      chapters: Array.from({ length: 10 }, (_, index) => ({
        index: index + 1,
        title: `Page-like Chapter ${index + 1}`,
        summary: `Internal page-like section ${index + 1}.`,
        targetPages: 1,
        keyBeats: []
      }))
    };

    const markdown = compileBookMarkdown({
      plan,
      readerChapters: [
        {
          index: 1,
          title: "The First Claim",
          summary: "The manuscript opens its central claim.",
          startPageIndex: 1,
          endPageIndex: 4
        },
        {
          index: 2,
          title: "The Counterweight",
          summary: "The manuscript complicates the claim.",
          startPageIndex: 5,
          endPageIndex: 7
        },
        {
          index: 3,
          title: "The Resolution",
          summary: "The manuscript resolves the claim.",
          startPageIndex: 8,
          endPageIndex: 10
        }
      ],
      pages: Array.from({ length: 10 }, (_, index) => ({
        index: index + 1,
        title: `Page Title ${index + 1}`,
        markdown: `Page ${index + 1} prose.`
      }))
    });

    expect(markdown).toContain('<section class="book-contents"');
    expect(markdown).toContain('<span class="book-contents__chapter">Chapter 1</span>');
    expect(markdown).toContain('<span class="book-contents__name">The First Claim</span>');
    expect(markdown).toContain('<span class="book-contents__chapter">Chapter 2</span>');
    expect(markdown).toContain('<span class="book-contents__name">The Counterweight</span>');
    expect(markdown).toContain('<span class="book-contents__chapter">Chapter 3</span>');
    expect(markdown).toContain('<span class="book-contents__name">The Resolution</span>');
    expect(markdown).toContain("## Chapter 1: The First Claim");
    expect(markdown).not.toContain("Page-like Chapter");
  });

  it("uses a cover image without adding a standalone reader-facing title page", () => {
    const plan = makeFallbackPlan({
      prompt: "A story about a careful clockmaker.",
      category: "STORY",
      targetPages: 1,
      complexity: 5,
      temperature: 0.8,
      language: "en",
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven",
        includeCover: true,
        coverTemplate: "fiction",
        finalReview: true,
        toneProfile: "neutral" as const
      }
    });

    const markdown = compileBookMarkdown({
      plan,
      cover: { imagePath: "/assets/images/project/cover.png", imageAlt: "Cover for the book" },
      pages: [{ index: 1, title: "First", markdown: "The first page." }]
    });

    expect(markdown).toContain("![Cover for the book](/assets/images/project/cover.png)");
    expect(markdown).not.toContain('<div class="page-break"></div>');
    expect(markdown).toMatch(/^!\[Cover for the book]/);
    expect(markdown).not.toContain(`# ${plan.title}`);
    expect(markdown.indexOf("cover.png")).toBeLessThan(markdown.indexOf("The first page."));
    expect(markdown).not.toContain("book-contents");
  });

  it("places contents right after the cover instead of a title-only page", () => {
    const plan = withTwoMultiPageChapters(makeFallbackPlan({
      prompt: "A story about a careful clockmaker.",
      category: "STORY",
      targetPages: 8,
      complexity: 5,
      temperature: 0.8,
      language: "en",
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven",
        includeCover: true,
        coverTemplate: "fiction",
        finalReview: true,
        toneProfile: "neutral" as const
      }
    }));

    const markdown = compileBookMarkdown({
      plan,
      cover: { imagePath: "/assets/images/project/cover.png", imageAlt: "Cover for the book" },
      pages: chapteredPages([
        { index: 1, title: "First", markdown: "The first page." },
        { index: 5, title: "Second", markdown: "The second page." }
      ])
    });

    expect(markdown).toMatch(/^!\[Cover for the book]/);
    expect(markdown).not.toContain(`# ${plan.title}`);
    expect(markdown.indexOf("cover.png")).toBeLessThan(markdown.indexOf('<section class="book-contents"'));
    expect(markdown.indexOf('<section class="book-contents"')).toBeLessThan(markdown.indexOf("The first page."));
  });


  it("drops the chapter label from headings and contents when the reader asks for titles only", () => {
    const markdown = compileBookMarkdown({
      plan: withTwoMultiPageChapters(storyPlan()),
      pages: chapteredPages(),
      chapterHeadingStyle: "title_only"
    });

    expect(markdown).toContain("## Opening Move");
    expect(markdown).toContain("## Second Movement");
    expect(markdown).not.toContain("Chapter 1");
    expect(markdown).not.toContain("Chapter 2");
    // The eyebrow is dropped rather than emptied; the title still names the chapter.
    expect(markdown).not.toContain('<span class="book-contents__chapter">');
    expect(markdown).toContain('<span class="book-contents__name">Opening Move</span>');
    expect(findBookLikeMarkdownIssues(markdown)).toEqual([]);
  });

  it("keeps numbering without the label when the reader asks for numbered titles", () => {
    const markdown = compileBookMarkdown({
      plan: withTwoMultiPageChapters(storyPlan()),
      pages: chapteredPages(),
      chapterHeadingStyle: "number_title"
    });

    expect(markdown).toContain("## 1. Opening Move");
    expect(markdown).toContain("## 2. Second Movement");
    expect(markdown).not.toContain("Chapter 1");
    expect(markdown).toContain('<span class="book-contents__chapter">1</span>');
  });

  it("swaps in a custom chapter label without doubling a title that already carries it", () => {
    const plan = withTwoMultiPageChapters(storyPlan());
    const markdown = compileBookMarkdown({
      // The stored title is "Chapter 1: Opening Move"; under a custom label the
      // English prefix still has to come off or the heading reads twice.
      plan: { ...plan, chapters: [{ ...plan.chapters[0]!, title: "Part 1: Opening Move" }, plan.chapters[1]!] },
      pages: chapteredPages(),
      chapterHeadingLabel: "Part"
    });

    expect(markdown).toContain("## Part 1: Opening Move");
    expect(markdown).not.toContain("Part 1: Part 1:");
    expect(markdown).toContain('<span class="book-contents__chapter">Part 1</span>');
  });

  it("never emits an empty heading when a titleless chapter is set to titles only", () => {
    const plan = withTwoMultiPageChapters(storyPlan());
    const markdown = compileBookMarkdown({
      plan: { ...plan, chapters: [{ ...plan.chapters[0]!, title: "   " }, plan.chapters[1]!] },
      pages: chapteredPages(),
      chapterHeadingStyle: "title_only"
    });

    // A bare "## " would fold this chapter into the previous one in the EPUB.
    expect(markdown).not.toMatch(/^##\s*$/m);
    expect(markdown).toContain("## Chapter 1");
  });

  it("still strips a page's own heading after the chapter style changes", () => {
    const markdown = compileBookMarkdown({
      plan: withTwoMultiPageChapters(storyPlan()),
      pages: chapteredPages([
        // Written when "Chapter 1: ..." was canonical. It must not survive as a
        // duplicate underneath the newly styled heading.
        { index: 1, title: "First", markdown: "# Chapter 1: Opening Move\n\nThe first page." }
      ]),
      chapterHeadingStyle: "title_only"
    });

    expect(markdown).toContain("## Opening Move");
    expect(markdown).not.toContain("# Chapter 1: Opening Move");
    expect(markdown).toContain("The first page.");
  });

  it("reads the chapter heading preferences off a project's media settings", () => {
    expect(chapterHeadingStylePreference({ chapterHeadingStyle: "title_only" })).toBe("title_only");
    expect(chapterHeadingStylePreference({ chapterHeadingStyle: "nonsense" })).toBeUndefined();
    expect(chapterHeadingStylePreference(null)).toBeUndefined();
    expect(chapterHeadingLabelPreference({ chapterHeadingLabel: "Part" })).toBe("Part");
    // "Page" would make assertBookLikeMarkdown throw on every export.
    expect(chapterHeadingLabelPreference({ chapterHeadingLabel: "page" })).toBeUndefined();
    expect(chapterHeadingLabelPreference({ chapterHeadingLabel: "#Part" })).toBeUndefined();
    expect(chapterHeadingLabelPreference({ chapterHeadingLabel: "x".repeat(40) })).toBeUndefined();
    expect(chapterHeadingLabelPreference({})).toBeUndefined();
  });


  it("rejects compiled export artifacts", () => {
    const badMarkdown = [
      "---",
      'title: "Bad"',
      "pages: 2",
      'generatedAt: "2026-05-24T00:00:00.000Z"',
      "---",
      "",
      "## Table of Contents",
      "- [Page 1: Start](#page-1)",
      "",
      '<div class="page-break"></div>',
      "## Page 1: Start",
      "![Illustration for Page 1](/assets/images/p1.png)"
    ].join("\n");

    expect(findBookLikeMarkdownIssues(badMarkdown)).toEqual([
      "frontmatter block",
      "generatedAt metadata",
      "page-count metadata",
      "page-number heading",
      "page-number table of contents link",
      "raw page-break markup",
      "page-number image alt text"
    ]);
    expect(() => assertBookLikeMarkdown(badMarkdown)).toThrow(/reader-facing generation artifacts/);
  });
});

describe("compileBookMarkdown title page", () => {
  const cover = { imagePath: "/assets/images/project/cover.png", imageAlt: "Cover for the book" };
  const pages: MarkdownPage[] = [{ index: 1, title: "First", markdown: "The first page." }];

  it("does not repeat the cover metadata on a second title page", () => {
    const plan = { ...storyPlan(), title: "The Clockmaker", subtitle: "A patient trade" };

    const markdown = compileBookMarkdown({ plan, cover, pages, authorName: "Ada Lovelace" });

    expect(markdown).toMatch(/^!\[Cover for the book]/);
    expect(markdown).not.toContain("book-title-page");
    expect(markdown).not.toContain("The Clockmaker");
    expect(markdown).not.toContain("A patient trade");
    expect(markdown).not.toContain("Ada Lovelace");
    expect(markdown.indexOf("cover.png")).toBeLessThan(markdown.indexOf("The first page."));
    expect(findBookLikeMarkdownIssues(markdown)).toEqual([]);
  });

  it("leaves the front matter untouched when no author is named", () => {
    // The guarantee that no book written before title pages existed gains a
    // page on its next recompile.
    const plan = { ...storyPlan(), title: "The Clockmaker", subtitle: "A patient trade" };

    for (const authorName of [undefined, "", "   "]) {
      const markdown = compileBookMarkdown({ plan, cover, pages, authorName });
      expect(markdown, String(authorName)).not.toContain("book-title-page");
      expect(markdown, String(authorName)).toBe(compileBookMarkdown({ plan, cover, pages }));
    }
  });

  it("replaces the plain heading rather than setting the title twice", () => {
    const plan = { ...storyPlan(), title: "The Clockmaker", subtitle: "A patient trade" };

    const markdown = compileBookMarkdown({ plan, pages, authorName: "Ada Lovelace" });

    expect(markdown).toMatch(/^<section class="book-title-page">/);
    expect(markdown).not.toContain(`# ${plan.title}`);
    expect(markdown).not.toContain(`_${plan.subtitle}_`);
  });

  it("omits the subtitle line for a book that has none", () => {
    const plan = { ...storyPlan(), title: "The Clockmaker", subtitle: undefined };

    const markdown = compileBookMarkdown({ plan, pages, authorName: "Ada Lovelace" });

    expect(markdown).not.toContain("book-title-page__subtitle");
    expect(markdown).toContain('<p class="book-title-page__byline">by Ada Lovelace</p>');
  });

  it("writes the byline in the book's own language", () => {
    const plan = { ...storyPlan(), title: "ساعت‌ساز" };

    const markdown = compileBookMarkdown({ plan, pages, language: "fa", authorName: "پروین" });

    expect(markdown).toContain('<p class="book-title-page__byline">نوشتهٔ پروین</p>');
    expect(markdown).not.toContain("by پروین");
  });

  it("escapes a name that carries markup", () => {
    const plan = { ...storyPlan(), title: "The Clockmaker" };

    const markdown = compileBookMarkdown({ plan, pages, authorName: "Fisher & <b>Sons</b>" });

    expect(markdown).toContain("by Fisher &amp; &lt;b&gt;Sons&lt;/b&gt;");
    expect(markdown).not.toContain("<b>Sons</b>");
  });
});

function storyPlan(): ReturnType<typeof makeFallbackPlan> {
  return makeFallbackPlan({
    prompt: "A story about a careful clockmaker.",
    category: "STORY",
    targetPages: 2,
    complexity: 5,
    temperature: 0.8,
    language: "en",
    mediaSettings: {
      fullIllustrations: true,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "auto",
      finalReview: true,
      toneProfile: "neutral" as const
    }
  });
}

function withTwoMultiPageChapters(plan: ReturnType<typeof makeFallbackPlan>): ReturnType<typeof makeFallbackPlan> {
  return {
    ...plan,
    chapters: [
      {
        index: 1,
        title: "Chapter 1: Opening Move",
        summary: "Open the book.",
        targetPages: 4,
        keyBeats: []
      },
      {
        index: 2,
        title: "Second Movement",
        summary: "Continue the book.",
        targetPages: 4,
        keyBeats: []
      }
    ]
  };
}

function withThreeOnePageChapters(plan: ReturnType<typeof makeFallbackPlan>): ReturnType<typeof makeFallbackPlan> {
  return {
    ...plan,
    chapters: [
      { index: 1, title: "Chapter 1: Opening Move", summary: "Open the book.", targetPages: 1, keyBeats: [] },
      { index: 2, title: "Second Movement", summary: "Continue the book.", targetPages: 1, keyBeats: [] },
      { index: 3, title: "Closing Move", summary: "Close the book.", targetPages: 1, keyBeats: [] }
    ]
  };
}

/**
 * A book big enough to earn numbered chapters and a Contents page: eight pages
 * under {@link withTwoMultiPageChapters}. Anything smaller now compiles to
 * unnumbered section titles, so every heading-wording test needs this shape.
 * Pass the pages the test actually cares about; the rest are filler.
 */
function chapteredPages(overrides: MarkdownPage[] = []): MarkdownPage[] {
  const byIndex = new Map(overrides.map((page) => [page.index, page]));
  return Array.from({ length: 8 }, (_, offset) => {
    const index = offset + 1;
    return byIndex.get(index) ?? { index, title: `Movement ${index}`, markdown: `Prose for page ${index}.` };
  });
}

function withPageLikeChapters(plan: ReturnType<typeof makeFallbackPlan>): ReturnType<typeof makeFallbackPlan> {
  return {
    ...plan,
    chapters: Array.from({ length: 6 }, (_, index) => ({
      index: index + 1,
      title: `Page-like Chapter ${index + 1}`,
      summary: `Internal page-like section ${index + 1}.`,
      targetPages: 1,
      keyBeats: []
    }))
  };
}

describe("non-Latin headings", () => {
  it("keeps a Persian heading that does not repeat the page title", () => {
    const plan = makeFallbackPlan({
      prompt: "یک داستان کودکانه درباره چمنزار خواب‌آلود.",
      category: "CUSTOM",
      targetPages: 1,
      complexity: 5,
      temperature: 0.8,
      language: "fa",
      mediaSettings: {
        fullIllustrations: false,
        illustrationCadence: "template-driven",
        includeCover: false,
        coverTemplate: "auto",
        finalReview: true,
        toneProfile: "neutral" as const
      }
    });

    const markdown = compileBookMarkdown({
      plan,
      pages: [
        {
          index: 1,
          title: "شب‌بخیر، چمنزار",
          markdown: "## ستاره‌های بیدار\n\nخرگوش کوچولو زیر آسمان پرستاره دراز کشیده بود."
        }
      ]
    });

    expect(markdown).toContain("ستاره‌های بیدار");
    expect(markdown).toContain("خرگوش کوچولو زیر آسمان پرستاره دراز کشیده بود.");
  });

  it("still strips a heading that repeats the Persian page title", () => {
    const plan = makeFallbackPlan({
      prompt: "یک داستان کودکانه درباره چمنزار خواب‌آلود.",
      category: "CUSTOM",
      targetPages: 1,
      complexity: 5,
      temperature: 0.8,
      language: "fa",
      mediaSettings: {
        fullIllustrations: false,
        illustrationCadence: "template-driven",
        includeCover: false,
        coverTemplate: "auto",
        finalReview: true,
        toneProfile: "neutral" as const
      }
    });

    const markdown = compileBookMarkdown({
      plan,
      pages: [
        {
          index: 1,
          title: "شب‌بخیر، چمنزار",
          markdown: "## شب‌بخیر، چمنزار\n\nخرگوش کوچولو زیر آسمان پرستاره دراز کشیده بود."
        }
      ]
    });

    expect(markdown).not.toContain("## شب‌بخیر، چمنزار");
    expect(markdown).toContain("خرگوش کوچولو زیر آسمان پرستاره دراز کشیده بود.");
  });
});
