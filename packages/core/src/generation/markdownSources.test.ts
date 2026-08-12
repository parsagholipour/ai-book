import { describe, expect, it } from "vitest";
import {
  compileBookMarkdown,
  hasReaderFacingSources,
  includeSourcesPreference,
  shouldPrintSourcesBackMatter
} from "./markdown.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { BookCategory } from "../categories.js";
import type { CreateProjectInput } from "../schemas/book.js";

/**
 * The Sources list at the end of a book, which `compileBookMarkdown` rebuilds
 * from the project's research rows on every export rather than from page text.
 * Whether it prints at all is a source-forward category judgement plus a
 * reader override, and it is the one part of the compiler with nothing to do
 * with chapters.
 */
describe("compileBookMarkdown sources back matter", () => {
  it("omits source citations for educational kids books even when research rows exist", () => {
    const plan = makeFallbackPlan(
      compileInput("An educational kids' picture book explaining how honeybees pollinate flowers.", "KIDS")
    );

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

    expect(markdown).not.toContain("## Sources");
    expect(markdown).not.toContain("https://example.com/source");
    expect(markdown).not.toContain("For an AI book");
    expect(markdown).not.toContain("Gemini grounded summary");
    expect(markdown).not.toContain("No external citation");
  });

  it.each(["SCIENCE", "HEALTH", "BIOGRAPHY", "HISTORY"] as const)(
    "renders source citations for the %s category",
    (category) => {
      const plan = makeFallbackPlan(compileInput("A careful source-backed book about the topic.", category));

      const markdown = compileBookMarkdown({
        plan,
        category,
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
    }
  );

  it("drops the sources back matter when the reader turned it off", () => {
    const plan = makeFallbackPlan(
      compileInput("A careful patient education book about sleep and long-term health.", "HEALTH")
    );

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

  it("prints source citations when the reader turned the list on for a non-source-forward book", () => {
    const plan = makeFallbackPlan(
      compileInput("A bedtime story about a rabbit who learns to listen to the rain.", "KIDS")
    );

    const markdown = compileBookMarkdown({
      plan,
      category: "KIDS",
      pages: [{ index: 1, title: "First", markdown: "The rabbit tucked a blanket under his chin." }],
      researchSources: [
        {
          title: "Rabbit facts",
          url: "https://example.com/rabbits",
          summary: "Background notes the reader asked to print."
        }
      ],
      includeSources: true
    });

    expect(markdown).toContain("## Sources");
    expect(markdown).toContain("- [Rabbit facts](https://example.com/rabbits)");
  });

  it("reads the sources preference off a project's media settings", () => {
    expect(includeSourcesPreference({ includeSources: false })).toBe(false);
    expect(includeSourcesPreference({ includeSources: true })).toBe(true);
    // Unset (and anything unparseable) leaves the automatic decision alone.
    expect(includeSourcesPreference({ includeCover: true })).toBeUndefined();
    expect(includeSourcesPreference(null)).toBeUndefined();
  });

  it("prints automatically only for source-forward categories unless the reader overrides", () => {
    expect(shouldPrintSourcesBackMatter({ category: "SCIENCE" })).toBe(true);
    expect(shouldPrintSourcesBackMatter({ category: "HEALTH" })).toBe(true);
    expect(shouldPrintSourcesBackMatter({ category: "KIDS" })).toBe(false);
    expect(shouldPrintSourcesBackMatter({ category: "BUSINESS" })).toBe(false);
    expect(shouldPrintSourcesBackMatter({ category: "CUSTOM" })).toBe(false);
    expect(shouldPrintSourcesBackMatter({ category: "KIDS", includeSources: true })).toBe(true);
    expect(shouldPrintSourcesBackMatter({ category: "HEALTH", includeSources: false })).toBe(false);
  });

  it("reports whether any stored research row can become a citation", () => {
    expect(hasReaderFacingSources([])).toBe(false);
    // A grounding summary with no address prints nothing, so a book holding
    // only these has no sources list for the chat to offer or remove.
    expect(hasReaderFacingSources([{ title: "Gemini grounded summary", summary: "No link." }])).toBe(false);
    expect(hasReaderFacingSources([{ title: "Sleep research", url: "  ", summary: "Blank link." }])).toBe(false);
    expect(hasReaderFacingSources([{ title: "Sleep research", url: "https://example.com/sleep", summary: "" }])).toBe(
      true
    );
    expect(
      hasReaderFacingSources([
        { title: "Sleep research", url: "https://example.com/sleep", summary: "" },
        { title: "Same page", url: "https://example.com/sleep#notes", summary: "" }
      ])
    ).toBe(true);
  });

  it("omits source citations for fictional kid stories even when source rows exist", () => {
    const plan = makeFallbackPlan(
      compileInput("A bedtime story about a rabbit who learns to listen to the rain.", "KIDS")
    );

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
      ...makeFallbackPlan(compileInput("A story for kids", "KIDS")),
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
      ...makeFallbackPlan(compileInput("Write a 5 page book for children sleep", "CUSTOM")),
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
      ...makeFallbackPlan(compileInput("A historical drama set in a lighthouse during a real storm.", "STORY")),
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

function compileInput(prompt: string, category: BookCategory): CreateProjectInput {
  return {
    prompt,
    category,
    targetPages: 1,
    complexity: category === "KIDS" || category === "CUSTOM" || category === "STORY" ? 3 : 6,
    temperature: 0.7,
    language: "en",
    mediaSettings: {
      fullIllustrations: true,
      illustrationCadence: category === "KIDS" ? "every-page" : "template-driven",
      includeCover: true,
      coverTemplate: "auto",
      finalReview: true,
      toneProfile: "neutral" as const
    }
  };
}
