import { expect, it, vi } from "vitest";
import { createProjectSchema, FakeTextModelAdapter, makeFallbackPlan, manuscriptCoverageSchema, type GenerateJsonOptions } from "@book-maker/core";

vi.mock("@book-maker/db", () => ({ prisma: {} }));
import { buildManuscriptCoverageContext } from "../generation/manuscriptCoverageReview.js";
import { finalizationCoverageForCompile } from "./compileExportCoverageCheckpoint.js";
import { finalizationFingerprint, manuscriptFinalizationFingerprint } from "./compileFinalization.js";

type Operation = Parameters<typeof finalizationCoverageForCompile>[0]["operation"];
type Request<T> = { slot: string; fingerprint: string; parse: (value: unknown) => T | undefined; compute: () => Promise<T> };
function durableOperation(cache: Map<string, unknown>): Operation {
  return { state: { key: "operation", inputFingerprint: "configuration" }, exportCheck: async <T>(request: Request<T>) => {
    const key = `${request.slot}:${request.fingerprint}`;
    const cached = request.parse(cache.get(key));
    if (cached !== undefined) return cached;
    const value = await request.compute();
    cache.set(key, JSON.parse(JSON.stringify(value)));
    return value;
  } };
}
const permission = "Use the selected saved characters as the central characters.";
const prohibition = "Avoid extra named main characters.";
const brief = `${permission} ${prohibition}`;
const input = createProjectSchema.parse({ prompt: brief, category: "KIDS", targetPages: 5, mediaSettings: {
  mobile: { characters: [{ id: "rabbit", name: "Rabbit", description: "Playful", fields: [] }] }
} });
const plan = makeFallbackPlan(input);
plan.characters = ["Rabbit", "Invented Fox"].map(name => ({ name, role: "Lead", description: "", traits: [], visualRules: [] }));
const pages = Array.from({ length: 5 }, (_, i) => ({ id: `page-${i + 1}`, index: i + 1, revision: 1, title: `Page ${i + 1}`,
  markdown: `Rabbit led the neighbors past lantern ${i + 1}.`, images: [] }));
const assessment = { scope: "whole_manuscript", complete: true, checkedPageIndexes: [1, 2, 3, 4, 5], entities: [
  { name: "Rabbit", aliases: [], role: "main_character", reason: "Rabbit guides the neighbors throughout.",
    evidence: [{ pageIndex: 1, quote: pages[0]!.markdown }], permissionQuote: permission }
], counterexamples: [] };
const inventory = { complete: true, requirements: [{ text: prohibition, quote: prohibition, kind: "prohibition", prohibitionScope: "named_main_characters" }] };
const response = { complete: true, requirements: [{ id: "brief-1", status: "fulfilled", reason: "The selected Rabbit is the only named protagonist.", evidence: [], prohibitionAssessment: assessment }] };
function scriptedModel(replies: unknown[]) {
  const model = new FakeTextModelAdapter(input);
  const calls: GenerateJsonOptions<unknown>[] = [];
  model.generateJson = async request => {
    calls.push(request);
    if (!replies.length) throw new Error("Unexpected model call in test");
    const reply = replies.shift();
    return { data: request.schema.parse(reply), text: JSON.stringify(reply), provider: "fixture", model: "fixture" };
  };
  return { model, calls };
}

it("persists the complete cast audit across finalization restart without rereading or approving plan-added identities", async () => {
  const { model, calls } = scriptedModel([inventory, response]);
  const cache = new Map<string, unknown>();
  const evidenceContext = buildManuscriptCoverageContext({ input, plan, pages, images: [] });
  expect(evidenceContext.selectedCharacterNames).toEqual(["Rabbit"]);
  expect(evidenceContext.characters.map(c => c.name)).toContain("Invented Fox");
  const options = { brief, promises: [], pages, chapters: [], evidenceContext, textModel: model };
  const first = await finalizationCoverageForCompile({ ...options, operation: durableOperation(cache) });
  expect(first.stored.review.requirements[0]?.status).toBe("fulfilled");
  expect(first.stored.review.requirements[0]?.prohibitionAssessment).toEqual(assessment);
  const resumed = await finalizationCoverageForCompile({ ...options, operation: durableOperation(cache) });
  expect(resumed).toEqual(first);
  expect(calls).toHaveLength(2);
  expect(manuscriptCoverageSchema.parse(JSON.parse(JSON.stringify(resumed.stored.review)))).toEqual(resumed.stored.review);
});

