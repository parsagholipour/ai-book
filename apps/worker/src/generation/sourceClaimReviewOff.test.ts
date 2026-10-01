import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ config: { MOCK_AI: false } }));
vi.mock("../runtime/config.js", () => ({ config: mocks.config }));

import { FakeTextModelAdapter, makeFallbackPlan, createProjectSchema } from "@book-maker/core";
import { repairComposedClaims, sourceClaimReviewApplies, SOURCE_CLAIM_REVIEW } from "./composedClaimReview.js";
import { unsupportedCaseClaimIssues } from "./composedEvidenceResiduals.js";

// 2026-09-30: claim and source verification is off on every tier. A nonfiction
// chapter spends no inventory, verification, search or repair call, and a
// stored ledger on an older book no longer flags its later edits.
const input = createProjectSchema.parse({ prompt: "Explain public-key cryptography.", category: "SCIENCE", targetPages: 20 });
const plan = makeFallbackPlan(input);

it("reviews no claim in a composed nonfiction chapter", async () => {
  expect(SOURCE_CLAIM_REVIEW).toBe(false);
  expect(sourceClaimReviewApplies(input, plan)).toBe(false);
  const textModel = new FakeTextModelAdapter(input);
  const generate = vi.spyOn(textModel, "generateJson");
  const searchSources = vi.fn(async () => []);
  const edit = vi.fn(async (markdown: string) => markdown);
  const result = await repairComposedClaims({ projectId: "p", input, plan, chapter: plan.chapters[0]!, markdown: "The three authors are listed alphabetically.",
    textModel, searchSources, edit, degenerate: () => false, persistSources: vi.fn(async () => {}) });
  expect(result).toEqual({});
  expect(generate).not.toHaveBeenCalled();
  expect(searchSources).not.toHaveBeenCalled();
  expect(edit).not.toHaveBeenCalled();
});

it("flags nothing from an older book's stored claim ledger", () => {
  const chapter = { productionBrief: { chapterIndex: 1, report: { sourceClaims: { textDigest: "stale", coverage: { status: "incomplete" },
    claims: [{ quote: "Listed alphabetically.", status: "insufficient_evidence", reason: "No passage." }] } } } };
  expect(unsupportedCaseClaimIssues([{ index: 1, markdown: "Listed alphabetically.", chapter }])).toEqual([]);
});
