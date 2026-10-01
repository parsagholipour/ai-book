import { describe, expect, it, vi } from "vitest";
import type { ChapterComposition, GenerateJsonOptions, TextModelAdapter } from "@book-maker/core";
import { StopRequestedError, type ChapterSetup } from "../runtime/jobTypes.js";
import { chapterFactLedger, earlierChapterContext } from "./composedChapterMemory.js";

type Call = { chapterIndex: number; known: string[] };

/** A fixture extractor: one fact per chapter, naming the chapter it was read from. */
function extractor(options: { delayMs?: (chapterIndex: number) => number; fail?: (chapterIndex: number) => Error | undefined } = {}) {
  const calls: Call[] = [];
  const textModel = {
    generateJson: async (request: GenerateJsonOptions<unknown>) => {
      const payload = JSON.parse(request.messages.find((message) => message.role === "user")!.content) as { chapter: { index: number }; knownFacts: string[] };
      calls.push({ chapterIndex: payload.chapter.index, known: payload.knownFacts });
      await new Promise((resolve) => setTimeout(resolve, options.delayMs?.(payload.chapter.index) ?? 0));
      const failure = options.fail?.(payload.chapter.index);
      if (failure) throw failure;
      const reply = { subjects: [{ name: `Person ${payload.chapter.index}`, kind: "person", facts: [{ attribute: "named in", value: `chapter ${payload.chapter.index}` }] }] };
      return { data: request.schema.parse(reply), text: JSON.stringify(reply), provider: "fixture", model: "fixture" };
    }
  } as unknown as TextModelAdapter;
  return { calls, textModel };
}

function ledgerWith(textModel: TextModelAdapter, overrides: Partial<Parameters<typeof chapterFactLedger>[0]> = {}) {
  const runLog = { append: vi.fn(async () => "") };
  const ledger = chapterFactLedger({ enabled: true, projectId: "p", title: "Book", textModel, lastChapterIndex: 5, runLog, ...overrides });
  return { ledger, runLog };
}

