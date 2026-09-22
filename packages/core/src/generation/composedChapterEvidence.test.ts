import { describe, expect, it, vi } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { createProjectSchema } from "../schemas/book.js";
import { composeChapter } from "./composedChapter.js";
import { materialLines, materialEditLines } from "./composedChapterMaterial.js";

describe("nonfiction composition without source passages", () => {
  it("keeps source-support rules out of fictional material and edits", () => {
    for (const lines of [materialLines, materialEditLines]) {
      const material = { episodes: [], excerpts: [] };
      expect(lines({ material, nonfiction: false }).join(" ")).not.toContain("Never fill evidence gaps");
      expect(lines({ material, nonfiction: true }).join(" ")).toContain("Never fill evidence gaps");
    }
  });
  it.each(["creative", "grounded"] as const)("does not turn a proposed episode or portrait into evidence under the %s contract", async (contract) => {
    const input = createProjectSchema.parse({ prompt: "Explain public-key cryptography without invented anecdotes.", category: "SCIENCE", targetPages: 20, complexity: 7, language: "en" });
    const plan = makeFallbackPlan(input);
    const chapter = plan.chapters[0]!;
    const textModel = new FakeTextModelAdapter(input);
    const calls = vi.spyOn(textModel, "generateText");
    await composeChapter({ input, plan, chapter,
      stance: { thesis: "Explain the mathematics.", positions: [], refusals: [], voiceSample: "Clear prose." },
      composition: { chapterIndex: chapter.index, throughLine: "RSA", sections: [{ form: "portrait", subject: "The RSA discovery", share: 1, owns: [], note: "Reconstruct the room." }], landing: "RSA", avoid: [] },
      chapterPageStart: 1, chapterPageEnd: 4, earlierChapters: [], continuityNotes: [], researchNotes: [], contract,
      material: { episodes: [{ kind: "scene", title: "A guessed discovery scene", person: "Rivest", place: "Cambridge", date: "1977", document: "A proposed source", why: "Explain RSA", searchQueries: [] }], excerpts: [] }, textModel
    });
    const messages = calls.mock.calls[0]![0].messages;
    const system = String(messages[0]!.content);
    const payload = JSON.parse(String(messages[1]!.content));
    expect(system).not.toContain("reconstructed from what the record makes likely");
    expect(system).not.toContain("draw on your own knowledge for the people");
    expect(system).toContain("No actual source passages");
    expect(payload.episodes).toEqual([]);
    expect(payload.composition.sections[0]).toMatchObject({ form: "argument", subject: "The RSA discovery" });
    expect(JSON.stringify(payload)).not.toContain("Reconstruct the room.");
  });
});
