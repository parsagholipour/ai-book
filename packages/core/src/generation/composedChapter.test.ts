import { describe, expect, it } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import type { GenerateJsonOptions, GenerateTextOptions } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import { RHYTHM_EXEMPLAR, generateAuthorStance } from "./authorStance.js";
import { formPaletteFor, fallbackChapterComposition } from "./chapterForms.js";
import { paginateChapterMarkdown } from "./chapterPagination.js";
import {
  COMPOSE_PROMPT_MODE,  chapterDigest,
  chapterWordBudget,
  composeChapter,
  describeChapterPages,
  editChapter,
  fallbackPageDescription,
  manuscriptReadEditCap,
  readManuscript
} from "./composedChapter.js";

const input: CreateProjectInput = {
  prompt: "A global history of aggression and its causes.",
  category: "HISTORY",
  targetPages: 24,
  complexity: 5,
  temperature: 0.8,
  language: "en",
  mediaSettings: {
    fullIllustrations: true,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral"
  }
};

function setup() {
  const plan = makeFallbackPlan(input);
  const chapter = plan.chapters[0]!;
  const palette = formPaletteFor("analytical-history");
  const composition = fallbackChapterComposition({ chapter, startPage: 1, endPage: chapter.targetPages }, palette, 0);
  return { plan, chapter, composition };
}

describe("chapterWordBudget", () => {
  it("sizes the chapter so the printed book is as long as the pages paid for", () => {
    expect(chapterWordBudget(input, 8)).toEqual({ perPage: 520, min: 3440, target: 4160, max: 5120 });
  });
});

describe("composeChapter", () => {
  it("composes a chapter from the stance and form plan and returns paginatable prose", async () => {
    const { plan, chapter, composition } = setup();
    const fake = new FakeTextModelAdapter(input);
    const stance = await generateAuthorStance({ input, plan, textModel: fake });
    expect(stance.thesis).not.toBe("");
    const seen: GenerateTextOptions[] = [];
    const recording = {
      ...fake,
      generateText: (options: GenerateTextOptions) => {
        seen.push(options);
        return fake.generateText(options);
      }
    } as unknown as FakeTextModelAdapter;
    const silentPlan = { ...composition, landing: "A landing sentence the writer must never be shown.", throughLine: "A through-line the writer must never be shown." };
    const composed = await composeChapter({
      input,
      plan,
      stance,
      chapter,
      composition: silentPlan,
      chapterPageStart: 1,
      chapterPageEnd: chapter.targetPages,
      earlierChapters: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: recording
    });
    expect(composed.words).toBeGreaterThan(0);
    const system = seen[0]!.messages[0]!.content;
    expect(seen[0]!.purpose).toBe("compose-chapter");
    expect(system).toContain(RHYTHM_EXEMPLAR.slice(0, 60));
    expect(system).not.toContain(stance.voiceSample);
    expect(system).not.toContain(silentPlan.landing);
    expect(system).not.toContain(silentPlan.throughLine);
    expect(seen[0]!.messages[1]!.content).not.toContain(silentPlan.landing);
    // The shape rules ride only on the full prompt; the subtraction ablation drops them.
    if (COMPOSE_PROMPT_MODE === "full") {
      expect(system).toContain("The chapter ends where its last section ends.");
    }
    expect(system).toContain(`Section 1, form "${composition.sections[0]!.form}"`);
    expect(system).not.toContain("endingPressure");
    expect(system).not.toContain("evidenceAnchors");
    const paginated = paginateChapterMarkdown(composed.markdown, chapter.targetPages);
    expect(paginated.pages).toHaveLength(chapter.targetPages);
    expect(paginated.pages.every((page) => page.trim().length > 0)).toBe(true);
  });

  it("asks once more when the first answer is far too short", async () => {
    const { plan, chapter, composition } = setup();
    const fake = new FakeTextModelAdapter(input);
    const stance = await generateAuthorStance({ input, plan, textModel: fake });
    let calls = 0;
    const shortFirst = {
      ...fake,
      generateText: async (options: GenerateTextOptions) => {
        calls += 1;
        if (calls === 1) {
          return { text: "Too short.", model: "fake", provider: "fake" };
        }
        expect(options.messages[0]!.content).toContain("Your previous answer was 2 words");
        return fake.generateText(options);
      }
    } as unknown as FakeTextModelAdapter;
    const composed = await composeChapter({
      input,
      plan,
      stance,
      chapter,
      composition,
      chapterPageStart: 1,
      chapterPageEnd: chapter.targetPages,
      earlierChapters: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: shortFirst
    });
    expect(calls).toBe(2);
    expect(composed.attempts).toBe(2);
    expect(composed.words).toBeGreaterThan(2);
  });
});

