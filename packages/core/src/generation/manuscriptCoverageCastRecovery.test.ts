import { expect, it } from "vitest";
import { AdapterJsonParseError } from "../adapters/json.js";
import { recoverProhibitionEvidence } from "./manuscriptCoverageCastRecovery.js";
import { prohibitionCoverageVerdict, type ProhibitionAssessment } from "./manuscriptCoverageProhibitions.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

const permission = "Use Rabbit as the main character.";
const pages = [
  { index: 1, markdown: "Rabbit watched the path." },
  { index: 2, markdown: "Rabbit raised his lantern. He led the rescue." },
  { index: 3, markdown: "The woodland was quiet." },
  { index: 4, markdown: "Rabbit waited by the gate." },
  { index: 5, markdown: "Rabbit went home." }
];
const assessment: ProhibitionAssessment = { scope: "whole_manuscript", complete: true, checkedPageIndexes: [1, 2, 3, 4, 5],
  entities: [{ name: "Rabbit", aliases: [], role: "main_character", reason: "Leads the rescue.",
    evidence: [{ pageIndex: 2, quote: "He led the rescue." }], permissionQuote: permission }], counterexamples: [] };
const requirement = { id: "brief-1", kind: "prohibition", prohibitionScope: "named_main_characters" };
const answer = { id: requirement.id, status: "fulfilled", prohibitionAssessment: assessment };
const base = { brief: `${permission} Avoid extra named main characters.`, pages, assessmentComplete: true,
  expectedPageIndexes: [1, 2, 3, 4, 5], knownCharacterNames: ["Rabbit"], requirements: [requirement], verdicts: [answer] };
const correction = { id: "brief-1:entity-1", supportsSameEntityAndRole: true,
  namingEvidence: { pageIndex: 2, quote: "Rabbit raised his lantern." } };

it("recovers one exact anchor with bounded relevant prose while preserving the cast assessment and input", async () => {
  const { model, calls } = scriptedDevelopmentModel([{ corrections: [correction] }]);
  const original = structuredClone(base);
  const result = await recoverProhibitionEvidence({ ...base, textModel: model,
    pages: pages.map(page => ({ ...page, qualityReport: { notes: "x".repeat(30_000) } })) });
  expect(result).toEqual([{ ...answer, prohibitionAssessment: { ...assessment,
    entities: [{ ...assessment.entities[0], namingEvidence: correction.namingEvidence }] } }]);
  expect(base).toEqual(original);
  expect(prohibitionCoverageVerdict({ ...base, requirement, answer: result[0] })?.status).toBe("fulfilled");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.maxTokens).toBe(2500);
  expect(calls[0]?.textAttemptBudget).toEqual({ limit: 1, used: 0, outputWidened: true });
  const payload = JSON.parse(calls[0]!.messages[1]!.content);
  expect(payload.pages).toEqual([pages[0], pages[1], pages[3]]);
  expect(payload.entities[0].candidatePageIndexes).toEqual([2, 1, 4]);
});

it("uses a legacy named witness alongside pronoun actions without an extra call", async () => {
  const audit = structuredClone(assessment);
  audit.entities[0]!.evidence.push(correction.namingEvidence);
  const verdicts = [{ ...answer, prohibitionAssessment: audit }];
  const { model, calls } = scriptedDevelopmentModel([]);
  expect(await recoverProhibitionEvidence({ ...base, verdicts, textModel: model })).toEqual(verdicts);
  expect(prohibitionCoverageVerdict({ ...base, requirement, answer: verdicts[0] })?.status).toBe("fulfilled");
  expect(calls).toHaveLength(0);
});

it.each([
  { label: "refused", corrections: [{ ...correction, supportsSameEntityAndRole: false }] },
  { label: "null", corrections: [{ ...correction, namingEvidence: null }] },
  { label: "fabricated", corrections: [{ ...correction, namingEvidence: { pageIndex: 2, quote: "Rabbit invented this." } }] },
  { label: "wrong page", corrections: [{ ...correction, namingEvidence: { pageIndex: 1, quote: correction.namingEvidence.quote } }] },
  { label: "outside candidates", corrections: [{ ...correction, namingEvidence: { pageIndex: 5, quote: pages[4]!.markdown } }] },
  { label: "no identity", corrections: [{ ...correction, namingEvidence: { pageIndex: 2, quote: "He led the rescue." } }] },
  { label: "wrong identity", corrections: [{ ...correction, namingEvidence: { pageIndex: 2, quote: "lantern" } }] },
  { label: "unknown id", corrections: [{ ...correction, id: "other-entity" }] },
  { label: "duplicate id", corrections: [correction, correction] },
  { label: "omitted", corrections: [] },
  { label: "role change", corrections: [{ ...correction, role: "place" }] }
])("leaves cast evidence unverified when recovery is $label", async ({ corrections }) => {
  const { model, calls } = scriptedDevelopmentModel([{ corrections }]);
  const result = await recoverProhibitionEvidence({ ...base, textModel: model });
  expect(result).toEqual(base.verdicts);
  expect(prohibitionCoverageVerdict({ ...base, requirement, answer: result[0] })?.status).toBe("unverified");
  expect(calls).toHaveLength(1);
});

