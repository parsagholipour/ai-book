import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import type { GenerateJsonOptions } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import type { BookEpisodes, ChapterEpisode } from "../schemas/episodes.js";
import { planChapterForms, type ChapterComposition, type ChapterFormRange } from "./chapterForms.js";
import { materialLines, materialPayload } from "./composedChapterMaterial.js";

const input: CreateProjectInput = {
  prompt: "A global history of aggression and its causes.",
  category: "HISTORY",
  targetPages: 24,
  complexity: 5,
  temperature: 0.8,
  language: "en",
  mediaSettings: {
    fullIllustrations: false,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral"
  }
};

function ranges(): ChapterFormRange[] {
  const plan = makeFallbackPlan(input);
  let start = 1;
  return plan.chapters.map((chapter) => {
    const range = { chapter, startPage: start, endPage: start + chapter.targetPages - 1 };
    start = range.endPage + 1;
    return range;
  });
}

function episode(title: string, document: string, why: string): ChapterEpisode {
  return {
    title,
    kind: "document",
    person: "Hugh of Avalon",
    place: "Lincoln",
    date: "1186",
    document,
    why,
    searchQueries: [`"${document}" full text`]
  };
}

function writtenComposition(chapterIndex: number): ChapterComposition {
  return {
    chapterIndex,
    throughLine: "Already written on an earlier run",
    sections: ["scene", "close-reading", "argument"].map((form, index) => ({ form, subject: `Subject ${index}`, share: 1 / 3, owns: [] })),
    landing: "The Lincoln roll closes on a blank membrane.",
    avoid: []
  };
}

type Messages = GenerateJsonOptions<unknown>["messages"];

/** The real planner prompt, captured on its way to the fake provider. */
class RecordingAdapter extends FakeTextModelAdapter {
  readonly seen: Messages[] = [];
  override generateJson<T>(options: GenerateJsonOptions<T>) {
    this.seen.push(options.messages);
    return super.generateJson(options);
  }
}

const plannerPayloadSchema = z.object({
  caseAssignments: z
    .array(z.object({ chapterIndex: z.number(), episodes: z.array(z.object({ title: z.string(), document: z.string(), why: z.string() })) }))
    .optional()
});

function plannerPayload(messages: Messages) {
  return plannerPayloadSchema.parse(JSON.parse(String(messages[1]?.content)));
}

const lincoln = episode("The Lincoln charter of 1186", "Lincoln Cathedral charter roll", "How a bishop's household kept its own record");
const walterMap = episode("Walter Map at court", "De nugis curialium", "What a courtier's satire lets the chapter test");

describe("planChapterForms with the book's episodes", () => {
  it("hands the planner every chapter's assigned cases, the written chapter's included, without search queries", async () => {
    const all = ranges();
    const [written, open] = all;
    if (!written || !open) throw new Error("the fixture plan needs two chapters");
    const episodes: BookEpisodes = {
      chapters: [
        { index: written.chapter.index, episodes: [lincoln] },
        { index: open.chapter.index, episodes: [walterMap] }
      ]
    };
    const recording = new RecordingAdapter(input);
    const options = {
      input,
      plan: makeFallbackPlan(input),
      ranges: all,
      fixed: [writtenComposition(written.chapter.index)],
      episodes,
      textModel: recording
    };
    await planChapterForms(options);
    const [first] = recording.seen;
    if (!first) throw new Error("the planner made no call");
    expect(String(first[0]?.content)).toContain("caseAssignments");
    expect(plannerPayload(first).caseAssignments).toEqual([
      { chapterIndex: written.chapter.index, episodes: [{ title: lincoln.title, document: lincoln.document, why: lincoln.why }] },
      { chapterIndex: open.chapter.index, episodes: [{ title: walterMap.title, document: walterMap.document, why: walterMap.why }] }
    ]);
    expect(String(first[1]?.content)).not.toContain("searchQueries");
  });

  it("leaves the planner's messages without case assignments when no episodes were planned", async () => {
    const recording = new RecordingAdapter(input);
    await planChapterForms({ input, plan: makeFallbackPlan(input), ranges: ranges(), textModel: recording });
    const [first] = recording.seen;
    if (!first) throw new Error("the planner made no call");
    expect(String(first[0]?.content)).not.toContain("caseAssignments");
    expect(String(first[1]?.content)).not.toContain("caseAssignments");
  });
});

describe("chapter material with cases reserved for other chapters", () => {
  const reservedCases = [
    {
      chapterIndex: 3,
      episodes: [{ title: walterMap.title, person: "Walter Map", place: "Westminster", date: "1181", document: walterMap.document }]
    }
  ];

  it("tells the writer which cases belong elsewhere, even when its own episodes are empty", () => {
    const material = { episodes: [], excerpts: [], reservedCases };
    expect(materialLines({ material }).some((line) => line.includes("reservedCases"))).toBe(true);
    const payload = materialPayload({ material });
    expect(payload).toMatchObject({ reservedCases });
    expect(JSON.stringify(payload)).not.toContain("why");
  });

  it("carries the reservation beside the chapter's own episodes", () => {
    const material = { episodes: [lincoln], excerpts: [], reservedCases };
    expect(materialLines({ material }).some((line) => line.includes("reservedCases"))).toBe(true);
    expect(materialPayload({ material })).toMatchObject({ episodes: [{ title: lincoln.title, why: lincoln.why }], reservedCases });
  });

  it("keeps the legacy lines and payload when nothing is reserved", () => {
    const material = { episodes: [lincoln], excerpts: [] };
    expect(materialLines({ material }).some((line) => line.includes("reservedCases"))).toBe(false);
    expect(Object.keys(materialPayload({ material }))).toEqual(["episodes"]);
  });
});
