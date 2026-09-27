import { beforeEach, describe, expect, it, vi } from "vitest";
import { bookPlanSchema, createProjectSchema, FakeTextModelAdapter, pageQualityReportSchema,
  pictureBookReviewFingerprint, type GenerateJsonOptions, type PictureBookPageReview } from "@book-maker/core";
import { repairPagesFromFinalQa } from "./compileExportRepair.js";
import { mocks } from "./testing/compileExportMocks.js";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";
import captured from "./testing/repairEffectiveness.json" with { type: "json" };
import { readPictureBookReviewSnapshot, savedPictureBookReviewSchema } from "../generation/shortPictureBookReviewCache.js";
import { StopRequestedError } from "../runtime/jobTypes.js";

type Tier = keyof typeof captured;
type Mode = "safe" | "invalid_again" | "meaning" | "unresolved" | "missing" | "linked" | "exhausted" | "local_then_semantic";

describe("repair effectiveness for the September 26 captured books", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  function setup(tier: Tier, mode: Mode = "safe") {
    const fixture = captured[tier];
    const input = createProjectSchema.parse(fixture.input), plan = bookPlanSchema.parse(fixture.plan);
    const pages: ExportPageForRepair[] = fixture.pages.map(p => ({ ...p, id: `p${p.index}`, revision: 1,
      imagePrompt: null, images: [], chapter: null, qualityReport: pageQualityReportSchema.parse(p.qualityReport) }));
    let saved = structuredClone(pages);
    const job = { projectId: "project", type: "COMPILE_EXPORT", status: "ACTIVE", payload: { pictureBookReview: {
      fingerprint: pictureBookReviewFingerprint({ input, plan, pages, checks: fixture.checks }), reviews: fixture.reviews.map(review => savedPictureBookReviewSchema.parse(review))
    } } };
    mocks.prisma.generationJob.findUnique.mockResolvedValue(job);
    mocks.loadPagesForExport.mockImplementation(async () => saved);
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.$transaction.mockImplementation(async run => {
      const before = structuredClone(saved);
      try { return await run(mocks.prisma); } catch (error) { saved = before; throw error; }
    });
    mocks.prisma.page.update.mockImplementation(async ({ where, data }) => {
      const index = saved.findIndex(p => p.id === where.id);
      saved[index] = { ...saved[index]!, ...data, revision: saved[index]!.revision + data.revision.increment };
      return saved[index];
    });
    const text = new FakeTextModelAdapter(), calls: GenerateJsonOptions<unknown>[] = [];
    let repairs = 0;
    text.generateJson = async <T,>(request: GenerateJsonOptions<T>) => {
      calls.push(request);
      expect(mocks.prisma.page.update).not.toHaveBeenCalled();
      const payload = JSON.parse(request.messages[1]!.content);
      let raw: unknown;
      if (request.purpose === "revise-page") {
        repairs += 1;
        const patch = structuredClone(fixture.patch);
        if (mode === "exhausted") request.textAttemptBudget!.used = request.textAttemptBudget!.limit;
        // The first response is the exact captured bad candidate. The bounded
        // correction below is scripted evidence, not a fresh model evaluation.
        if (tier === "balanced" && repairs === 2 && mode !== "invalid_again") {
          const p18 = patch.pages.find(p => p.pageIndex === 18)!;
          p18.patches[1]!.replace = "Blue glowed between the empty gate post and Red’s light at the creek.";
          const p24 = patch.pages.find(p => p.pageIndex === 24)!;
          p24.patches[0]!.replace += " They moved at a steady pace.";
        }
        raw = patch;
      } else if (payload.phase === "picture_book_citation_recovery") {
        raw = fixture.citationRecovery;
      } else {
        const rows = fixture.candidateReview?.pages ?? fixture.reviews.map(r => ({ pageIndex: r.pageIndex,
          score: 96, findings: [], storyExtract: fixture.checks.storyExtractAudit ? "no_changes" : null,
          styleAudit: fixture.checks.styleAuditor ? "clean" : null }));
        raw = { pages: rows.filter(row => payload.reviewPageIndexes.includes(row.pageIndex)).map(row => ({ ...row,
          ...(payload.repairContext?.changes.some((c: { pageIndex: number }) => c.pageIndex === row.pageIndex) && mode !== "missing"
            ? { repairAssessment: { targetResolved: mode !== "unresolved", meaningPreserved: mode !== "meaning" && mode !== "local_then_semantic",
              noNewRegressions: mode !== "linked", reason: "Compared each changed clause for grammar, meaning, target resolution and downstream effects." } } : {}),
          ...(mode === "linked" && row.pageIndex === 20 ? { findings: [{ ...captured.premium.candidateReview.pages[19]!.findings[0],
            relatedEvidence: [{ pageIndex: 29, quote: payload.pages[28].markdown }] }] } : {}) })) };
      }
      return { data: request.schema.parse(raw), text: JSON.stringify(raw), provider: "fixture", model: "fixture" };
    };
    const unavailable = vi.fn();
    const options = { projectId: "project", planId: "plan", generationJobId: "compile", input, plan, pages,
      finalQa: { approved: false, score: 75, issues: fixture.issues[0]!.messages, requiredFixes: [], notes: "" },
      extraPageIndexes: fixture.issues.flatMap(issue => issue.pageIndexes), providers: { text },
      strategy: { executionMode: "draft-then-polish", shouldIllustratePage: () => false },
      quality: { enabled: (feature: string) => feature === "pageLocalQa" || feature === "styleExcerpts" || fixture.checks[feature as keyof typeof fixture.checks] === true },
      assertOwnership: vi.fn(), onRepairGroupStarted: vi.fn(async () => true), onRepairGroupPublished: vi.fn(), onRepairPageUnavailable: unavailable
    } as unknown as Parameters<typeof repairPagesFromFinalQa>[0];
    return { options, calls, unavailable, original: pages, saved: () => saved, run: () => repairPagesFromFinalQa(options), job };
  }

  it("retains Quick's verified sentence edits and the unchanged page-13 concern as explicitly unverified", async () => {
    const test = setup("fast");
    // An outstanding original concern keeps this on the complete review and
    // citation-recovery path. The clean-baseline sentence path has its own replay.
    test.job.payload.pictureBookReview.reviews = test.job.payload.pictureBookReview.reviews.map(review => review.pageIndex === 13
      ? { ...review, report: { ...review.report, approved: false, issues: ["Unverified agreed-signal continuity concern."] } } : review);
    await test.run();
    expect(test.saved().filter(p => p.revision === 2).map(p => p.index)).toEqual([16, 30]);
    expect(test.saved()[12]!.markdown).toBe(test.original[12]!.markdown);
    expect(test.saved()[12]!.status).toBe("FAILED_QA");
    expect(test.saved()[12]!.qualityReport).toMatchObject({ approved: false, issues: [expect.stringMatching(/unverified.*agreed signal/i)] });
    expect(test.unavailable).not.toHaveBeenCalled();
    expect(test.calls.map(c => c.purpose)).toEqual(["revise-page", "review-page", "review-page"]);
    const update = mocks.prisma.generationJob.update.mock.calls.at(-1)![0];
    const snapshot = update.data.payload.pictureBookFinalReview;
    snapshot.reviews.forEach((r: PictureBookPageReview) => savedPictureBookReviewSchema.parse(r));
    expect(snapshot.fingerprint).toBe(pictureBookReviewFingerprint({ input: test.options.input, plan: test.options.plan,
      pages: test.saved(), checks: captured.fast.checks }));
    const reviews = readPictureBookReviewSnapshot(snapshot, { input: test.options.input, plan: test.options.plan,
      pages: test.saved(), checks: captured.fast.checks });
    expect(reviews?.find(r => r.pageIndex === 13)?.report.approved).toBe(false);
    expect(reviews?.find(r => r.pageIndex === 13)?.report.issues.join(" ")).toMatch(/unverified/i);
    const corrupt = structuredClone(snapshot);
    corrupt.reviews.find((r: PictureBookPageReview) => r.pageIndex === 13).report.approved = true;
    expect(readPictureBookReviewSnapshot(corrupt, { input: test.options.input, plan: test.options.plan,
      pages: test.saved(), checks: captured.fast.checks })).toBeUndefined();
  });

  it("corrects Balanced's locally invalid candidate once against the original manuscript, then verifies and publishes", async () => {
    const test = setup("balanced"); await test.run();
    expect(test.saved().filter(p => p.revision === 2).map(p => p.index)).toEqual([3, 9, 18, 24]);
    expect(test.saved()[17]!.markdown).toContain("Blue glowed between the empty gate post and Red’s light at the creek.");
    expect(test.calls.map(c => c.purpose)).toEqual(["revise-page", "revise-page", "review-page"]);
    const feedback = JSON.parse(test.calls[1]!.messages[1]!.content);
    expect(feedback.pages[17].markdown).toBe(test.original[17]!.markdown);
    expect(JSON.stringify(feedback)).toContain("33 words");
    expect(test.calls[0]!.textAttemptBudget).toBe(test.calls[1]!.textAttemptBudget);
    expect(test.unavailable).not.toHaveBeenCalled();
  });

  it("retains Premium's page-29 improvement while saving inherited repetition on unchanged pages 19/20", async () => {
    const test = setup("premium"); await test.run();
    expect(test.unavailable.mock.calls).toEqual([]);
    expect(test.saved().filter(p => p.revision === 2).map(p => p.index)).toEqual([29]);
    expect(test.saved()[28]!.markdown).toContain("warm pie");
    expect(test.saved()[19]!.status).toBe("FAILED_QA");
    expect(test.saved()[19]!.markdown).toBe(test.original[19]!.markdown);
    expect(test.calls).toHaveLength(2);
    expect(test.unavailable).not.toHaveBeenCalled();
  });

  it.each(["meaning", "unresolved", "missing", "linked"] as const)("does not publish an editorial repair with %s comparison", async mode => {
    const test = setup("premium", mode); await test.run();
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    expect(test.saved()).toEqual(test.original);
    expect(test.unavailable).toHaveBeenCalled();
    expect(test.calls.length).toBeLessThanOrEqual(3);
  });

  it.each(["invalid_again", "exhausted"] as const)("cannot extend the local-correction allowance after %s", async mode => {
    const test = setup("balanced", mode); await test.run();
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    expect(test.saved()).toEqual(test.original);
    expect(test.calls).toHaveLength(mode === "exhausted" ? 1 : 2);
    expect(test.calls.every(c => c.purpose === "revise-page")).toBe(true);
  });

  it("shares the final correction between local and semantic failures", async () => {
    const test = setup("balanced", "local_then_semantic"); await test.run();
    expect(test.calls.map(c => c.purpose)).toEqual(["revise-page", "revise-page", "review-page"]);
    expect(test.unavailable).toHaveBeenCalled();
    expect(test.saved()).toEqual(test.original);
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
  });

  it("honors a stop before the local correction without publishing or recording repair failure", async () => {
    const test = setup("balanced");
    let checksAfterFirstCall = 0;
    test.options.assertOwnership = async () => {
      if (test.calls.length === 1 && ++checksAfterFirstCall === 2) throw new StopRequestedError();
    };
    await expect(test.run()).rejects.toBeInstanceOf(StopRequestedError);
    expect(test.calls).toHaveLength(1);
    expect(test.saved()).toEqual(test.original);
    expect(test.unavailable).not.toHaveBeenCalled();
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
  });

  it("pins both repair candidates to one route and shares the remaining physical attempts", async () => {
    const test = setup("balanced"), adapter = test.options.providers.text;
    const generate = adapter.generateJson.bind(adapter);
    let candidates = 0;
    adapter.generateJson = async request => {
      if (request.purpose === "revise-page") {
        // Simulate four wire attempts in the first operation and one in its correction.
        request.textAttemptBudget!.used += ++candidates === 1 ? 4 : 1;
        expect(request.textAttemptBudget!.used).toBeLessThanOrEqual(request.textAttemptBudget!.limit);
      }
      return generate(request);
    };
    const bindForCall = vi.fn(async () => ({ adapter }));
    test.options.providers.text = Object.assign(Object.create(adapter), { bindForCall });
    await test.run();
    expect(bindForCall.mock.calls).toEqual([["revise-page"], ["review-page"]]);
    expect(test.calls[0]!.textAttemptBudget!.used).toBe(5);
    expect(test.saved().filter(page => page.revision === 2)).toHaveLength(4);
    expect(test.unavailable).not.toHaveBeenCalled();
  });
});

