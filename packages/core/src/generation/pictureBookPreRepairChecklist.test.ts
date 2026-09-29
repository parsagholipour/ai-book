import { expect, it, vi } from "vitest";
import { createProjectSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { reviewPictureBookManuscript } from "./pictureBookReview.js";
import { pictureBookRequirementTargets } from "./pictureBookRequirementTargets.js";
import { pictureBookChecklistSpans } from "./pictureBookChecklistSpans.js";
import { pictureBookPageRequirements } from "./pictureBookPreRepairChecklist.js";

const brief = "Write a woodland story. Each page must include natural dialogue and concrete sensory details.";
const input = createProjectSchema.parse({ prompt: brief, category: "KIDS", targetPages: 8, language: "en" });
const plan = { ...makeFallbackPlan(input), requirementInventory: { version: 1 as const, complete: true, status: "available" as const,
  brief, requirements: ["natural dialogue", "concrete sensory details"].map(quote => ({ kind: "content" as const, quote, text: quote,
    scope: { extent: "each_page" as const, quote: "Each page must include natural dialogue and concrete sensory details." } })) } };
const pages = [{ index: 16, title: "The Wall", markdown: "Rabbit touched the cold stone wall. Turtle waited beside the lantern.", summary: "They reach the wall." }];
const finding = { domain: "prose", basis: "missing_requirement", category: "brief", repairKind: "semantic",
  requirementQuote: "natural dialogue", quote: pages[0]!.markdown, relatedEvidence: [],
  message: "This scene has no dialogue.", guidance: "Give Rabbit and Turtle natural dialogue within the existing scene." };
function setup(row: object, recovery?: object, manuscript = pages) {
  const textModel = new FakeTextModelAdapter();
  const generate = vi.fn(async request => ({ data: request.schema.parse(recovery && generate.mock.calls.length > 1 ? recovery : { pages: [{ pageIndex: 16, score: 90, findings: [], storyExtract: null, styleAudit: null, ...row }] }),
    text: "fixture", provider: "fixture", model: "fixture" }));
  textModel.generateJson = generate;
  return { generate, run: () => reviewPictureBookManuscript({ input, plan, pages: manuscript, chapterBriefs: [], textModel,
    continuityReview: false, checks: { pageModelReview: true, storyExtractAudit: false, styleAuditor: false } }) };
}
it("refuses a clean pre-repair review which skips the saved per-page obligations", async () => {
  const test = setup({});
  await expect(test.run()).rejects.toThrow();
  expect(test.generate).toHaveBeenCalledTimes(2);
});

it("does not authorize a no-dialogue rewrite when the quoted scene contains spoken dialogue", async () => {
  const markdown = '“Every light is gone,” Rabbit said. He leaned forward, ready to dash into the dripping woods.';
  const test = setup({ findings: [{ ...finding, quote: markdown }], requirementChecks: [
    { requirementIndex: 0, evidence: null }, { requirementIndex: 1, evidence: "the dripping woods" }
  ] }, undefined, [{ ...pages[0]!, markdown }]);
  await expect(test.run()).rejects.toThrow();
});

it("resolves a uniquely wrapped dialogue fragment without another provider call", async () => {
  const markdown = 'Wise Turtle nodded. “Follow the creekside stretch we chose. Call when you find anything.” Rabbit touched the cold stone wall.';
  const test = setup({ requirementChecks: [
    { requirementIndex: 0, evidence: '“Call when you find anything.”' },
    { requirementIndex: 1, evidence: "the cold stone wall" }
  ] }, undefined, [{ ...pages[0]!, markdown }]);
  const reviews = await test.run();
  expect(test.generate).toHaveBeenCalledTimes(1);
  expect(reviews[0]!.requirementChecks?.[0]?.evidence).toBe("Call when you find anything.");
});
it("turns missing dialogue into an actionable repair target in the existing review call", async () => {
  const test = setup({ findings: [finding], requirementChecks: [{ requirementIndex: 0, evidence: null },
    { requirementIndex: 1, evidence: "the cold stone wall" }] });
  const reviews = await test.run();
  expect(test.generate).toHaveBeenCalledTimes(1);
  expect(reviews[0]!.report.approved).toBe(false);
  expect(pictureBookRequirementTargets(brief, pages, reviews)).toMatchObject([{ pageIndex: 16, requirementQuote: "natural dialogue" }]);
});
it.each(["invented_evidence", "missing_finding", "duplicate_check"])("refuses %s in the checklist", async mode => {
  const checklist = [{ requirementIndex: 0, evidence: null as string | null }, { requirementIndex: 1, evidence: "the cold stone wall" }];
  if (mode === "invented_evidence") checklist[0]!.evidence = '“Let us go,” Rabbit said.';
  if (mode === "duplicate_check") checklist[1]!.requirementIndex = 0;
  await expect(setup({ findings: mode === "missing_finding" ? [] : [finding], requirementChecks: checklist }).run()).rejects.toThrow();
});


it("completes a missing checklist without letting recovery erase the known dialogue gap", async () => {
  const test = setup({ findings: [finding] }, { pages: [], auxiliaryCorrections: [{ id: "page:16",
    requirementChecks: [{ requirementIndex: 0, evidence: null }, { requirementIndex: 1, evidence: "the cold stone wall" }] }] });
  const reviews = await test.run();
  expect(test.generate).toHaveBeenCalledTimes(2);
  expect(reviews[0]!.findings).toMatchObject([finding]);
  expect(reviews[0]!.report.approved).toBe(false);
});

it("can add a newly discovered requirement gap while preserving an existing diagnosis", async () => {
  const existing = { ...finding, basis: "page_prose", requirementQuote: null, category: "style",
    message: "The wording is awkward.", guidance: "Smooth the phrasing." };
  const test = setup({ findings: [existing] }, { pages: [], auxiliaryCorrections: [{ id: "page:16",
    requirementChecks: [{ requirementIndex: 0, evidence: null }, { requirementIndex: 1, evidence: "the cold stone wall" }],
    requirementFindings: [finding] }] });
  const reviews = await test.run();
  expect(test.generate).toHaveBeenCalledTimes(2);
  expect(reviews[0]!.findings).toMatchObject([existing, finding]);
  expect(pictureBookRequirementTargets(brief, pages, reviews)).toMatchObject([{ pageIndex: 16, requirementQuote: "natural dialogue" }]);
});

const speakingPage = { ...pages[0]!, markdown: '“Every light is gone,” Rabbit said. He leaned forward, ready to dash into the dripping woods.' };
const speakingSpans = Object.keys(pictureBookChecklistSpans(speakingPage));
const contradicted = { ...finding, quote: speakingPage.markdown };
const uncertainRow = { score: 70, findings: [contradicted], requirementChecks: [{ requirementIndex: 0, evidence: null },
  { requirementIndex: 1, evidence: "the dripping woods" }] };
const reconsideration = { findingIndex: 0, counterevidenceIds: [speakingSpans[0]!],
  reason: "Rabbit speaks naturally about the vanished lights; the diagnosis of no dialogue was incorrect.", replacement: null };

it("selects source spans without reproducing prose or requirement indexes", async () => {
  const test = setup({ requirementChecks: speakingSpans }, undefined, [speakingPage]);
  const reviews = await test.run();
  expect(test.generate).toHaveBeenCalledTimes(1);
  expect(reviews[0]!.report.approved).toBe(true);
  expect(reviews[0]!.requirementChecks).toEqual([
    { requirementIndex: 0, evidence: '“Every light is gone,” Rabbit said.' },
    { requirementIndex: 1, evidence: 'He leaned forward, ready to dash into the dripping woods.' }
  ]);
  const payload = JSON.parse(test.generate.mock.calls[0]![0].messages.find((m: { role: string }) => m.role === "user")!.content);
  expect(payload.pages[0].markdown).toBeUndefined();
  expect(Object.values(payload.pages[0].spans).join("")).toBe(speakingPage.markdown);
});

it.each(["unknown", "other_page", "stale", "omitted", "extra"])("refuses %s source references", async mode => {
  const invalid = mode === "unknown" ? "invented:0" : Object.keys(pictureBookChecklistSpans({ ...speakingPage,
    ...(mode === "other_page" ? { index: 17 } : { markdown: speakingPage.markdown + "!" }) }))[0]!;
  const refs = mode === "omitted" ? speakingSpans.slice(0, 1) : mode === "extra" ? [...speakingSpans, speakingSpans[0]] : [invalid, speakingSpans[1]];
  await expect(setup({ requirementChecks: refs }, undefined, [speakingPage]).run()).rejects.toThrow();
});

it("withdraws a contradicted absence claim only after reviewing all its counterevidence", async () => {
  const test = setup(uncertainRow, { pages: [], auxiliaryCorrections: [{ id: "page:16",
    requirementChecks: speakingSpans, reconsideredScore: 95, reconsiderations: [reconsideration] }] }, [speakingPage]);
  const reviews = await test.run();
  expect(reviews[0]!.report.approved).toBe(true);
  expect(reviews[0]!.findings).toEqual([]);
  expect(reviews[0]!.report.score).toBe(95);
  expect(test.generate).toHaveBeenCalledTimes(2);
  const payload = JSON.parse(test.generate.mock.calls[1]![0].messages.find((m: { role: string }) => m.role === "user")!.content);
  expect(payload.auxiliaryRecovery.rows[0].counterevidence).toEqual([{ findingIndex: 0, spanIds: [speakingSpans[0]] }]);
});

it.each(["omitted", "wrong_span", "wrong_finding", "duplicate", "wrong_requirement"])("does not silently erase a challenge via %s reconsideration", async mode => {
  const item = { ...reconsideration, ...(mode === "wrong_span" ? { counterevidenceIds: [speakingSpans[1]!] } : {}),
    ...(mode === "wrong_finding" ? { findingIndex: 1 } : {}),
    ...(mode === "wrong_requirement" ? { replacement: { ...contradicted, requirementQuote: "concrete sensory details" } } : {}) };
  const test = setup(uncertainRow, { pages: [], auxiliaryCorrections: [{ id: "page:16", requirementChecks: speakingSpans, reconsideredScore: 95,
    reconsiderations: mode === "omitted" ? [] : mode === "duplicate" ? [item, item] : [item] }] }, [speakingPage]);
  await expect(test.run()).rejects.toMatchObject({ checkpoint: { editorialRows: [expect.objectContaining({ findings: [contradicted] })] } });
});

it("can diagnose inadequate dialogue after reconsideration without treating quotation marks as approval", async () => {
  const replacement = { ...contradicted, message: "Rabbit's spoken line is stilted in this scene.", guidance: "Make Rabbit's line sound natural." };
  const test = setup(uncertainRow, { pages: [], auxiliaryCorrections: [{ id: "page:16",
    requirementChecks: [null, speakingSpans[1]], reconsideredScore: 75, reconsiderations: [{ ...reconsideration, replacement }] }] }, [speakingPage]);
  expect((await test.run())[0]).toMatchObject({ report: { approved: false }, findings: [replacement] });
});

it("keeps unrelated findings when a contradicted absence is withdrawn", async () => {
  const independent = { ...contradicted, basis: "page_prose", requirementQuote: null, category: "style", message: "A separate style defect.", guidance: "Fix the style." };
  const test = setup({ ...uncertainRow, findings: [contradicted, independent] }, { pages: [], auxiliaryCorrections: [{ id: "page:16",
    requirementChecks: speakingSpans, reconsideredScore: 95, reconsiderations: [reconsideration] }] }, [speakingPage]);
  expect((await test.run())[0]).toMatchObject({ report: { approved: false }, findings: [independent] });
});

it("retains newly discovered concerns when auxiliary recovery cannot validate them", async () => {
  const test = setup({}, { pages: [], auxiliaryCorrections: [{ id: "page:16", requirementChecks: [null, speakingSpans[1]],
    requirementFindings: [contradicted] }] }, [speakingPage]);
  await expect(test.run()).rejects.toMatchObject({ checkpoint: { editorialRows: [expect.objectContaining({ findings: [contradicted] })] } });
});

it("routes a pure text-only delivery constraint out of per-page prose checks, retaining mixed clauses", () => {
  const pure = "All story pages are text-only.", mixed = "All story pages are text-only and must explain every action.";
  const prompt = `${pure} ${mixed}`;
  const requirements = [pure, mixed].map(quote => ({ quote, text: quote, kind: "content" as const,
    scope: { extent: "each_page" as const, quote } }));
  expect(pictureBookPageRequirements({ ...input, prompt }, { ...plan,
    requirementInventory: { ...plan.requirementInventory, brief: prompt, requirements } })).toEqual([{ requirementIndex: 0, quote: mixed }]);
});
