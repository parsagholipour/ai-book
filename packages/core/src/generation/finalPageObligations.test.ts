import { expect, it } from "vitest";
import { createProjectSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { compactPictureBookPlanMessages } from "./compactPictureBookPlanning.js";
import { preparePictureBookRequirementContract } from "./pictureBookRequirementContract.js";
import { generateWholeBookPageMap } from "./pagesPageMap.js";
import { generateWholeBookDraft } from "./pages.js";
import { reviewPictureBookManuscript } from "./pictureBookReview.js";
import { reviewManuscriptCoverage } from "./manuscriptCoverage.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

// The 30-page audit accepted Quick's closure but rejected Balanced/Premium for
// lacking a page-31 hook under the same each_page scope. These are prompt-contract
// tests at the production call sites; scripted verdicts are not model-quality tests.
const brief = "Write a story with a satisfying ending. Make each page a distinct scene with natural dialogue, sensory details and a reason to turn the page.";
const requirement = { text: "Reason to turn each page", kind: "content", quote: "a reason to turn the page",
  scope: { extent: "each_page", quote: "Make each page a distinct scene with natural dialogue, sensory details and a reason to turn the page." } };
const closure = '"We made it together," said Rabbit. Warm lanterns shone above the picnic.';
const policyClauses = [
  "On the actual final story page, closure satisfies ordinary page-turn guidance",
  "An explicit request for a final-page hook, cliffhanger or unresolved ending takes precedence",
  "This exception changes only page-turn guidance"
];

it.each(["fast", "balanced", "premium"])("uses one ending policy from planning through final coverage in %s", async modelTier => {
  const input = createProjectSchema.parse({ prompt: brief, category: "KIDS", targetPages: 30,
    mediaSettings: { finalReview: true, modelTier } });
  const fixture = scriptedDevelopmentModel([
    { complete: true, requirements: [requirement] },
    { pages: Array.from({ length: 30 }, (_, i) => ({ pageIndex: i + 1, purpose: `Scene ${i + 1} changes the search.`,
      beat: i === 29 ? "The friends share the picnic beneath the recovered lanterns." : "The friends follow another clue along the path.",
      requiredContinuity: [], endingPressure: i === 29 ? "The friends enjoy their earned rest." : "The next clue leads them onward." })) },
    { pages: Array.from({ length: 30 }, (_, i) => ({ index: i + 1, title: `Scene ${i + 1}`, markdown: i === 29 ? closure : '"Look!" Rabbit followed a muddy trail toward the next bend.', summary: "The friends cooperate.", continuityNotes: [] })) },
    { findings: [], pages: Array.from({ length: 30 }, (_, i) => ({ pageIndex: i + 1, score: 95,
      requirementChecks: [{ requirementIndex: 0, evidence: i === 29 ? closure : "toward the next bend" }] })) },
    { complete: true, requirements: [{ id: "brief-1", status: "fulfilled", reason: "Scene action carries earlier turns; the final page provides earned closure.",
      evidence: [{ pageIndex: 30, quote: closure }] }] }
  ]);
  const plan = await preparePictureBookRequirementContract({ input, plan: makeFallbackPlan(input), textModel: fixture.model });
  const chapterBriefs = await generateWholeBookPageMap({ input, plan, textModel: fixture.model });
  const draft = await generateWholeBookDraft({ input, plan, chapterBriefs, researchNotes: [], textModel: fixture.model });
  await reviewPictureBookManuscript({ input, plan, chapterBriefs, pages: draft.pages, textModel: fixture.model,
    continuityReview: false, checks: { pageModelReview: true, storyExtractAudit: false, styleAuditor: false } });
  const coverage = await reviewManuscriptCoverage({ brief, promises: [], pages: draft.pages, inventory: plan.requirementInventory, textModel: fixture.model });
  expect(coverage.requirements[0]?.status).toBe("fulfilled");
  expect(fixture.calls).toHaveLength(5);
  const systems = [compactPictureBookPlanMessages(input, true)[0]!.content,
    ...fixture.calls.map(call => call.messages.find(message => message.role === "system")!.content)];
  for (const system of systems) {
    for (const clause of policyClauses) expect(system).toContain(clause);
    expect(system).not.toContain("the last page must not demand a new scene");
  }
  // Preserve the source scope; the ending convention is not a whole-book waiver.
  expect(plan.requirementInventory?.requirements[0]?.scope).toEqual(requirement.scope);
});

it.each([
  ["End the final page with a cliffhanger.", "The ending closes without the explicitly requested cliffhanger."],
  ["Put natural dialogue on every page.", "The final page has no dialogue."],
  ["Put sensory details on every page.", "The final page has no sensory details."],
  ["Give the story a satisfying ending.", "The central search remains unfinished."],
  ["Give each page a reason to turn the page.", "The penultimate page repeats a solved scene without progression."]
])("keeps a grounded missing obligation enforceable: %s", async (source, reason) => {
  const eachPage = source.includes("every page") || source.includes("each page");
  const extent = eachPage ? "each_page" as const : "whole_book" as const;
  const scope = { extent, quote: source };
  const fixture = scriptedDevelopmentModel([{ complete: true, requirements: [{ id: "brief-1", status: "missing", reason,
    evidence: [], scopeAssessment: { supported: true, authority: "brief", ...scope, explanation: reason } }] }]);
  const review = await reviewManuscriptCoverage({ brief: source, promises: [], pages: [{ index: 30, markdown: closure }], textModel: fixture.model,
    inventory: { brief: source, status: "available", complete: true, requirements: [{ text: source, kind: "content", quote: source, scope }] } });
  expect(review.requirements[0]?.status).toBe("missing");
  expect(review.issues[0]?.code).toBe("MISSING_BRIEF_REQUIREMENT");
});
