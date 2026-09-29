import { expect, it } from "vitest";
import { reviewManuscriptCoverage } from "./manuscriptCoverage.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import captured from "./testing/coveragePromiseScope.json" with { type: "json" };

const inventory = { brief: captured.brief, status: "available" as const, complete: true,
  requirements: [{ text: "Storybook", quote: "storybook", kind: "content" as const }] };
const fulfilled = { id: "brief-1", status: "fulfilled", reason: "The manuscript is a story.",
  evidence: [{ pageIndex: captured.pages[0]!.index, quote: captured.pages[0]!.markdown }] };

it("does not turn the captured planner's 'end there' into an unchecked arrival cutoff", async () => {
  const { model, calls } = scriptedDevelopmentModel([{ complete: true, requirements: [fulfilled, captured.verdict] }]);
  const review = await reviewManuscriptCoverage({ ...captured, promises: [captured.promise], textModel: model,
    inventory });
  expect(review.requirements[1]?.status).toBe("unverified");
  expect(review.issues.map(issue => issue.code)).not.toContain("UNPAID_PROMISE");
  expect(calls).toHaveLength(1);
});

it("rejects a scope assessment that acknowledges adding an unsupported condition", async () => {
  const { model } = scriptedDevelopmentModel([{ complete: true, requirements: [fulfilled, { ...captured.verdict,
    scopeAssessment: { supported: false, authority: "promise", quote: "end there", explanation: "There refers to the picnic location, not immediately upon arrival." }
  }] }]);
  const review = await reviewManuscriptCoverage({ ...captured, promises: [captured.promise], textModel: model,
    inventory });
  expect(review.requirements[1]?.status).toBe("unverified");
  expect(review.requirements[1]?.reason).toContain("scope");
});

it.each(["Natural dialogue", "Natural dialogue on each page"])("does not derive a page quota from the label '%s'", async text => {
  const brief = "Tell a woodland story with natural dialogue.";
  const { model } = scriptedDevelopmentModel([{ complete: true, requirements: [{ id: "brief-1", status: "missing",
    reason: "Page 2 has no dialogue.", evidence: [], scopeAssessment: { supported: true, authority: "brief",
      extent: "each_page", quote: brief, explanation: "Require dialogue on each page." } }] }]);
  const review = await reviewManuscriptCoverage({ brief, promises: [], pages: captured.pages, textModel: model,
    inventory: { brief, status: "available", complete: true, requirements: [{ text, quote: "natural dialogue", kind: "content",
      scope: { extent: "whole_book", quote: brief } }] } });
  expect(review.requirements[0]?.status).toBe("unverified");
});

it("preserves a grounded every-page requirement even with a short display label", async () => {
  const brief = "Make each page a distinct scene with concise prose, natural dialogue and sensory details.";
  const scopeAssessment = { supported: true, authority: "brief", extent: "each_page", quote: brief,
    explanation: "Each page governs the coordinated qualities, including dialogue; page 2 has none." };
  const { model } = scriptedDevelopmentModel([{ complete: true, requirements: [{ id: "brief-1", status: "missing",
    reason: "Page 2 has no dialogue.", evidence: [], scopeAssessment }] }]);
  const review = await reviewManuscriptCoverage({ brief, promises: [], pages: captured.pages, textModel: model,
    inventory: { brief, status: "available", complete: true, requirements: [{ text: "Natural dialogue", quote: "natural dialogue", kind: "content",
      scope: { extent: "each_page", quote: brief } }] } });
  expect(review.requirements[0]).toMatchObject({ status: "missing", scopeAssessment });
  expect(review.issues[0]?.code).toBe("MISSING_BRIEF_REQUIREMENT");
});

it("does not turn a contradicted final-coverage absence claim into a repair target", async () => {
  const brief = "Each page must include natural dialogue.";
  const markdown = '“There!” Rabbit called. He pointed to the lantern under the dripping leaves.';
  const { model } = scriptedDevelopmentModel([{ complete: true, requirements: [{ id: "brief-1", status: "missing",
    reason: "Page 19 has no dialogue.", evidence: [{ pageIndex: 19, quote: markdown }], scopeAssessment: {
      supported: true, authority: "brief", extent: "each_page", quote: brief, explanation: "Each page needs dialogue."
    } }] }]);
  const review = await reviewManuscriptCoverage({ brief, promises: [], pages: [{ index: 19, markdown }], textModel: model,
    inventory: { brief, status: "available", complete: true, requirements: [{ text: "Natural dialogue", quote: "natural dialogue", kind: "content",
      scope: { extent: "each_page", quote: brief } }] } });
  expect(review.requirements[0]).toMatchObject({ status: "unverified", reason: expect.stringContaining("counterevidence") });
  expect(review.issues.map(issue => issue.code)).not.toContain("MISSING_BRIEF_REQUIREMENT");
});

it("keeps an explicit arrival cutoff enforceable", async () => {
  const brief = "End the story immediately upon arrival at the picnic.";
  const { model } = scriptedDevelopmentModel([{ complete: true, requirements: [{ ...captured.verdict,
    scopeAssessment: { supported: true, authority: "brief", quote: brief, explanation: "The user explicitly prohibits scenes after arrival." }
  }] }]);
  const review = await reviewManuscriptCoverage({ brief: "", promises: [brief], pages: captured.pages, textModel: model,
    inventory: { brief: "", status: "available", complete: true, requirements: [] } });
  // The claimed authority must be present, not just copied into an assessment.
  expect(review.requirements[0]?.status).toBe("unverified");
  const valid = scriptedDevelopmentModel([{ complete: true, requirements: [{ ...captured.verdict,
    scopeAssessment: { supported: true, authority: "promise", quote: brief, explanation: "The promise explicitly requires the arrival cutoff." }
  }] }]);
  const checked = await reviewManuscriptCoverage({ brief: "", promises: [brief], pages: captured.pages, textModel: valid.model,
    inventory: { brief: "", status: "available", complete: true, requirements: [] } });
  expect(checked.requirements[0]?.status).toBe("missing");
});

it("can fulfill the actual picnic-location promise using manuscript evidence", async () => {
  const { model, calls } = scriptedDevelopmentModel([{ complete: true, requirements: [fulfilled, {
    ...captured.verdict, status: "fulfilled", reason: "The neighbors arrive before moonrise and the ending remains at the picnic."
  }] }]);
  const review = await reviewManuscriptCoverage({ ...captured, promises: [captured.promise], textModel: model, inventory });
  expect(review.requirements[1]?.status).toBe("fulfilled");
  expect(calls).toHaveLength(1);
});