describe("editChapter", () => {
  it("keeps the draft when the edit comes back truncated", async () => {
    const { plan, chapter, composition } = setup();
    const fake = new FakeTextModelAdapter(input);
    const stance = await generateAuthorStance({ input, plan, textModel: fake });
    const draft = Array.from({ length: 12 }, (_, index) => `Paragraph ${index} of the draft carries forty words or so of prose about the same road and the same ledger and the same person deciding.`).join("\n\n");
    const truncating = {
      ...fake,
      generateText: async () => ({ text: "Cut.", model: "fake", provider: "fake" })
    } as unknown as FakeTextModelAdapter;
    const edited = await editChapter({
      input,
      plan,
      stance,
      chapter,
      composition,
      chapterPageStart: 1,
      chapterPageEnd: chapter.targetPages,
      earlierChapters: [],
      continuityNotes: [],
      researchNotes: [],
      markdown: draft,
      textModel: truncating
    });
    expect(edited.changed).toBe(false);
    expect(edited.markdown).toBe(draft);
  });

  it("passes the reader's notes and the editorial brief to the model", async () => {
    const { plan, chapter, composition } = setup();
    const fake = new FakeTextModelAdapter(input);
    const stance = await generateAuthorStance({ input, plan, textModel: fake });
    let system = "";
    const recording = {
      ...fake,
      generateText: (options: GenerateTextOptions) => {
        system = options.messages[0]!.content;
        return fake.generateText(options);
      }
    } as unknown as FakeTextModelAdapter;
    await editChapter({
      input,
      plan,
      stance,
      chapter,
      composition,
      chapterPageStart: 1,
      chapterPageEnd: chapter.targetPages,
      earlierChapters: [],
      continuityNotes: [],
      researchNotes: [],
      markdown: "A draft.",
      readerNotes: ["Paragraph beginning 'The wall': cut the closing sentence."],
      textModel: recording
    });
    expect(system).toContain("caveats that repeat an earlier caveat");
    expect(system).toContain("Paragraph beginning 'The wall'");
    expect(system).toContain("Add no new claim, example, or source.");
  });
});

describe("describeChapterPages", () => {
  it("returns one description per page, image prompts only for illustrated pages", async () => {
    const { plan, chapter } = setup();
    const pages = [1, 2, 3].map((index) => ({ index, markdown: `Page ${index} prose about a ledger and a road.` }));
    const described = await describeChapterPages({
      input,
      plan,
      chapter,
      pages,
      illustratedIndexes: [1],
      textModel: new FakeTextModelAdapter(input)
    });
    expect(described.map((page) => page.index)).toEqual([1, 2, 3]);
    expect(described[0]!.imagePrompt).toBeDefined();
    expect(described[1]!.imagePrompt).toBeUndefined();
    expect(described[1]!.summary).not.toBe("");
  });

  it("falls back to deterministic descriptions when the provider fails", async () => {
    const { plan, chapter } = setup();
    const failing = {
      ...new FakeTextModelAdapter(input),
      generateJson: async () => {
        throw new Error("down");
      }
    } as unknown as FakeTextModelAdapter;
    const pages = [{ index: 7, markdown: "The wall at Housesteads still shows the ruts where carts turned into the gate. Nobody counted them." }];
    const described = await describeChapterPages({ input, plan, chapter, pages, illustratedIndexes: [7], textModel: failing });
    expect(described).toEqual([fallbackPageDescription(pages[0]!, true)]);
    expect(described[0]!.title).toBe("The wall at Housesteads still shows the");
    expect(described[0]!.imagePrompt).toContain("Housesteads");
  });
});

