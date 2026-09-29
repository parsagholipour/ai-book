import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { reviewManuscriptCoverage, manuscriptCoverageSchema, manuscriptCoverageIssues } from "./manuscriptCoverage.js";
import { groupManuscriptQualityFindings, manuscriptQualityCards } from "./manuscriptQualityFindings.js";
import { pageFindingProvenance } from "./manuscriptQualityProvenance.js";
import { manuscriptRequirementId, pictureBookRequirementTargetSchema } from "./pictureBookRequirementTargets.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import { bindCoverageFindingIdentities, coverageObligationId } from "./manuscriptFindingIdentity.js";
import { reconcileRequirementFindings } from "./manuscriptRequirementConflicts.js";

const brief = "Both Rabbit and Wise Turtle grow through consequential choices.";
const pages = [{ index: 2, markdown: "Wise Turtle calmly waited for Rabbit beside the path." }];
const target = { id: "turtle-finding", requirementId: manuscriptRequirementId(brief, brief), requirementQuote: brief,
  pageIndex: 2, problem: "Turtle has no limitation to overcome.", acceptanceCriteria: "Establish Turtle's limitation and changed choice.",
  evidence: [{ pageIndex: 2, quote: pages[0]!.markdown }] };
const diagnosis = `${target.problem} Evidence on page 2: “${pages[0]!.markdown}” Requested requirement: “${brief}”`;
const inventory = { status: "available" as const, brief, complete: true, requirements: [
  { text: "Rabbit's growth", quote: brief, kind: "content" as const },
  { text: "Wise Turtle's growth", quote: brief, kind: "content" as const }
] };
const verdict = (id: string, extra = {}) => ({ id, status: "missing", reason: `${id} lacks a changed consequential choice.`, evidence: [],
  scopeAssessment: { supported: true, authority: "brief" as const, quote: brief, explanation: "The brief requests consequential growth for both named characters." }, ...extra });

it("counts one Turtle failure across prose, an atomic requirement and the failed part of a compound promise", async () => {
  const fixture = scriptedDevelopmentModel([{ complete: true, requirements: [
    verdict("brief-1"), verdict("brief-2", { findingIds: [target.id] }),
    verdict("promise-1", { sameFailureAs: "brief-2" })
  ] }]);
  const review = await reviewManuscriptCoverage({ brief, pages, inventory, requirementTargets: [target],
    promises: ["Give Rabbit and Turtle distinct, observable growth."], textModel: fixture.model });
  expect(review.requirements).toHaveLength(3); // No spurious shared-clause uncertainty.
  const prose = { code: "WHOLE_BOOK_REVIEW", severity: "warning" as const, source: "model" as const,
    message: diagnosis, guidance: target.acceptanceCriteria, affectedPageIndexes: [2], provenance: pageFindingProvenance(2, diagnosis) };
  expect(groupManuscriptQualityFindings([prose, ...review.issues])).toHaveLength(2); // Rabbit remains independent.
  expect(manuscriptCoverageSchema.parse(review).requirements[1]).toMatchObject({ obligationId: expect.any(String), findingIds: [target.id] });
  expect(fixture.calls).toHaveLength(1); // Identity adjudication shares the existing coverage read.
});

it("makes atomic IDs stable under reordering and distinct for two actors sharing one clause", () => {
  const ids = inventory.requirements.map(r => coverageObligationId(brief, r));
  expect(new Set(ids).size).toBe(2);
  expect([...inventory.requirements].reverse().map(r => coverageObligationId(brief, r))).toEqual([...ids].reverse());
  expect(manuscriptRequirementId(brief, brief, target)).not.toBe(manuscriptRequirementId(brief, brief,
    { problem: "Rabbit has no limitation to overcome.", acceptanceCriteria: "Show Rabbit's growth." }));
});

it.each([
  [{ id: "brief-1", findingIds: [target.id] }, { id: "brief-2", findingIds: [target.id] }],
  [{ id: "brief-2", findingIds: ["invented"] }],
  [{ id: "brief-2", findingIds: [target.id, target.id] }],
  [{ id: "brief-2", findingIds: [target.id] }, { id: "brief-2", findingIds: [target.id] }],
  [{ id: "promise-1", sameFailureAs: ["brief-1", "brief-2"] }],
  [{ id: "promise-1", sameFailureAs: "promise-1" }]
].map(links => ({ links })))("keeps ambiguous or invalid identity links separate: %j", ({ links }) => {
  const requirements = inventory.requirements.map((r, i) => ({ ...r, ...verdict(`brief-${i + 1}`), status: "missing" as const,
    source: "brief" as const, obligationId: coverageObligationId(brief, r) }));
  const bound = bindCoverageFindingIdentities(requirements, links, [target]);
  expect(bound).toEqual(requirements);
});

it("retains both reviewers' evidence when an explicitly linked obligation is disputed", async () => {
  const fixture = scriptedDevelopmentModel([{ complete: true, requirements: [verdict("brief-1"),
    verdict("brief-2", { status: "fulfilled", evidence: target.evidence, findingIds: [target.id] })] }]);
  const review = await reviewManuscriptCoverage({ brief, pages, inventory, requirementTargets: [target], promises: [], textModel: fixture.model });
  expect(review.requirements).toHaveLength(2);
  expect(review.requirements[1]).toMatchObject({ status: "unverified", reason: expect.stringContaining("Reviewers disagree"), evidence: target.evidence });
  const warnings = review.issues.filter(i => i.code === "BRIEF_COVERAGE_UNVERIFIED");
  expect(warnings).toHaveLength(1);
  expect(warnings[0]?.provenance?.relatedFindingIds).toEqual([pageFindingProvenance(2, diagnosis).findingId]);
});

it("replays Quick's captured Turtle diagnosis, QA, requirement and compound promise as one finding", () => {
  const capture = JSON.parse(readFileSync(new URL("./testing/quickFindingIdentities.json", import.meta.url), "utf8"));
  const original = manuscriptCoverageSchema.parse({ status: "reviewed", assessmentComplete: true, requirements: capture.requirements });
  const targets = pictureBookRequirementTargetSchema.array().parse(capture.targets);
  const requirements = original.requirements.map(r => ({ ...r, obligationId: coverageObligationId(capture.brief, r) }));
  const bound = bindCoverageFindingIdentities(requirements, capture.identityAnswers, targets);
  const review = reconcileRequirementFindings({ ...original, requirements: bound }, targets);
  const issues = [...capture.proseIssues, ...manuscriptCoverageIssues(review)];
  expect(issues).toHaveLength(5); // All three prose diagnostics and both coverage observations survive.
  expect(groupManuscriptQualityFindings(issues)).toEqual([expect.objectContaining({ issueIndexes: [0, 1, 2, 3, 4] })]);
  expect(manuscriptQualityCards(issues)[0]?.evidence).toEqual(original.requirements[1]!.evidence.map(e => ({ pageIndex: e.pageIndex, excerpt: e.quote })));
  expect(review.requirements.find(r => r.id === "brief-16")?.status).toBe("fulfilled");
  expect(review.requirements).toHaveLength(3);
});
