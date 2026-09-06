import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = { planVersion: { findUnique: vi.fn(), updateMany: vi.fn() }, page: { count: vi.fn() } };
  return {
    tx, transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
    material: vi.fn(), verify: vi.fn(), develop: vi.fn(), sources: vi.fn(), config: { MOCK_AI: false }
  };
});
vi.mock("@book-maker/db", () => ({ Prisma: {}, prisma: { $transaction: mocks.transaction, planVersion: mocks.tx.planVersion } }));
vi.mock("../runtime/config.js", () => ({ config: mocks.config }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn(), updateJobProgress: vi.fn() }));
vi.mock("./composedChaptersMaterial.js", () => ({ prepareBookMaterial: mocks.material, recordDossierSources: mocks.sources }));
vi.mock("./composedEvidence.js", () => ({ prepareVerifiedCases: mocks.verify }));
vi.mock("@book-maker/core", async (original) => ({ ...await original<object>(), developBookPlan: mocks.develop }));

import { FakeTextModelAdapter, QUALITY_FEATURE_DEFAULTS, makeFallbackPlan, type CreateProjectInput, type BookPlan } from "@book-maker/core";
import { persistPreparedComposedPlan, prepareComposedDevelopment } from "./composedPreparation.js";

const input = { prompt: "A history of trials and appeals", category: "EDUCATION", targetPages: 12, complexity: 3, temperature: 0.4, language: "en", mediaSettings: { fullIllustrations: false, illustrationCadence: "manual", includeCover: false, coverTemplate: "auto", finalReview: true, toneProfile: "neutral" } } as CreateProjectInput;
const plan = makeFallbackPlan(input);
const stance = { thesis: "Appeals reopen questions.", positions: ["Verdicts are provisional"], refusals: [], voiceSample: "The court ordered a new trial." };
const quality = { tier: "balanced", settings: QUALITY_FEATURE_DEFAULTS, pageReviewPromptMode: "normal", enabled: (feature: string) => feature === "bookDevelopment" } as Parameters<typeof prepareComposedDevelopment>[0]["quality"];
const options = { projectId: "project", planId: "plan", input, plan, stance, textModel: new FakeTextModelAdapter(input), quality, hasPages: false };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.MOCK_AI = false;
  mocks.tx.planVersion.findUnique.mockResolvedValue({ planningPackage: { ...plan, unrelatedAnnotation: "keep" } });
  mocks.tx.planVersion.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.page.count.mockResolvedValue(0);
  mocks.material.mockResolvedValue({ episodes: undefined, dossier: undefined });
  mocks.verify.mockResolvedValue({ episodes: { chapters: [] }, dossier: { excerpts: [], documents: [] } });
  mocks.develop.mockResolvedValue(plan);
});

describe("freezing the developed manuscript plan", () => {
  it("requires evidence even when only the dependent replanning gate is enabled", async () => {
    await prepareComposedDevelopment(options);
    expect(mocks.material).toHaveBeenCalledWith(expect.objectContaining({ evidenceRequired: true, persist: false }));
    expect(mocks.verify).toHaveBeenCalledWith(expect.objectContaining({ coverage: "book" }));
    expect(mocks.develop).toHaveBeenCalledOnce();
    expect(mocks.tx.planVersion.updateMany).toHaveBeenCalledOnce();
  });

  it("stops before persistence if the cases have no source support", async () => {
    mocks.verify.mockRejectedValueOnce(new Error("Source evidence is insufficient"));
    await expect(prepareComposedDevelopment(options)).rejects.toThrow("insufficient");
    expect(mocks.develop).not.toHaveBeenCalled();
    expect(mocks.tx.planVersion.updateMany).not.toHaveBeenCalled();
  });

  it("passes incomplete old-chapter research to replanning while preserving the gaps", async () => {
    const dossier = { excerpts: [], documents: [], researchGaps: [{ chapterIndex: 2, reason: "No verified case for this old chapter" }] };
    mocks.verify.mockResolvedValueOnce({ episodes: { chapters: [] }, dossier });
    await prepareComposedDevelopment(options);
    expect(mocks.develop).toHaveBeenCalledWith(expect.objectContaining({ dossier }));
    expect(mocks.tx.planVersion.updateMany).toHaveBeenCalledOnce();
  });

  it("retains the chapter boundaries of a legacy manuscript on restart", async () => {
    expect(await prepareComposedDevelopment({ ...options, hasPages: true })).toBe(plan);
    expect(mocks.material).not.toHaveBeenCalled();
    expect(mocks.develop).not.toHaveBeenCalled();
  });

  it("keeps the offline dry run independent of external evidence providers", async () => {
    mocks.config.MOCK_AI = true;
    expect(await prepareComposedDevelopment(options)).toBe(plan);
    expect(mocks.material).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("does not replace the plan after pages have been staged", async () => {
    mocks.tx.page.count.mockResolvedValue(1);
    await expect(persistPreparedComposedPlan("project", "plan", plan)).rejects.toThrow("chapter boundaries");
    expect(mocks.tx.planVersion.updateMany).not.toHaveBeenCalled();
  });

  it("atomically stores the new chapters and research while preserving unrelated plan fields", async () => {
    const prepared: BookPlan = { ...plan, chapters: [{ ...plan.chapters[0]!, title: "Merged material", targetPages: 12 }], dossier: { documents: [], excerpts: [] } };
    await persistPreparedComposedPlan("project", "plan", prepared);
    const write = mocks.tx.planVersion.updateMany.mock.calls[0]![0];
    expect(write.data.planningPackage).toMatchObject({ chapters: prepared.chapters, dossier: prepared.dossier, unrelatedAnnotation: "keep" });
    expect(write.where.planningPackage.equals.unrelatedAnnotation).toBe("keep");
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable", timeout: 30_000 });
  });

  it("does not overwrite an edit made while research was running", async () => {
    await expect(persistPreparedComposedPlan("project", "plan", plan, { ...plan, unrelatedAnnotation: "old" })).rejects.toThrow("research and development were running");
    expect(mocks.tx.planVersion.updateMany).not.toHaveBeenCalled();
  });

  it("fails a concurrent plan replacement instead of claiming persistence succeeded", async () => {
    mocks.tx.planVersion.updateMany.mockResolvedValue({ count: 0 });
    await expect(persistPreparedComposedPlan("project", "plan", plan)).rejects.toThrow("plan changed");
  });
});
