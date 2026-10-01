import { describe, expect, it } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import type { GenerateJsonOptions, GenerateTextOptions, TextModelAdapter } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import { acceptsChapterEdit, type ChapterEditAcceptanceOptions } from "./chapterEditAcceptance.js";
import {
  ESTABLISHED_FACTS_ACCEPTANCE_RULE,
  ESTABLISHED_FACTS_EDITOR_RULE,
  ESTABLISHED_FACTS_WRITER_RULE,
  EXTRACT_CHAPTER_FACTS_PURPOSE,
  FACT_VALUE_WORDS,
  MAX_CHAPTER_FACTS,
  chapterFactLines,
  extractChapterFacts,
  newFacts,
  storedChapterFact,
  type ChapterFact
} from "./chapterFacts.js";
import { fallbackChapterComposition, formPaletteFor } from "./chapterForms.js";
import { composeChapter, editChapter, type ComposeChapterOptions } from "./composedChapter.js";

const input: CreateProjectInput = {
  prompt: "A fantasy novel about an archivist who finds the founding chronicle forged.",
  category: "CUSTOM",
  targetPages: 20,
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

const ledger: ChapterFact[] = [
  { subject: "Queen Maelin", attribute: "relation", value: "mother of Avar" },
  { subject: "Queen Maelin", attribute: "pronoun", value: "she" },
  { subject: "Ors Tal", attribute: "role", value: "aerie clerk for twenty-seven years" },
  { subject: "The founding chronicle", attribute: "dates the victory", value: "fourth day of Ashfall, Year One" }
];

function jsonModel(reply: unknown, seen: GenerateJsonOptions<unknown>[] = []): TextModelAdapter {
  return {
    generateJson: async (options: GenerateJsonOptions<unknown>) => {
      seen.push(options);
      const data = options.schema.parse(reply);
      return { data, text: JSON.stringify(reply), provider: "fixture", model: "fixture" };
    }
  } as unknown as TextModelAdapter;
}

describe("extractChapterFacts", () => {
  it("names its keys and shape, reads a figure as its stand-in, and hands the model the ledger so far", async () => {
    const seen: GenerateJsonOptions<unknown>[] = [];
    const markdown = 'Sera copied the entry.\n\n```figure\n{"kind":"bar","title":"Flights by month","categories":["A"],"series":[{"name":"n","values":[1]}]}\n```\n\nThe ledger said otherwise.';
    const reading = await extractChapterFacts({
      title: "The Ashen Chronicle",
      chapterIndex: 3,
      markdown,
      known: ledger,
      textModel: jsonModel({ subjects: [{ name: "Iven Marr", kind: "person", facts: [{ attribute: "role", value: "a former rider" }, { attribute: "pronoun", value: "he" }] }] }, seen)
    });
    expect(reading.facts).toEqual([
      { subject: "Iven Marr", attribute: "role", value: "a former rider" },
      { subject: "Iven Marr", attribute: "pronoun", value: "he" }
    ]);
    const call = seen[0]!;
    expect(call.purpose).toBe(EXTRACT_CHAPTER_FACTS_PURPOSE);
    const system = call.messages.find((message) => message.role === "system")!.content;
    expect(system).toContain('Return {"subjects": [{"name": "", "kind": "person", "facts": [{"attribute": "", "value": ""}]}]}');
    expect(system).toContain(`at most ${MAX_CHAPTER_FACTS} pairs`);
    expect(system).toContain(`at most ${FACT_VALUE_WORDS} words`);
    expect(system).toContain("never a quotation");
    expect(system).toContain('kind "source" with facts empty');
    expect(system).toContain("knownFacts stands");
    const payload = JSON.parse(call.messages.find((message) => message.role === "user")!.content);
    expect(payload.chapter.index).toBe(3);
    expect(payload.chapter.markdown).toContain("[Figure: Flights by month]");
    expect(payload.chapter.markdown).not.toContain('"kind":"bar"');
    expect(payload.knownFacts).toEqual([
      "Queen Maelin — relation: mother of Avar; pronoun: she.",
      "Ors Tal — role: aerie clerk for twenty-seven years.",
      "The founding chronicle — dates the victory: fourth day of Ashfall, Year One."
    ]);
  });

  it("throws what the provider throws, so the caller decides a failed read is a chapter with no facts", async () => {
    const failing = { generateJson: async () => { throw new Error("gateway 503"); } } as unknown as TextModelAdapter;
    await expect(extractChapterFacts({ title: "T", chapterIndex: 2, markdown: "Prose.", known: [], textModel: failing })).rejects.toThrow("gateway 503");
  });
});

describe("newFacts", () => {
  it("files a cited source apart, and refuses a value that quotes, runs to a passage or copies the chapter", () => {
    const chapter = "The note in the margin said the valley measure stands by the old pledge and nothing more, and Mara copied it twice.";
    const { facts, dropped } = newFacts([
      { name: "The Coaching Habit", kind: "source", facts: [{ attribute: "advice", value: "ask one question at a time" }] },
      { name: "Kluger and DeNisi", kind: "Source", facts: [] },
      { name: "The ledger", kind: "thing", facts: [
        { attribute: "note", value: "“Witnessed before the riders’ crown was raised”" },
        { attribute: "summary", value: "says 'Terms renewed at the third thaw'" },
        { attribute: "margin", value: "the valley measure stands by the old pledge and nothing more" },
        { attribute: "contents", value: "a record of ford passage, caravans, grain, guides, pasture, watchfires, witnesses, seals, dates and the later renewal terms" },
        { attribute: "dated", value: "18 Rainwane, Year 63 of the River Count" },
        { attribute: "keeper", value: "the riders’ archive" }
      ] }
    ], [], chapter);
    expect(dropped).toEqual({ sources: 2, quoted: 2, long: 1, copied: 1 });
    expect(facts).toEqual([
      { subject: "The ledger", attribute: "dated", value: "18 Rainwane, Year 63 of the River Count" },
      { subject: "The ledger", attribute: "keeper", value: "the riders’ archive" }
    ]);
  });

  it("drops a value the ledger already holds, lets a new value replace an old one, and keeps at most the cap", () => {
    const { facts } = newFacts([
      { name: "queen maelin", kind: "person", facts: [{ attribute: "Pronoun", value: "she." }, { attribute: "age", value: "sixty" }] },
      { name: "Ors Tal", kind: "person", facts: [{ attribute: "role", value: "keeper of the north roost" }, { attribute: "role", value: "keeper of the lower roost" }] },
      { name: 7, kind: "person", facts: [{ attribute: "role", value: "nobody" }] },
      { name: "Kest", kind: "thing", facts: [{ attribute: "owner", value: "" }] },
      ...Array.from({ length: 20 }, (_, index) => ({ name: `Rider ${index}`, kind: "person", facts: [{ attribute: "wing", value: "the ash wing" }] }))
    ], ledger);
    expect(facts[0]).toEqual({ subject: "queen maelin", attribute: "age", value: "sixty" });
    expect(facts[1]).toEqual({ subject: "Ors Tal", attribute: "role", value: "keeper of the lower roost" });
    expect(facts.some((fact) => fact.subject === "Kest")).toBe(false);
    expect(facts).toHaveLength(MAX_CHAPTER_FACTS);
  });
});

describe("chapterFactLines", () => {
  it("gives one line per subject in the order the book met it, each attribute once with its latest value", () => {
    expect(chapterFactLines([
      ...ledger,
      { subject: "Kest", attribute: "owner", value: "Iven Marr" },
      { subject: "Ors Tal", attribute: "role", value: "keeper of the lower roost" },
      { subject: "Ors Tal", attribute: "", value: "a note stored before attributes" }
    ])).toEqual([
      "Queen Maelin — relation: mother of Avar; pronoun: she.",
      "Ors Tal — role: keeper of the lower roost; a note stored before attributes.",
      "The founding chronicle — dates the victory: fourth day of Ashfall, Year One.",
      "Kest — owner: Iven Marr."
    ]);
  });

  it("keeps a person's first attribute and newest figures when their line runs long, dropping the oldest", () => {
    const maya: ChapterFact[] = [
      { subject: "Maya", attribute: "job", value: "freelance illustrator" },
      ...Array.from({ length: 60 }, (_, index) => ({ subject: "Maya", attribute: `figure ${index}`, value: `$${1000 + index}` })),
      { subject: "Maya", attribute: "figure 3", value: "$9,999" }
    ];
    const [line] = chapterFactLines(maya);
    expect(line!.length).toBeLessThanOrEqual(1000);
    expect(line!.startsWith("Maya — job: freelance illustrator; ")).toBe(true);
    expect(line).toContain("figure 59: $1059");
    expect(line).toContain("figure 3: $9,999");
    expect(line).not.toContain("figure 0:");
    expect(line).not.toContain("$1003");
  });

  it("over the budget keeps the subjects the chapter names first, in the ledger's own order", () => {
    const many = Array.from({ length: 40 }, (_, index) => ({ subject: `Witness ${index}`, attribute: "role", value: "a clerk of the lower archive who signed the roll" }));
    const all = chapterFactLines([...many, ...ledger]);
    const lines = chapterFactLines([...many, ...ledger], { mentionText: "Ors Tal signed the flight ledger.", maxCharacters: 400 });
    expect(lines.join("\n").length).toBeLessThanOrEqual(400);
    expect(lines.length).toBeLessThan(all.length);
    // Ors Tal is the ledger's forty-second subject and the only one the chapter names.
    expect(lines).toContain("Ors Tal — role: aerie clerk for twenty-seven years.");
    const positions = lines.map((line) => all.indexOf(line));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe("storedChapterFact", () => {
  it("reads the current shape and a clause stored before attributes, and nothing else", () => {
    expect(storedChapterFact({ subject: "Maya", attribute: "job", value: "illustrator" })).toEqual({ subject: "Maya", attribute: "job", value: "illustrator" });
    expect(storedChapterFact({ subject: "Maya", fact: "a freelance illustrator" })).toEqual({ subject: "Maya", attribute: "", value: "a freelance illustrator" });
    expect(storedChapterFact({ subject: "Maya" })).toBeUndefined();
    expect(storedChapterFact("Maya")).toBeUndefined();
  });
});

function chapterOptions(textModel: TextModelAdapter, establishedFacts?: ChapterFact[]): ComposeChapterOptions & ChapterEditAcceptanceOptions {
  const plan = makeFallbackPlan(input);
  const chapter = plan.chapters[1] ?? plan.chapters[0]!;
  const composition = fallbackChapterComposition({ chapter, startPage: 5, endPage: 8 }, formPaletteFor("narrative"), 1);
  return {
    input,
    plan,
    stance: { thesis: "A thesis.", positions: ["A position."], refusals: [], voiceSample: "A voice sample." },
    chapter,
    composition,
    chapterPageStart: 5,
    chapterPageEnd: 8,
    earlierChapters: [],
    continuityNotes: [],
    researchNotes: [],
    textModel,
    semanticAcceptance: false,
    ...(establishedFacts ? { establishedFacts } : {})
  };
}

function recordingText(): { model: TextModelAdapter; seen: GenerateTextOptions[] } {
  const fake = new FakeTextModelAdapter(input);
  const seen: GenerateTextOptions[] = [];
  const model = {
    ...fake,
    generateJson: fake.generateJson.bind(fake),
    generateText: (options: GenerateTextOptions) => {
      seen.push(options);
      return fake.generateText(options);
    }
  } as unknown as TextModelAdapter;
  return { model, seen };
}

describe("the ledger in the writer's and the editor's prompts", () => {
  it("reaches the compose call as establishedFacts with the consistency rule, and leaves a first chapter's prompt as it was", async () => {
    const withLedger = recordingText();
    await composeChapter(chapterOptions(withLedger.model, ledger));
    const system = withLedger.seen[0]!.messages[0]!.content;
    const payload = JSON.parse(withLedger.seen[0]!.messages[1]!.content);
    expect(system).toContain(ESTABLISHED_FACTS_WRITER_RULE);
    expect(ESTABLISHED_FACTS_WRITER_RULE).toContain("never quoted, read out, described or discovered again");
    expect(payload.establishedFacts).toContain("Queen Maelin — relation: mother of Avar; pronoun: she.");

    const without = recordingText();
    await composeChapter(chapterOptions(without.model, []));
    const bare = recordingText();
    await composeChapter(chapterOptions(bare.model));
    expect(without.seen[0]!.messages).toEqual(bare.seen[0]!.messages);
    expect(bare.seen[0]!.messages[0]!.content).not.toContain("establishedFacts");
    expect(JSON.parse(bare.seen[0]!.messages[1]!.content)).not.toHaveProperty("establishedFacts");
  });

  it("reaches the line edit with the rule that lets it correct a contradiction and forbids restating", async () => {
    const recording = recordingText();
    await editChapter({ ...chapterOptions(recording.model, ledger), markdown: "Avar sent Maelin, his sister, to the aerie.\n\nThe clerk Ors Tal signed it." });
    const system = recording.seen[0]!.messages[0]!.content;
    const payload = JSON.parse(recording.seen[0]!.messages[1]!.content);
    expect(system).toContain(ESTABLISHED_FACTS_EDITOR_RULE);
    expect(payload.establishedFacts).toEqual(chapterFactLines(ledger));
  });

  it("is shown to the acceptance reviewer, whose rule then counts a continuity correction as preserved meaning", async () => {
    const seen: GenerateJsonOptions<unknown>[] = [];
    const reviewer = jsonModel({ meaning: "pass", intent: "pass", meaningReason: "r", intentReason: "r" }, seen);
    const base = { ...chapterOptions(reviewer, ledger), semanticAcceptance: true, markdown: "Avar sent Maelin, his sister, to the aerie." };
    expect(await acceptsChapterEdit(base, "Avar sent Maelin, his mother, to the aerie.")).toBe(true);
    expect(seen[0]!.messages[0]!.content).toContain(ESTABLISHED_FACTS_ACCEPTANCE_RULE);
    expect(JSON.parse(seen[0]!.messages[1]!.content).establishedFacts).toContain("Queen Maelin — relation: mother of Avar; pronoun: she.");

    await acceptsChapterEdit({ ...base, establishedFacts: [] }, "Avar sent Maelin, his mother, to the aerie.");
    expect(seen[1]!.messages[0]!.content).not.toContain(ESTABLISHED_FACTS_ACCEPTANCE_RULE);
    expect(JSON.parse(seen[1]!.messages[1]!.content)).not.toHaveProperty("establishedFacts");
  });
});
