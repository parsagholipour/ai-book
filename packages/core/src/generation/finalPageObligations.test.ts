import { expect, it } from "vitest";
import { reviewManuscriptCoverage } from "./manuscriptCoverage.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
const closure = '"We made it together," said Rabbit. Warm lanterns shone above the picnic.';

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