describe("chapterFactLedger", () => {
  it("reads each chapter against the chapters below it, and hands a chapter only the facts of lower chapters", async () => {
    const { calls, textModel } = extractor({ delayMs: (index) => (index === 1 ? 20 : 0) });
    const { ledger, runLog } = ledgerWith(textModel);
    ledger.record(1, "Chapter one.");
    ledger.record(2, "Chapter two.");
    ledger.record(3, "Chapter three.");
    // Chapter 2's compose waits for chapter 1's slower read rather than going without it.
    expect(await ledger.before(2)).toEqual([{ subject: "Person 1", attribute: "named in", value: "chapter 1" }]);
    expect((await ledger.before(4)).map((fact) => fact.subject)).toEqual(["Person 1", "Person 2", "Person 3"]);
    expect(calls.map((call) => call.chapterIndex)).toEqual([1, 2, 3]);
    expect(calls[1]!.known).toEqual(["Person 1 — named in: chapter 1."]);
    expect(calls[2]!.known).toEqual(["Person 1 — named in: chapter 1.", "Person 2 — named in: chapter 2."]);
    expect(await ledger.of(2)).toEqual([{ subject: "Person 2", attribute: "named in", value: "chapter 2" }]);
    expect(runLog.append).toHaveBeenCalledWith("generation.composed_chapters.facts", expect.objectContaining({
      chapterIndex: 1, facts: 1, dropped: { sources: 0, quoted: 0, long: 0, copied: 0 }
    }));
  });

  it("never shows a redone chapter the facts of a chapter a resumed run checkpointed ahead of it", async () => {
    const { calls, textModel } = extractor();
    const { ledger } = ledgerWith(textModel);
    ledger.seed(1, [{ subject: "Mara", attribute: "job", value: "freelance illustrator" }]);
    ledger.seed(2, [{ subject: "Mara", attribute: "monthly essentials", value: "$2,000" }]);
    ledger.seed(4, [{ subject: "Mara", attribute: "monthly essentials", value: "$2,400" }]);
    expect((await ledger.before(3)).map((fact) => fact.value)).toEqual(["freelance illustrator", "$2,000"]);
    ledger.record(3, "The redone chapter three.");
    await ledger.of(3);
    expect(calls[0]!.known).toEqual(["Mara — job: freelance illustrator; monthly essentials: $2,000."]);
    expect((await ledger.before(5)).map((fact) => fact.subject)).toEqual(["Mara", "Mara", "Person 3", "Mara"]);
  });

  it("takes no facts from the last chapter, and none at all with the gate off", async () => {
    const { calls, textModel } = extractor();
    ledgerWith(textModel).ledger.record(5, "The last chapter.");
    const off = ledgerWith(textModel, { enabled: false }).ledger;
    off.record(2, "Chapter two.");
    expect(await off.before(3)).toEqual([]);
    expect(await off.of(2)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("writes a failed read down and composes without it, and lets a stop travel", async () => {
    const { textModel } = extractor({ fail: (index) => (index === 1 ? new Error("gateway 503") : undefined) });
    const { ledger, runLog } = ledgerWith(textModel);
    ledger.record(1, "Chapter one.");
    ledger.record(2, "Chapter two.");
    expect(await ledger.of(1)).toBeUndefined();
    expect((await ledger.before(3)).map((fact) => fact.subject)).toEqual(["Person 2"]);
    expect(runLog.append).toHaveBeenCalledWith("generation.composed_chapters.facts_failed", expect.objectContaining({ chapterIndex: 1, error: "gateway 503" }));

    const stopped = ledgerWith(extractor({ fail: () => new StopRequestedError() }).textModel).ledger;
    stopped.record(1, "Chapter one.");
    await expect(stopped.before(2)).rejects.toBeInstanceOf(StopRequestedError);
  });
});

describe("earlierChapterContext", () => {
  const setup = (index: number): ChapterSetup => ({
    chapter: { index, title: `Chapter ${index}`, summary: `Summary ${index}`, keyBeats: [], targetPages: 2 },
    startPage: index * 2 - 1,
    endPage: index * 2
  });
  const composition = (index: number) => ({ chapterIndex: index, throughLine: "", landing: "", avoid: [], sections: [{ form: "scene", subject: "S", share: 1, owns: [`Case ${index}`] }] }) as unknown as ChapterComposition;
  const setups = [1, 2, 3, 4].map(setup);

  it("tells a chapter about the chapters below it only, whatever else the run holds", () => {
    const memory = {
      setups,
      finalText: new Map([[1, "One ends here."], [2, "Two ends here."], [4, "Four ends here."]]),
      digests: new Map([[1, "Digest one"], [4, "Digest four"]]),
      provisionalDigests: new Map([[2, "Provisional two"]]),
      edges: new Map([[1, { opening: "Open one.", closing: "Close one." }], [4, { opening: "Open four.", closing: "Close four." }]]),
      notes: new Map([[1, ["Note one"]], [2, ["Note two"]], [4, ["Note four"]]]),
      compositionFor: (candidate: ChapterSetup) => composition(candidate.chapter.index)
    };
    const context = earlierChapterContext(setup(3), memory, new Map([[2, "The draft of two ends here."]]));
    expect(context.previousChapterTail).toBe("The draft of two ends here.");
    expect(context.earlierChapters).toEqual([
      { index: 1, title: "Chapter 1", digest: "Digest one", told: ["Case 1"] },
      { index: 2, title: "Chapter 2", digest: "Provisional two", told: ["Case 2"] }
    ]);
    expect(context.earlierOpenings).toEqual(["Open one."]);
    expect(context.earlierClosings).toEqual(["Close one."]);
    expect(context.earlierNotes).toEqual(["Note one", "Note two"]);
    expect(earlierChapterContext(setup(1), memory, new Map())).toEqual({ earlierChapters: [], earlierOpenings: [], earlierClosings: [], earlierNotes: [] });
  });
});
