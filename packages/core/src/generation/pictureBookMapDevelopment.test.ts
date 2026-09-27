import { describe, expect, it } from "vitest";
import { bookPlanSchema, chapterBriefSchema, createProjectSchema } from "../schemas/book.js";
import { critiquePageMap, mergePageMapCriticPatch } from "./pageMapCritic.js";
import { generateWholeBookDraft } from "./pages.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import lanternMaps from "./testing/lanternStoryMaps.json" with { type: "json" };

function captured(tier: keyof typeof lanternMaps = "fast") {
  const fixture = lanternMaps[tier];
  return { input: createProjectSchema.parse(fixture.input), plan: bookPlanSchema.parse(fixture.plan),
    briefs: fixture.briefs.map(brief => chapterBriefSchema.parse(brief)) };
}
function clean() {
  return { sceneRevisions: [], flowAudit: { stateDependencies: [], setupPayoffs: [], sceneProgression: [] } };
}
function correction(book = captured()) {
  return { flowAudit: { ...clean().flowAudit, sceneProgression: [{ pageIndexes: [18, 20], assessment: "Another post check repeats a solved task; replace it with the neighbors choosing pairs.", repairPageIndexes: [20], changes: [18, 20].map(pageIndex => ({ pageIndex, actionQuote: book.briefs.flatMap(b => b.pages).find(p => p.pageIndex === pageIndex)!.beat.slice(0, 120), change: "Another check of an already solved task." })) }] }, sceneRevisions: [{ pageIndex: 20, reason: "Replace another post check with a choice that lets the neighbors act.",
    relatedPageIndexes: [18, 20],
    purpose: "Neighbors choose a way to stay together",
    beat: "Rabbit listens to the smallest neighbor, then asks everyone to pair up before they follow Turtle through the wet trees.",
    requiredContinuity: ["All six lanterns remain lit at their posts; everyone sets out from the gate in pairs."],
    endingPressure: "The pairs must find secure footing at the creek.", imageMoment: null }] };
}

