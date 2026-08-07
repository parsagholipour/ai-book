import { describe, expect, it } from "vitest";
import { compileBookMarkdown, includeSourcesPreference } from "./markdown.js";
import { makeFallbackPlan } from "../prompting/templates.js";

/**
 * The Sources list at the end of a book, which `compileBookMarkdown` rebuilds
 * from the project's research rows on every export rather than from page text.
 * Whether it prints at all is a per-category judgement plus a reader override,
 * and it is the one part of the compiler with nothing to do with chapters.
 */
describe("compileBookMarkdown sources back matter", () => {
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

  it("drops the sources back matter when the reader turned it off", () => {
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
          summary: "A source the reader asked us to stop printing."
        }
      ],
      includeSources: false
    });

    expect(markdown).not.toContain("## Sources");
    expect(markdown).not.toContain("https://example.com/sleep");
  });

  it("reads the sources preference off a project's media settings", () => {
    expect(includeSourcesPreference({ includeSources: false })).toBe(false);
    expect(includeSourcesPreference({ includeSources: true })).toBe(true);
    // Unset (and anything unparseable) leaves the automatic decision alone.
    expect(includeSourcesPreference({ includeCover: true })).toBeUndefined();
    expect(includeSourcesPreference(null)).toBeUndefined();
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
});
