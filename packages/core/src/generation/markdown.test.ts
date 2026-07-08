import { describe, expect, it } from "vitest";
import { assertBookLikeMarkdown, compileBookMarkdown, findBookLikeMarkdownIssues } from "./markdown.js";
import { makeFallbackPlan } from "../prompting/templates.js";

describe("compileBookMarkdown", () => {
  it("compiles Markdown pages without metadata frontmatter and with chapter contents", () => {
    const plan = withTwoOnePageChapters(makeFallbackPlan({
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
    }));

    const markdown = compileBookMarkdown({
      plan,
      pages: [
        { index: 2, title: "Second", markdown: "The second page." },
        { index: 1, title: "First", markdown: "The first page.", imagePath: "/assets/images/p1.png" }
      ]
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
    const plan = withTwoOnePageChapters(makeFallbackPlan({
      prompt: "یک داستان کودکانه درباره کتابخانه ماه.",
      category: "KIDS",
      targetPages: 2,
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
      pages: [
        { index: 1, title: "آغاز", markdown: "صفحه نخست.", imagePath: "/assets/images/p1.png", imageAlt: "Illustration" },
        { index: 2, title: "پایان", markdown: "صفحه دوم." }
      ]
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
    const plan = withTwoOnePageChapters(makeFallbackPlan({
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
        coverTemplate: "fiction",
        finalReview: true,
        toneProfile: "neutral" as const
      }
    }));

    const markdown = compileBookMarkdown({
      plan,
      cover: { imagePath: "/assets/images/project/cover.png", imageAlt: "Cover for the book" },
      pages: [
        { index: 1, title: "First", markdown: "The first page." },
        { index: 2, title: "Second", markdown: "The second page." }
      ]
    });

    expect(markdown).toMatch(/^!\[Cover for the book]/);
    expect(markdown).not.toContain(`# ${plan.title}`);
    expect(markdown.indexOf("cover.png")).toBeLessThan(markdown.indexOf('<section class="book-contents"'));
    expect(markdown.indexOf('<section class="book-contents"')).toBeLessThan(markdown.indexOf("The first page."));
  });

  it("renders source citations for factual kid-facing books without internal research summaries", () => {
    const plan = makeFallbackPlan({
      prompt: "An educational kids' picture book explaining how honeybees pollinate flowers.",
      category: "KIDS",
      targetPages: 1,
      complexity: 3,
      temperature: 0.7,
      language: "en",
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "every-page",
        includeCover: true,
        coverTemplate: "auto",
        finalReview: true,
        toneProfile: "neutral" as const
      }
    });

    const markdown = compileBookMarkdown({
      plan,
      category: "KIDS",
      pages: [{ index: 1, title: "First", markdown: "The first page." }],
      researchSources: [
        {
          title: "meetnewbooks.com",
          url: "https://example.com/source",
          summary: "For an AI book outline exploring this topic, consider these works."
        },
        {
          title: "Gemini grounded summary",
          summary: "No external citation should be printed for this internal note."
        }
      ]
    });

    expect(markdown).toContain("## Sources");
    expect(markdown).toContain("- [meetnewbooks.com](https://example.com/source)");
    expect(markdown).not.toContain("For an AI book");
    expect(markdown).not.toContain("Gemini grounded summary");
    expect(markdown).not.toContain("No external citation");
  });

  it("renders source citations for source-forward nonfiction categories", () => {
    const plan = makeFallbackPlan({
      prompt: "A careful patient education book about sleep and long-term health.",
      category: "HEALTH",
      targetPages: 1,
      complexity: 6,
      temperature: 0.45,
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
      category: "HEALTH",
      pages: [{ index: 1, title: "First", markdown: "The first page." }],
      researchSources: [
        {
          title: "Sleep research",
          url: "https://example.com/sleep",
          summary: "A source that should appear in the back matter."
        }
      ]
    });

    expect(markdown).toContain("## Sources");
    expect(markdown).toContain("- [Sleep research](https://example.com/sleep)");
  });

  it("omits source citations for fictional kid stories even when source rows exist", () => {
    const plan = makeFallbackPlan({
      prompt: "A bedtime story about a rabbit who learns to listen to the rain.",
      category: "KIDS",
      targetPages: 1,
      complexity: 3,
      temperature: 0.9,
      language: "en",
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "every-page",
        includeCover: true,
        coverTemplate: "auto",
        finalReview: true,
        toneProfile: "neutral" as const
      }
    });

    const markdown = compileBookMarkdown({
      plan,
      category: "KIDS",
      pages: [{ index: 1, title: "First", markdown: "The rabbit tucked a blanket under his chin." }],
      researchSources: [
        {
          title: "Rabbit facts",
          url: "https://example.com/rabbits",
          summary: "Background notes that should not become back matter for a purely fictional story."
        }
      ]
    });

    expect(markdown).not.toContain("## Sources");
    expect(markdown).not.toContain("https://example.com/rabbits");
  });

  it("omits source citations for kid fables with moral lessons", () => {
    const plan = {
      ...makeFallbackPlan({
        prompt: "A story for kids",
        category: "KIDS",
        targetPages: 1,
        complexity: 3,
        temperature: 0.8,
        language: "en",
        mediaSettings: {
          fullIllustrations: true,
          illustrationCadence: "template-driven",
          includeCover: true,
          coverTemplate: "kids",
          finalReview: false,
          toneProfile: "neutral" as const
        }
      }),
      premise: "A retelling of the classic fable where slow and steady wins the race, with an instructional ending.",
      chapters: [
        {
          index: 1,
          title: "The Big Race",
          summary:
            "Turtle and Rabbit decide to race, and the story ends with a clear lesson about persistence and not giving up.",
          keyBeats: [
            "Rabbit zooms ahead while Turtle begins his slow walk.",
            "Turtle reaches the finish line; the animals celebrate, and the story closes with a simple message about steady effort."
          ],
          targetPages: 1
        }
      ]
    };

    const markdown = compileBookMarkdown({
      plan,
      category: "KIDS",
      pages: [{ index: 1, title: "First", markdown: "Slow and steady had won the race." }],
      researchSources: [
        {
          title: "Fable background",
          url: "https://example.com/tortoise-hare",
          summary: "Background notes that should not become back matter for a fictional fable retelling."
        }
      ]
    });

    expect(markdown).not.toContain("## Sources");
    expect(markdown).not.toContain("https://example.com/tortoise-hare");
  });

  it("omits source citations for a custom-category bedtime story even when background research ran", () => {
    const plan = {
      ...makeFallbackPlan({
        prompt: "Write a 5 page book for children sleep",
        category: "CUSTOM",
        targetPages: 1,
        complexity: 3,
        temperature: 0.9,
        language: "en",
        mediaSettings: {
          fullIllustrations: true,
          illustrationCadence: "every-page",
          includeCover: true,
          coverTemplate: "auto",
          finalReview: true,
          toneProfile: "neutral" as const
        }
      }),
      premise:
        "A gentle bedtime story where a child visits a magical vegetable garden at dusk, and each vegetable shares a calming sleep ritual, helping the child wind down for the night.",
      researchNotes: [
        {
          query: "children sleep routines",
          title: "sleepfoundation.org",
          url: "https://example.com/sleep-hygiene",
          summary: "Background research used to ground the writing, not reader-facing back matter."
        }
      ]
    };

    const markdown = compileBookMarkdown({
      plan,
      category: "CUSTOM",
      pages: [{ index: 1, title: "First", markdown: "The eggplant let out a long, slow yawn." }],
      researchSources: [
        {
          title: "sleepfoundation.org",
          url: "https://example.com/sleep-hygiene",
          summary: "Background research used to ground the writing, not reader-facing back matter."
        }
      ]
    });

    expect(markdown).not.toContain("## Sources");
    expect(markdown).not.toContain("https://example.com/sleep-hygiene");
  });

  it("omits source citations for story-category books even when the plan carries research", () => {
    const plan = {
      ...makeFallbackPlan({
        prompt: "A historical drama set in a lighthouse during a real storm.",
        category: "STORY",
        targetPages: 1,
        complexity: 5,
        temperature: 0.85,
        language: "en",
        mediaSettings: {
          fullIllustrations: false,
          illustrationCadence: "template-driven",
          includeCover: true,
          coverTemplate: "fiction",
          finalReview: true,
          toneProfile: "neutral" as const
        }
      }),
      researchQueries: ["historical lighthouse storms"],
      researchNotes: [
        {
          query: "historical lighthouse storms",
          title: "Storm archive",
          url: "https://example.com/storms",
          summary: "Grounding research for the fiction, not a bibliography."
        }
      ]
    };

    const markdown = compileBookMarkdown({
      plan,
      category: "STORY",
      pages: [{ index: 1, title: "First", markdown: "The lamp burned steady against the gale." }],
      researchSources: [
        {
          title: "Storm archive",
          url: "https://example.com/storms",
          summary: "Grounding research for the fiction, not a bibliography."
        }
      ]
    });

    expect(markdown).not.toContain("## Sources");
    expect(markdown).not.toContain("https://example.com/storms");
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

function withTwoOnePageChapters(plan: ReturnType<typeof makeFallbackPlan>): ReturnType<typeof makeFallbackPlan> {
  return {
    ...plan,
    chapters: [
      {
        index: 1,
        title: "Chapter 1: Opening Move",
        summary: "Open the book.",
        targetPages: 1,
        keyBeats: []
      },
      {
        index: 2,
        title: "Second Movement",
        summary: "Continue the book.",
        targetPages: 1,
        keyBeats: []
      }
    ]
  };
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