it.each<{ label: string; change: (audit: ProhibitionAssessment) => void }>([
  { label: "incomplete scope", change: audit => { audit.complete = false; } },
  { label: "partial pages", change: audit => { audit.checkedPageIndexes.pop(); } },
  { label: "duplicate pages", change: audit => { audit.checkedPageIndexes[4] = 1; } },
  { label: "uncertain role", change: audit => { audit.entities[0]!.role = "uncertain"; } },
  { label: "forged permission", change: audit => { audit.entities[0]!.permissionQuote = "Rabbit is approved."; } },
  { label: "extra protagonist", change: audit => { audit.entities[0]!.permissionQuote = null; } },
  { label: "forged role quote", change: audit => { audit.entities[0]!.evidence[0]!.quote = "He flew to the moon."; } },
  { label: "duplicate alias", change: audit => { audit.entities[0]!.aliases = ["Rabbit"]; } },
  { label: "absent alias", change: audit => { audit.entities[0]!.aliases = ["Bunny"]; } },
  { label: "absent identity", change: audit => { audit.entities[0]!.name = "Fox"; } },
  { label: "conflicting counterexample", change: audit => { audit.counterexamples = [correction.namingEvidence]; } }
])("does not spend a recovery call when the assessment also has $label", async ({ change }) => {
  const audit = structuredClone(assessment); change(audit);
  const verdicts = [{ ...answer, prohibitionAssessment: audit }];
  const { model, calls } = scriptedDevelopmentModel([]);
  expect(await recoverProhibitionEvidence({ ...base, verdicts, textModel: model })).toEqual(verdicts);
  expect(calls).toHaveLength(0);
});

it.each([
  { assessmentComplete: false }, { expectedPageIndexes: [1, 2, 3, 4, 5, 6] },
  { pages: [pages[0]!, pages[0]!] }, { pages: [] },
  { verdicts: [answer, answer] }, { verdicts: [{ ...answer, status: "unverified" }] },
  { verdicts: [{ ...answer, status: "missing" }] }, { verdicts: [{ ...answer, id: "unknown" }] },
  { verdicts: [{ ...answer, prohibitionAssessment: {} }] }, { requirements: [{ ...requirement, kind: "content" }] }
])("skips incomplete or ineligible input %#", async change => {
  const { model, calls } = scriptedDevelopmentModel([]);
  const options = { ...base, ...change, textModel: model };
  expect(await recoverProhibitionEvidence(options)).toEqual(options.verdicts);
  expect(calls).toHaveLength(0);
});

it("does not let an invalid explicit anchor silently fall back to a valid legacy witness", () => {
  const audit = structuredClone(assessment);
  audit.entities[0]!.evidence.push(correction.namingEvidence);
  audit.entities[0]!.namingEvidence = { pageIndex: 2, quote: "Rabbit flew." };
  expect(prohibitionCoverageVerdict({ ...base, requirement, answer: { ...answer, prohibitionAssessment: audit } })?.status).toBe("unverified");
});

it("caps both recovery input size and entity count without truncating source pages", async () => {
  const audit = structuredClone(assessment);
  audit.checkedPageIndexes = [1];
  audit.entities = Array.from({ length: 9 }, (_, i) => ({ name: `Light ${i}`, aliases: [], role: "object", reason: "A lantern.",
    evidence: [{ pageIndex: 1, quote: "They glowed." }], permissionQuote: null }));
  const { model, calls } = scriptedDevelopmentModel([]);
  const oversized = { ...base, pages: pages.map(page => ({ ...page, markdown: `${page.markdown} ${"x".repeat(24_001)}` })) };
  expect(await recoverProhibitionEvidence({ ...oversized, textModel: model })).toEqual(base.verdicts);
  const verdicts = [{ ...answer, prohibitionAssessment: audit }];
  expect(await recoverProhibitionEvidence({ ...base, verdicts, expectedPageIndexes: [1], textModel: model,
    pages: [{ index: 1, markdown: `${audit.entities.map(e => e.name).join(", ")}. They glowed.` }] })).toEqual(verdicts);
  expect(calls).toHaveLength(0);
});

it.each([new Error("provider unavailable"), new AdapterJsonParseError("Test", "bad JSON", 1, "{", "{"),
  new Error("output budget exhausted: max_output_tokens"), { corrections: "invalid schema" }])("fails conservatively after one attempt", async response => {
  const { model, calls } = scriptedDevelopmentModel([response]);
  expect(await recoverProhibitionEvidence({ ...base, textModel: model })).toEqual(base.verdicts);
  expect(calls).toHaveLength(1);
});

it.each(["AbortError", "StopRequestedError"])("propagates %s instead of hiding cancellation", async name => {
  const error = Object.assign(new Error("Stopped"), { name });
  const { model } = scriptedDevelopmentModel([error]);
  await expect(recoverProhibitionEvidence({ ...base, textModel: model })).rejects.toBe(error);
});