describe("readManuscript", () => {
  it("caps the chapters flagged for a second edit", async () => {
    const { plan } = setup();
    const fake = new FakeTextModelAdapter(input);
    const stance = await generateAuthorStance({ input, plan, textModel: fake });
    const flaggingEverything = {
      ...fake,
      generateJson: async (options: GenerateJsonOptions<unknown>) => {
        const data = {
          chapters: [1, 2, 3, 4].map((chapterIndex) => ({ chapterIndex, edit: true, notes: ["Cut the recap."] })),
          bookNotes: []
        };
        return { data: options.schema.parse(data), text: JSON.stringify(data), model: "fake", provider: "fake" };
      }
    } as unknown as FakeTextModelAdapter;
    const read = await readManuscript({
      input,
      plan,
      stance,
      chapters: [1, 2, 3, 4].map((index) => ({ index, title: `Chapter ${index}`, markdown: "Prose." })),
      textModel: flaggingEverything
    });
    expect(manuscriptReadEditCap(4)).toBe(4);
    expect(manuscriptReadEditCap(30)).toBe(12);
    expect(read.chapters.filter((entry) => entry.edit)).toHaveLength(4);
  });

  it("skips a manuscript too long to read whole", async () => {
    const { plan } = setup();
    const fake = new FakeTextModelAdapter(input);
    const stance = await generateAuthorStance({ input, plan, textModel: fake });
    const huge = Array.from({ length: 120_000 }, () => "word").join(" ");
    const read = await readManuscript({ input, plan, stance, chapters: [{ index: 1, title: "One", markdown: huge }], textModel: fake });
    expect(read.skipped).toContain("capped");
    expect(read.chapters).toEqual([]);
  });
});

describe("chapterDigest", () => {
  it("joins page summaries and clips long digests", () => {
    expect(chapterDigest(["One.", " Two. ", ""])).toBe("One. Two.");
    expect(chapterDigest(Array.from({ length: 80 }, () => "A twelve word summary sentence about the page and what it did."))).toMatch(/…$/u);
  });
});

import { deletionOnlyResult } from "./composedChapter.js";

describe("deletionOnlyResult", () => {
  const draft = [
    "The wall at Housesteads still shows the ruts where carts turned into the gate. Nobody counted them. The garrison did.",
    "A tally on a wooden tablet records forty-one loads of grain. It does not record who carried them. The names were never the point.",
    "The fort, the tablet and the road belong to one system. Each of them made the others possible.",
    "A century later the road was still in use, and the tablet had been thrown into a ditch with the rest of the archive."
  ].join("\n\n");

  it("accepts whole-sentence and whole-paragraph deletions in order", () => {
    const cut = [
      "The wall at Housesteads still shows the ruts where carts turned into the gate. The garrison did.",
      "A tally on a wooden tablet records forty-one loads of grain. It does not record who carried them.",
      "The fort, the tablet and the road belong to one system. Each of them made the others possible.",
      "A century later the road was still in use, and the tablet had been thrown into a ditch with the rest of the archive."
    ].join("\n\n");
    expect(deletionOnlyResult(draft, cut)).toBe(cut);
    const wholeParagraph = draft.split("\n\n").filter((_, index) => index !== 2).join("\n\n");
    expect(deletionOnlyResult(draft, wholeParagraph)).toBe(wholeParagraph);
  });

  it("refuses a rewritten sentence, a merged paragraph and a reordered one", () => {
    const rewritten = draft.replace("Nobody counted them.", "No one counted them.");
    expect(deletionOnlyResult(draft, rewritten)).toBeUndefined();
    const merged = draft.split("\n\n").slice(0, 2).join(" ") + "\n\n" + draft.split("\n\n").slice(2).join("\n\n");
    expect(deletionOnlyResult(draft, merged)).toBeUndefined();
    const reordered = draft.split("\n\n").reverse().join("\n\n");
    expect(deletionOnlyResult(draft, reordered)).toBeUndefined();
  });

  it("refuses an over-cut and an unchanged chapter", () => {
    expect(deletionOnlyResult(draft, draft.split("\n\n")[0]!)).toBeUndefined();
    expect(deletionOnlyResult(draft, draft)).toBeUndefined();
  });
});