describe("picture-book development inside the existing map critique", () => {
  it.each(["fast", "balanced", "premium"] as const)("gives %s critique the brief, canon and state instead of only beat labels", async tier => {
    const book = captured(tier);
    const fixture = scriptedDevelopmentModel([clean()]);
    await critiquePageMap({ ...book, promises: book.plan.promises, textModel: fixture.model });
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]!.purpose).toBe("critique-page-map");
    const payload = JSON.parse(fixture.calls[0]!.messages.at(-1)!.content);
    expect(payload.brief).toBe(book.input.prompt);
    expect(payload.characters).toEqual(book.plan.characters);
    expect(payload.continuityRules).toEqual(book.plan.continuityRules);
    expect(payload.pages.map((p: { requiredContinuity: string[] }) => p.requiredContinuity))
      .toEqual(book.briefs.flatMap(b => b.pages.map(p => p.requiredContinuity)));
  });

  it("publishes a corrected scene through the real merge and drafting prompt without the old outline or prop instruction", async () => {
    const book = captured();
    book.briefs = book.briefs.map(b => ({ ...b, pages: b.pages.map(p => p.pageIndex === 20
      ? { ...p, imageMoment: "Rabbit lights the lanterns again while running between every post." } : p) }));
    const original = structuredClone(book.briefs);
    const fixture = scriptedDevelopmentModel([correction()]);
    const patch = await critiquePageMap({ ...book, promises: book.plan.promises, textModel: fixture.model });
    const revised = mergePageMapCriticPatch(book.briefs, patch, book.input.targetPages);
    const page = revised.flatMap(b => b.pages).find(p => p.pageIndex === 20)!;
    expect(page.beat).toBe(correction().sceneRevisions[0]!.beat);
    expect(page.requiredContinuity).toEqual(correction().sceneRevisions[0]!.requiredContinuity);
    expect(page).not.toHaveProperty("imageMoment");
    expect(revised.flatMap(b => b.pages).filter(p => p.pageIndex !== 20))
      .toEqual(original.flatMap(b => b.pages).filter(p => p.pageIndex !== 20));
    expect(book.briefs).toEqual(original);
    const draft = scriptedDevelopmentModel([{ pages: original.flatMap(b => b.pages).map(p => ({
      index: p.pageIndex, title: `Scene ${p.pageIndex}`, markdown: "Rabbit listens, then walks beside the neighbors.",
      summary: "The group walks together.", continuityNotes: []
    })) }]);
    await generateWholeBookDraft({ input: book.input, plan: book.plan, chapterBriefs: revised, researchNotes: [], textModel: draft.model });
    const payload = JSON.parse(draft.calls[0]!.messages.at(-1)!.content);
    expect(payload.pageMap.find((p: { pageIndex: number }) => p.pageIndex === 20).beat).toBe(page.beat);
    expect(payload.chapters.every((c: Record<string, unknown>) => !("summary" in c) && !("keyBeats" in c))).toBe(true);
    expect(payload.chapters.map((c: { index: number; title: string }) => [c.index, c.title]))
      .toEqual(book.plan.chapters.map(c => [c.index, c.title]));
    expect(fixture.calls).toHaveLength(1);
    expect(draft.calls).toHaveLength(1);
  });

  it.each(["unknown page", "duplicate page", "unknown related page", "partial rewrite", "warning only", "unrequested image", "no change"])(
    "rejects %s without treating it as a clean critique", async defect => {
      const book = captured();
      const response = correction();
      const row = response.sceneRevisions[0]!;
      if (defect === "unknown page") row.pageIndex = 31;
      if (defect === "duplicate page") response.sceneRevisions.push(structuredClone(row));
      if (defect === "unknown related page") row.relatedPageIndexes = [99];
      if (defect === "partial rewrite") Reflect.deleteProperty(row, "requiredContinuity");
      if (defect === "warning only") Reflect.deleteProperty(response, "sceneRevisions");
      if (defect === "unrequested image") Reflect.set(row, "imageMoment", "Draw Rabbit beside Turtle.");
      if (defect === "no change") {
        const page = book.briefs.flatMap(b => b.pages).find(p => p.pageIndex === 20)!;
        Object.assign(row, { purpose: page.purpose, beat: page.beat, requiredContinuity: page.requiredContinuity, endingPressure: page.endingPressure });
      }
      const fixture = scriptedDevelopmentModel([response, response]);
      await expect(critiquePageMap({ ...book, promises: book.plan.promises, textModel: fixture.model })).rejects.toThrow();
      expect(fixture.calls.length).toBeLessThanOrEqual(2);
    });

  it("keeps clean assignments unchanged without passing audit commentary into prose", async () => {
    const book = captured("balanced");
    const fixture = scriptedDevelopmentModel([clean()]);
    const patch = await critiquePageMap({ ...book, promises: book.plan.promises, textModel: fixture.model });
    const revised = mergePageMapCriticPatch(book.briefs, patch, 30);
    expect(revised).toEqual(book.briefs);
  });

  it("supports the production mock adapter without a failed optional critique", async () => {
    const book = captured();
    const patch = await critiquePageMap({ ...book, promises: book.plan.promises, textModel: new FakeTextModelAdapter(book.input) });
    expect(mergePageMapCriticPatch(book.briefs, patch, 30)).toEqual(book.briefs);
  });

  it("allows corrected images only in the saved sparse illustration slots", async () => {
    const book = captured();
    book.input.mediaSettings.fullIllustrations = true;
    book.input.mediaSettings.illustrationCadence = "every-third-page";
    const response = correction();
    response.sceneRevisions[0]!.pageIndex = 21;
    response.flowAudit.sceneProgression[0]!.repairPageIndexes = [21];
    response.flowAudit.sceneProgression[0]!.pageIndexes = [18, 21];
    response.flowAudit.sceneProgression[0]!.changes[1] = { pageIndex: 21, actionQuote: book.briefs.flatMap(b => b.pages).find(p => p.pageIndex === 21)!.beat, change: "Another check of an already solved task." };
    Reflect.set(response.sceneRevisions[0]!, "imageMoment", "Rabbit listens to a neighbor as pairs gather beside Turtle.");
    const fixture = scriptedDevelopmentModel([response]);
    const patch = await critiquePageMap({ ...book, promises: book.plan.promises, textModel: fixture.model });
    const page = mergePageMapCriticPatch(book.briefs, patch, 30).flatMap(b => b.pages).find(p => p.pageIndex === 21)!;
    expect(page.imageMoment).toBe(response.sceneRevisions[0]!.imageMoment);
    expect(JSON.parse(fixture.calls[0]!.messages.at(-1)!.content).illustratedPageIndexes)
      .toEqual([3, 6, 9, 12, 15, 18, 21, 24, 27, 30]);
  });

  it("retains the general critic for explicit and imported workflows", async () => {
    const book = captured();
    for (const input of [
      { ...book.input, mediaSettings: { ...book.input.mediaSettings, generationStrategy: "draft-then-polish" as const } },
      { ...book.input, mediaSettings: { ...book.input.mediaSettings, mobile: { import: { source: "manuscript" } } } }
    ]) {
      const fixture = scriptedDevelopmentModel([{ beatPatches: [], duplicatePurposeWarnings: [], missingEndingPressure: [], unscheduledPromises: [] }]);
      const patch = await critiquePageMap({ ...book, input, promises: book.plan.promises, textModel: fixture.model });
      expect(patch.beatPatches).toEqual([]);
      expect(fixture.calls[0]!.maxTokens).toBe(1400);
      const mockPatch = await critiquePageMap({ ...book, input, promises: book.plan.promises, textModel: new FakeTextModelAdapter(input) });
      expect(mockPatch).toEqual(patch);
    }
  });

  it("develops the same full-scene contract below the chunked-map threshold", async () => {
    const book = captured();
    book.input.targetPages = 20;
    book.briefs = book.briefs.map(b => ({ ...b, pages: b.pages.filter(p => p.pageIndex <= 20) })).filter(b => b.pages.length);
    const response = correction();
    response.sceneRevisions[0]!.endingPressure = "The neighbors settle into the picnic before moonrise.";
    const fixture = scriptedDevelopmentModel([response]);
    const patch = await critiquePageMap({ ...book, promises: book.plan.promises, textModel: fixture.model });
    expect(patch.beatPatches[0]!.replaceRequiredContinuity).toBe(true);
    expect(fixture.calls).toHaveLength(1);
  });
});
