import { describe, expect, it } from "vitest";
import {
  FakeTextModelAdapter,
  bookSeriesFromMediaSettings,
  type BookSeriesSnapshot,
  type CreateProjectInput,
  type GenerateJsonOptions,
  type JsonResult,
  type TextModelAdapter
} from "@book-maker/core";

import { StopRequestedError } from "../runtime/jobTypes.js";
import { newlyTakenSeriesEndingFacts, withSeriesEndingFacts } from "./seriesEndingFacts.js";

const baseInput: CreateProjectInput = {
  prompt: "The second book about Luna the fox and the lantern bridge.",
  category: "STORY",
  targetPages: 40,
  complexity: 5,
  temperature: 0.7,
  language: "en",
  mediaSettings: { fullIllustrations: false, illustrationCadence: "manual", includeCover: true, coverTemplate: "auto", toneProfile: "neutral" }
};

function series(overrides: Partial<BookSeriesSnapshot> = {}): BookSeriesSnapshot {
  return {
    version: 1,
    mode: "continuation",
    sourceProjectId: "book-1",
    sourceTitle: "The Night Garden",
    seriesName: "The Night Garden",
    bookNumber: 2,
    premise: "Luna finds the lantern bridge.",
    synopsis: ["Lost: Luna wanders off.", "Home: Bram lights the bridge."],
    characters: [],
    locations: [],
    continuityRules: [],
    voiceGuide: [],
    facts: [{ subject: "Luna", attribute: "home", value: "the den under the oak" }],
    ending: "Luna ran home across the bridge.",
    finalChapter: "Bram gave Luna the lantern, and she carried it home across the bridge.",
    ...overrides
  };
}

function inputWith(snapshot: BookSeriesSnapshot): CreateProjectInput {
  return { ...baseInput, mediaSettings: { ...baseInput.mediaSettings, mobile: JSON.parse(JSON.stringify({ series: snapshot })) } };
}

function throwingModel(error: Error): TextModelAdapter {
  const fake = new FakeTextModelAdapter(baseInput);
  return {
    ...fake,
    generateJson: async <T>(_options: GenerateJsonOptions<T>): Promise<JsonResult<T>> => {
      throw error;
    }
  } as unknown as TextModelAdapter;
}

describe("withSeriesEndingFacts", () => {
  it("reads the earlier book's last chapter once and drops the text it read", async () => {
    const input = inputWith(series());
    const enriched = await withSeriesEndingFacts(input, new FakeTextModelAdapter(input), "project-2");

    const after = bookSeriesFromMediaSettings(enriched.mediaSettings)!;
    expect(after.endingFactsTaken).toBe(true);
    expect(after.finalChapter).toBeUndefined();
    expect(after.facts.length).toBeGreaterThan(1);
    expect(after.facts[0]).toEqual({ subject: "Luna", attribute: "home", value: "the den under the oak" });
  });

  it("leaves a book alone when there is nothing to read", async () => {
    for (const input of [
      baseInput,
      inputWith(series({ mode: "inspired" })),
      inputWith(series({ endingFactsTaken: true })),
      inputWith(series({ finalChapter: undefined }))
    ]) {
      expect(await withSeriesEndingFacts(input, throwingModel(new Error("must not be called")), "project-2")).toBe(input);
    }
  });

  it("plans from the facts it has when the read fails", async () => {
    const input = inputWith(series());
    expect(await withSeriesEndingFacts(input, throwingModel(new Error("provider down")), "project-2")).toBe(input);
  });

  it("names the record to write back only when this job took the ending's facts", async () => {
    const input = inputWith(series());
    const enriched = await withSeriesEndingFacts(input, new FakeTextModelAdapter(input), "project-2");

    expect(newlyTakenSeriesEndingFacts(input, enriched)?.endingFactsTaken).toBe(true);
    // A redelivery whose snapshot already carries them has nothing new for the row.
    expect(newlyTakenSeriesEndingFacts(enriched, enriched)).toBeUndefined();
    expect(newlyTakenSeriesEndingFacts(baseInput, baseInput)).toBeUndefined();
  });

  it("lets a stop travel", async () => {
    const input = inputWith(series());
    await expect(withSeriesEndingFacts(input, throwingModel(new StopRequestedError()), "project-2")).rejects.toBeInstanceOf(StopRequestedError);
  });
});
