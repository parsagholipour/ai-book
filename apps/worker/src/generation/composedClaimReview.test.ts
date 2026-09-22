import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ retrieve: vi.fn(), config: { MOCK_AI: false } }));
vi.mock("../runtime/config.js", () => ({ config: mocks.config }));
vi.mock("./sourceDossier.js", async (original) => ({ ...await original<object>(), retrieveChapterSources: mocks.retrieve }));

import { FakeTextModelAdapter, makeFallbackPlan, createProjectSchema, dossierExcerptSchema } from "@book-maker/core";
import { repairComposedClaims, sourceClaimDigest } from "./composedClaimReview.js";
import { unsupportedCaseClaimIssues } from "./composedEvidenceResiduals.js";

const input = createProjectSchema.parse({ prompt: "Explain public-key cryptography.", category: "SCIENCE", targetPages: 20 });
const plan = makeFallbackPlan(input);
const wrong = "Rivest, Shamir and Adleman are listed alphabetically.";
const corrected = "The author order is Rivest, Shamir and Adleman.";
const excerpt = dossierExcerptSchema.parse({ id: "rsa", chapterIndex: 1, documentTitle: "RSA paper", documentUrl: "https://example.org/rsa", text: corrected, provenanceVerified: true });
const inventory = (quote: string) => ({ complete: true, claims: [{ quote, searchQuery: "RSA paper author order" }] });
const verdict = (status: string) => ({ claims: [{ id: "c1", status, reason: "The paper prints this author order.", support: [{ excerptId: excerpt.id, quote: corrected }] }] });
function fixture(responses: unknown[]) {
  const textModel = new FakeTextModelAdapter(input);
  const generate = vi.spyOn(textModel, "generateJson").mockImplementation(async (request) => {
    if (!responses.length) throw new Error("Unexpected verification call");
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return { data: request.schema.parse(response), text: JSON.stringify(response), provider: "fixture", model: "fixture" };
  });
  const options = { projectId: "p", input, plan, chapter: plan.chapters[0]!, markdown: wrong, textModel,
    searchSources: vi.fn(async () => []), persistSources: vi.fn(async () => {}),
    edit: vi.fn(async () => corrected), degenerate: () => false, runLog: { append: vi.fn(async () => "logged") } };
  return { options, generate };
}
beforeEach(() => { vi.clearAllMocks(); mocks.config.MOCK_AI = false; mocks.retrieve.mockResolvedValue({ documents: [], excerpts: [] }); });

it("retrieves missing claim support, repairs the factual error and stores the accepted text's ledger", async () => {
  const test = fixture([inventory(wrong), inventory(wrong), verdict("contradicted"), inventory(corrected), verdict("supported")]);
  const supplement = { documents: [], excerpts: [excerpt] };
  mocks.retrieve.mockResolvedValue(supplement);
  const result = await repairComposedClaims(test.options);
  expect(mocks.retrieve).toHaveBeenCalledOnce();
  expect(mocks.retrieve).toHaveBeenCalledWith(expect.objectContaining({ searchSources: test.options.searchSources, evidence: true,
    episodes: [expect.objectContaining({ searchQueries: ["RSA paper author order"] })] }));
  expect(test.options.persistSources).toHaveBeenCalledWith(supplement);
  expect(test.options.edit).toHaveBeenCalledWith(wrong, expect.objectContaining({ sourcePassages: [excerpt], evidence: [], unsupportedClaims: [expect.objectContaining({ quote: wrong })] }));
  expect(result.repair).toMatchObject({ markdown: corrected, repairs: 1, unresolved: [] });
  expect(result.sourceClaims).toMatchObject({ textDigest: sourceClaimDigest(corrected), coverage: { supported: 1, contradicted: 0 } });
  expect(test.options.runLog.append).toHaveBeenCalledWith("generation.composed_chapters.claim_coverage", expect.objectContaining({ coverage: expect.objectContaining({ contradicted: 1 }) }));
});

it("bounds unsuccessful repairs and sends unsupported claims to publication QA", async () => {
  const test = fixture([inventory(wrong)]);
  test.options.edit.mockResolvedValue(wrong);
  // Losing trace storage must not lose the QA verdict.
  test.options.runLog.append.mockRejectedValue(new Error("trace unavailable"));
  const result = await repairComposedClaims(test.options);
  expect(test.options.edit).toHaveBeenCalledTimes(2);
  expect(test.generate).toHaveBeenCalledOnce();
  expect(result.repair?.unresolved).toEqual([expect.objectContaining({ quote: wrong })]);
  const issues = unsupportedCaseClaimIssues([{ index: 1, markdown: wrong, chapter: { productionBrief: { report: { sourceClaims: result.sourceClaims } } } }]);
  expect(issues).toEqual([expect.objectContaining({ code: "UNSUPPORTED_FACTUAL_CLAIMS", severity: "error" })]);
});

it("publishes an explicit incomplete-check finding after verifier failure", async () => {
  const test = fixture([new Error("Provider unavailable")]);
  const result = await repairComposedClaims(test.options);
  expect(test.options.edit).not.toHaveBeenCalled();
  expect(result.sourceClaims?.coverage.status).toBe("unavailable");
  expect(unsupportedCaseClaimIssues([{ index: 1, markdown: wrong, chapter: { productionBrief: { report: { sourceClaims: result.sourceClaims } } } }]))
    .toEqual([expect.objectContaining({ code: "SOURCE_VERIFICATION_INCOMPLETE", severity: "error" })]);
});

it("keeps mock generation offline", async () => {
  mocks.config.MOCK_AI = true;
  const test = fixture([]);
  expect(await repairComposedClaims(test.options)).toEqual({});
  expect(test.generate).not.toHaveBeenCalled();
  expect(mocks.retrieve).not.toHaveBeenCalled();
});