it("does not reuse the earlier inventory or quote-only coverage checkpoint", async () => {
  const cache = new Map<string, unknown>();
  const evidenceContext = buildManuscriptCoverageContext({ input, plan, pages, images: [] });
  cache.set(`inventory:${finalizationFingerprint({ version: 4, brief })}`, { ...inventory, brief, status: "available" });
  cache.set(`coverage:${finalizationFingerprint({ version: 6, requirementTargets: [], operation: "operation", configuration: "configuration",
    manuscript: manuscriptFinalizationFingerprint(pages), brief, promises: [], chapters: [], evidenceContext: { ...evidenceContext, illustratedPageIndexes: [], mediaInventory: {} } })}`,
  { status: "reviewed", assessmentComplete: true, requirements: [{ ...inventory.requirements[0], ...response.requirements[0],
    id: "brief-1", source: "brief", prohibitionAssessment: undefined, evidence: [{ pageIndex: 1, quote: pages[0]!.markdown }] }] });
  const { model, calls } = scriptedModel([inventory, response]);
  const result = await finalizationCoverageForCompile({ operation: durableOperation(cache), brief, promises: [], pages, chapters: [], evidenceContext, textModel: model });
  expect(calls.map((call: GenerateJsonOptions<unknown>) => JSON.parse(call.messages.at(-1)!.content).phase))
    .toEqual(["brief_requirement_inventory", "manuscript_requirement_verification"]);
  expect(result.stored.review.requirements[0]?.prohibitionAssessment).toEqual(assessment);
});

it("refreshes the old cast contract, preserves the brief inventory and saves recovered anchors across restart", async () => {
  const manuscript = pages.map(page => ({ ...page, markdown: `${page.markdown} He held the light.` }));
  const audit = { ...assessment, entities: [{ ...assessment.entities[0]!, evidence: [{ pageIndex: 1, quote: "He held the light." }] }] };
  const verification = { ...response, requirements: [{ ...response.requirements[0]!, prohibitionAssessment: audit }] };
  const evidenceContext = buildManuscriptCoverageContext({ input, plan, pages: manuscript, images: [] });
  const cache = new Map<string, unknown>();
  cache.set(`inventory:${finalizationFingerprint({ version: 5, brief })}`, { ...inventory, brief, status: "available" });
  const oldCoverageKey = `coverage:${finalizationFingerprint({ version: 7, requirementTargets: [], operation: "operation", configuration: "configuration",
    manuscript: manuscriptFinalizationFingerprint(manuscript), brief, promises: [], chapters: [],
    evidenceContext: { ...evidenceContext, illustratedPageIndexes: [], mediaInventory: {} } })}`;
  cache.set(oldCoverageKey, { status: "incomplete", assessmentComplete: true, requirements: [{ ...inventory.requirements[0],
    ...verification.requirements[0], source: "brief", status: "unverified" }] });
  const anchor = { pageIndex: 1, quote: manuscript[0]!.markdown };
  const { model, calls } = scriptedModel([verification,
    { corrections: [{ id: "brief-1:entity-1", supportsSameEntityAndRole: true, namingEvidence: anchor }] }]);
  const options = { brief, promises: [], pages: manuscript, chapters: [], evidenceContext, textModel: model };
  const first = await finalizationCoverageForCompile({ ...options, operation: durableOperation(cache) });
  expect(first.stored.review.requirements[0]?.status).toBe("fulfilled");
  expect(first.stored.review.requirements[0]?.prohibitionAssessment).toEqual({ ...audit,
    entities: [{ ...audit.entities[0], namingEvidence: anchor }] });
  const resumed = await finalizationCoverageForCompile({ ...options, operation: durableOperation(cache) });
  expect(resumed).toEqual(first);
  expect(calls.map(call => JSON.parse(call.messages.at(-1)!.content).phase))
    .toEqual(["manuscript_requirement_verification", "prohibition_evidence_recovery"]);
  expect(manuscriptCoverageSchema.parse(JSON.parse(JSON.stringify(resumed.stored.review)))).toEqual(resumed.stored.review);
});
