import { expect, it } from "vitest";
import { bookPlanSchema, createProjectSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { preparePictureBookRequirementContract, pictureBookRequirementContract } from "./pictureBookRequirementContract.js";
import { reviewManuscriptCoverage } from "./manuscriptCoverage.js";
import { generateWholeBookPageMap } from "./pagesPageMap.js";
import { generateWholeBookDraft } from "./pages.js";
import { revisePlanningPackage } from "./planner.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

const brief = "Make each page a distinct scene with concise prose, natural dialogue and sensory details.";
const input = createProjectSchema.parse({ prompt: brief, category: "KIDS", targetPages: 30, mediaSettings: { finalReview: true } });
const requirement = { text: "Natural dialogue", kind: "content", quote: "natural dialogue",
  scope: { extent: "each_page", quote: brief } };
const prose = '"Hold the lantern," Rabbit said. Turtle steadied its warm handle.';

it.each(["fast", "balanced", "premium"])("carries the saved scope through the %s map, writer and coverage with one inventory call", async modelTier => {
  const tierInput = createProjectSchema.parse({ ...input, mediaSettings: { ...input.mediaSettings, modelTier } });
  const fixture = scriptedDevelopmentModel([
    { complete: true, requirements: [requirement] },
    { pages: Array.from({ length: 30 }, (_, i) => ({ pageIndex: i + 1, purpose: `Move the search forward on page ${i + 1}.`,
      beat: `Rabbit and Turtle inspect clue ${i + 1} beside the path.`, requiredContinuity: [], endingPressure: "The next bend holds another clue." })) },
    { pages: Array.from({ length: 30 }, (_, i) => ({ index: i + 1, title: `Scene ${i + 1}`, markdown: prose, summary: "Turtle helps Rabbit.", continuityNotes: [] })) },
    { complete: true, requirements: [{ id: "brief-1", status: "fulfilled", reason: "Every scene has dialogue.", evidence: [{ pageIndex: 1, quote: prose }] }] }
  ]);
  const prepared = await preparePictureBookRequirementContract({ input: tierInput, plan: makeFallbackPlan(tierInput), textModel: fixture.model });
  const saved = bookPlanSchema.parse(JSON.parse(JSON.stringify(prepared)));
  expect(await preparePictureBookRequirementContract({ input: tierInput, plan: saved, textModel: fixture.model })).toBe(saved);
  const chapterBriefs = await generateWholeBookPageMap({ input: tierInput, plan: saved, textModel: fixture.model });
  const draft = await generateWholeBookDraft({ input: tierInput, plan: saved, textModel: fixture.model, chapterBriefs, researchNotes: [] });
  const review = await reviewManuscriptCoverage({ brief, promises: [], pages: draft.pages, inventory: saved.requirementInventory, textModel: fixture.model });
  expect(review.status).toBe("reviewed");
  expect(fixture.calls.map(call => call.purpose)).toEqual(["inventory-brief-requirements", "generate-chapter-brief", "generate-whole-book", "read-manuscript"]);
  for (const call of fixture.calls.slice(1, 3)) {
    expect(JSON.parse(call.messages.at(-1)!.content).requirementContract.requirements).toEqual([{ quote: requirement.quote, scope: requirement.scope }]);
  }
  expect(JSON.parse(fixture.calls[3]!.messages.at(-1)!.content).requirements[0].scope).toEqual(requirement.scope);
});

it("invalidates a changed brief and does not let a revision model overwrite a saved inventory", async () => {
  const fixture = scriptedDevelopmentModel([{ complete: true, requirements: [requirement] },
    { complete: true, requirements: [{ ...requirement, scope: { extent: "whole_book", quote: "Use natural dialogue." } }] }]);
  const prepared = await preparePictureBookRequirementContract({ input, plan: makeFallbackPlan(input), textModel: fixture.model });
  const changed = { ...input, prompt: "Use natural dialogue." };
  expect(pictureBookRequirementContract(changed, prepared)).toEqual({ pageCountPolicy: { requestedPages: 30, minimumPages: 30, maximumPages: 33 } });
  const revisionModel = scriptedDevelopmentModel([{ ...prepared, requirementInventory: { ...prepared.requirementInventory, brief: "invented" } }]);
  const revised = await revisePlanningPackage({ currentPlan: prepared, input, userMessage: "Change the title.", textModel: revisionModel.model });
  expect(revised.requirementInventory).toEqual(prepared.requirementInventory);
  const next = await preparePictureBookRequirementContract({ input: changed, plan: prepared, textModel: fixture.model });
  expect(next.requirementInventory?.brief).toBe(changed.prompt);
  expect(next.requirementInventory?.requirements[0]?.scope?.extent).toBe("whole_book");
});

it("persists an unavailable attempt without buying another interpretation on resume or coverage", async () => {
  const fixture = scriptedDevelopmentModel([new Error("provider unavailable")]);
  const prepared = await preparePictureBookRequirementContract({ input, plan: makeFallbackPlan(input), textModel: fixture.model });
  expect(prepared.requirementInventory?.status).toBe("unavailable");
  expect(await preparePictureBookRequirementContract({ input, plan: prepared, textModel: fixture.model })).toBe(prepared);
  const review = await reviewManuscriptCoverage({ brief, promises: [], pages: [], inventory: prepared.requirementInventory, textModel: fixture.model });
  expect(review.status).toBe("unavailable");
  expect(fixture.calls).toHaveLength(1);
});