vi.mock("./compileFinalization.js", async () => (await import("./testing/compileExportMocks.js")).compileFinalizationModuleMock());
vi.mock("../generation/finalizationIllustrations.js", async () => (await import("./testing/compileExportMocks.js")).finalizationIllustrationsModuleMock());
vi.mock("@book-maker/db", async () => (await import("./testing/compileExportMocks.js")).dbModuleMock());
vi.mock("../runtime/config.js", async () => (await import("./testing/compileExportMocks.js")).configModuleMock());
vi.mock(
  "../generation/projectInput.js",
  async () => (await import("./testing/compileExportMocks.js")).projectInputModuleMock()
);
vi.mock(
  "../generation/exportPublication.js",
  async () => (await import("./testing/compileExportMocks.js")).exportPublicationModuleMock()
);
vi.mock("../runtime/dispatch.js", async () => (await import("./testing/compileExportMocks.js")).dispatchModuleMock());
vi.mock(
  "../runtime/jobLifecycle.js",
  async () => (await import("./testing/compileExportMocks.js")).jobLifecycleModuleMock()
);
vi.mock(
  "../providers/loggedAdapters.js",
  async () => (await import("./testing/compileExportMocks.js")).loggedAdaptersModuleMock()
);
vi.mock(
  "../generation/embeddingWrites.js",
  async () => (await import("./testing/compileExportMocks.js")).embeddingWritesModuleMock()
);
vi.mock(
  "../generation/entityState.js",
  async () => (await import("./testing/compileExportMocks.js")).entityStateModuleMock()
);
vi.mock("./characters.js", async () => (await import("./testing/compileExportMocks.js")).charactersModuleMock());
vi.mock(
  "../generation/bookHelpers.js",
  async () => (await import("./testing/compileExportMocks.js")).bookHelpersModuleMock()
);
vi.mock("../generation/finalQaPageTargets.js", async () => {
  const actual =
    await vi.importActual<typeof import("../generation/finalQaPageTargets.js")>(
      "../generation/finalQaPageTargets.js"
    );
  return (await import("./testing/compileExportMocks.js")).finalQaPageTargetsModuleMock(actual);
});
vi.mock(
  "../generation/storyStateStore.js",
  async () => (await import("./testing/compileExportMocks.js")).storyStateStoreModuleMock()
);
vi.mock(
  "../generation/qualityEnrichment.js",
  async () => (await import("./testing/compileExportMocks.js")).qualityEnrichmentModuleMock()
);
vi.mock(
  "../generation/qualitySettings.js",
  async () => (await import("./testing/compileExportMocks.js")).qualitySettingsModuleMock()
);
vi.mock("../generation/pageReview.js", async () => {
  const actual = await vi.importActual<typeof import("../generation/pageReview.js")>("../generation/pageReview.js");
  return (await import("./testing/compileExportMocks.js")).pageReviewModuleMock(actual);
});
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return (await import("./testing/compileExportMocks.js")).coreModuleMock(actual);
});
