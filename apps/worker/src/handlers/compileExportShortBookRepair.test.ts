import { beforeEach, describe, expect, it, vi } from "vitest";
import { bookPlanSchema, createProjectSchema, makeFallbackPlan, FakeTextModelAdapter, pageQualityReportSchema, pictureBookReviewFingerprint, type GenerateJsonOptions } from "@book-maker/core";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";
import captured from "./testing/quickLanternDraft.json" with { type: "json" };
import { repairPagesFromFinalQa } from "./compileExportRepair.js";
import { mocks } from "./testing/compileExportMocks.js";
import { ExportRepairSupersededError } from "./compileExportFence.js";
import { StopRequestedError } from "../runtime/jobTypes.js";
import premium from "./testing/premiumSentenceRepair.json" with { type: "json" };
import { unresolvedPageQualityIssues } from "../generation/unresolvedPageQuality.js";

const input = createProjectSchema.parse({ prompt: "Rabbit and Wise Turtle recover four lanterns before moonrise. Turtle starts with four matches.", category: "KIDS", targetPages: 30,
  mediaSettings: { audienceAgeRange: "6-8", modelTier: "fast", finalReview: true, fullIllustrations: false, illustrationCadence: "manual" } });
const plan = makeFallbackPlan(input);
const targets = [8, 9, 12, 13];
const pages: ExportPageForRepair[] = captured.pages.map((page) => ({ ...page, id: `p${page.index}`, imagePrompt: null,
  status: targets.includes(page.index) ? "FAILED_QA" : "COMPLETED", revision: 1, images: [], chapter: null,
  qualityReport: pageQualityReportSchema.parse({ approved: false, score: 60, issues: ["Lanterns must stay dark until the first match is used on page 21."], requiredRevisions: [], notes: "", checks: { placeholderFree: true, promptLeakFree: true, titleClean: true, repetitionOk: true, progressionOk: false, styleNatural: true } }) }));

describe("coordinated final repair of the captured Quick book", () => {
  let saved: ExportPageForRepair[];
  beforeEach(() => {
    vi.clearAllMocks();
    saved = structuredClone(pages);
    mocks.prisma.continuityNote.findMany.mockResolvedValue([]);
    mocks.loadPagesForExport.mockImplementation(async () => saved);
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
    // Transaction rollback is observable: no partly repaired book may escape.
    mocks.prisma.$transaction.mockImplementation(async (run) => {
      const before = structuredClone(saved);
      try { return await run(mocks.prisma); } catch (error) { saved = before; throw error; }
    });
    mocks.prisma.page.update.mockImplementation(async ({ where, data }) => {
      const index = saved.findIndex((page) => page.id === where.id);
      saved[index] = { ...saved[index]!, ...data, revision: saved[index]!.revision + data.revision.increment };
      return saved[index];
    });
    mocks.revisePageDraftWithRestart.mockImplementation(() => { throw new Error("Independent page repair attempted against a mixed manuscript"); });
  });

  function setup(mode: "clean" | "regression" | "incomplete" | "invalid" | "local" | "stop" | "checks" | "scene" = "clean") {
    const calls: Array<GenerateJsonOptions<unknown>> = [];
    const text = new FakeTextModelAdapter();
    text.generateJson = async <T,>(options: GenerateJsonOptions<T>) => {
      if (options.purpose === "review-picture-book-continuity") return { data: options.schema.parse({ findings: [] }), text: '{"findings":[]}', provider: "fixture", model: "continuity-fixture" };
      calls.push(options);
      expect(mocks.prisma.page.update).not.toHaveBeenCalled();
      if (mode === "stop") throw new StopRequestedError();
      const manuscript = JSON.parse(options.messages[1]!.content).pages as Array<{ index: number; markdown: string }>;
      const reusable = JSON.parse(options.messages[1]!.content).reusableStoryExtractPageIndexes ?? [];
      const raw = options.purpose === "revise-page" ? mode === "scene" ? { pages: [], sceneRevisions: [[8, 9], [12, 13]].map(indexes => ({ reason: "Resolve the connected lantern sequence.",
        pages: indexes.map(pageIndex => ({ pageIndex, title: `Dark Lantern ${pageIndex}`, markdown: `Rabbit carried the dark lantern past marker ${pageIndex}. Wise Turtle followed the path.`, summary: "Rabbit carries the unlit lantern." })) })) } : { pages: targets.map((pageIndex) => ({ pageIndex,
        reason: "Keep recovered lanterns unlit until the later match scene.", summary: "Rabbit carries the unlit lantern.",
        patches: [{ find: mode === "invalid" ? "A nonexistent exact span." : pages[pageIndex - 1]!.markdown,
          replace: mode === "local" ? "TODO: finish this scene." : `Rabbit carried the dark lantern past marker ${pageIndex}. Wise Turtle followed the path.` }] })) }
        : { pages: pages.filter((page) => mode !== "incomplete" || page.index !== 30).map((page) => ({ pageIndex: page.index, score: 96,
          findings: mode === "regression" && page.index === 21 ? [{ domain: "prose", basis: "cross_page", category: "continuity", requirementQuote: null,
            message: "The later match count contradicts the repaired earlier scene.", guidance: "Preserve the original lighting sequence.",
            quote: page.markdown, relatedEvidence: [{ pageIndex: 8, quote: manuscript[7]!.markdown }] }] : [],
          ...(targets.includes(page.index) ? { repairAssessment: { targetResolved: true, meaningPreserved: true,
            noNewRegressions: mode !== "regression", reason: "Compared the target correction and downstream dependencies against the original." } } : {}),
          storyExtract: mode === "checks" ? reusable.includes(page.index) ? "reuse" : { storyDelta: { factsAdded: [`Scene ${page.index} occurred.`] }, contradictions: [] } : null,
          styleAudit: mode === "checks" ? "clean" : null })) };
      return { data: options.schema.parse(raw), text: JSON.stringify(raw), provider: "test", model: "test" };
    };
    const unavailable = vi.fn();
    const claim = vi.fn(async () => true);
    const fence = vi.fn();
    const options = { projectId: "project", planId: "plan", input, plan, pages,
      finalQa: { approved: true, score: 95, issues: [], requiredFixes: [], notes: "" }, extraPageIndexes: targets,
      providers: { text }, strategy: { executionMode: "draft-then-polish", shouldIllustratePage: () => false },
      quality: { enabled: (feature: string) => feature === "pageModelReview" || (mode === "local" && feature === "pageLocalQa") || (mode === "checks" && ["storyExtractAudit", "styleAuditor", "styleExcerpts"].includes(feature)) },
      assertOwnership: fence, onRepairGroupStarted: claim, onRepairPageUnavailable: unavailable, onRepairGroupPublished: vi.fn()
    } as unknown as Parameters<typeof repairPagesFromFinalQa>[0];
    return { calls, options, unavailable, claim, fence, run: () => repairPagesFromFinalQa(options) };
  }

  it("publishes scene titles and summaries atomically with the exact reviewed prose", async () => {
    const test = setup("scene");
    await test.run();
    expect(test.calls.map(call => call.purpose)).toEqual(["revise-page", "review-page"]);
    const reviewed = JSON.parse(test.calls[1]!.messages[1]!.content);
    expect(reviewed.repairContext.sceneRevisions.map((scene: { pageIndexes: number[] }) => scene.pageIndexes)).toEqual([[8, 9], [12, 13]]);
    for (const index of targets) {
      expect(saved[index - 1]!.title).toBe(`Dark Lantern ${index}`);
      expect(saved[index - 1]!.markdown).toBe(reviewed.pages[index - 1].markdown);
      expect(saved[index - 1]!.summary).toBe("Rabbit carries the unlit lantern.");
      expect(saved[index - 1]!.revision).toBe(2);
    }
    expect(saved[0]!.title).toBe(pages[0]!.title);
  });

  it.each(["finding", "unavailable"])("blocks publication after independent continuity returns %s despite grouped approval", async mode => {
    const test = setup(), grouped = test.options.providers.text;
    const continuity = new FakeTextModelAdapter();
    const verify = vi.fn(async <T,>(request: GenerateJsonOptions<T>) => {
      expect(request.purpose).toBe("review-picture-book-continuity");
      expect(mocks.prisma.page.update).not.toHaveBeenCalled();
      if (mode === "unavailable") throw new Error("Continuity check unavailable");
      const manuscript = JSON.parse(request.messages[1]!.content).pages;
      const raw = { findings: [{ pageIndex: 21, domain: "prose", basis: "cross_page", category: "continuity", repairKind: "semantic",
        requirementQuote: null, message: "A dependency of the edited lantern scene remains inconsistent.", guidance: "Reconcile the lighting sequence.",
        quote: manuscript[20].markdown, relatedEvidence: [{ pageIndex: 8, quote: manuscript[7].markdown }] }] };
      return { data: request.schema.parse(raw), text: JSON.stringify(raw), provider: "fixture", model: "independent-continuity" };
    });
    continuity.generateJson = async request => {
      const result = await verify(request);
      return { ...result, data: request.schema.parse(result.data) };
    };
    const bindForCall = vi.fn(async purpose => ({ adapter: purpose === "review-picture-book-continuity" ? continuity : grouped }));
    test.options.providers.text = Object.assign(Object.create(grouped), { bindForCall });
    await test.run();
    expect(bindForCall.mock.calls).toEqual([["revise-page"], ["review-page"], ["review-picture-book-continuity"]]);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    expect(test.unavailable).toHaveBeenCalled();
    expect(saved).toEqual(pages);
  });

  it("spends one repair and one grouped review before continuity, and publishes only after verification", async () => {
    const { calls, run, claim } = setup();
    await run();
    expect(calls.map((call) => call.purpose)).toEqual(["revise-page", "review-page"]);
    const repair = JSON.parse(calls[0]!.messages[1]!.content);
    expect(repair.pages[0].markdown).toBe(pages[0]!.markdown);
    expect(repair.pages[20].markdown).toBe(pages[20]!.markdown);
    expect(repair.issues).toHaveLength(4);
    expect(claim).toHaveBeenCalledWith(targets.map((index) => ({ id: `p${index}`, index })));
    const review = JSON.parse(calls[1]!.messages[1]!.content);
    expect(review.pages[7].markdown).toContain("dark lantern");
    expect(review.pages[20].markdown).toBe(pages[20]!.markdown);
    expect(review.repairContext.changes).toHaveLength(4);
    expect(saved[7]!.markdown).toBe(review.pages[7].markdown);
    expect(saved[20]!.markdown).toBe(pages[20]!.markdown);
    expect(saved[7]!.revision).toBe(2);
    expect(saved[20]!.revision).toBe(1);
    expect(mocks.revisePageDraftWithRestart).not.toHaveBeenCalled();
  });

  it.each(["regression", "incomplete", "invalid", "local"] as const)("keeps all original prose after %s without per-page fallback", async (mode) => {
    const test = setup(mode);
    await test.run();
    expect(test.calls.length).toBeLessThanOrEqual(3);
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    expect(saved).toEqual(pages);
    expect(test.unavailable).toHaveBeenCalledTimes(4);
    expect(mocks.revisePageDraftWithRestart).not.toHaveBeenCalled();
    // Untouched pages also fail local checks here; correcting only the patch cannot fix the manuscript.
    if (mode === "invalid" || mode === "local") expect(test.calls).toHaveLength(1);
  });

  it("cannot retry the group or rewrite the unstarted subset after a worker restart", async () => {
    const test = setup();
    test.claim.mockResolvedValue(false);
    test.options.shouldRepairPage = (id) => id !== "p8";
    await test.run();
    expect(test.calls).toHaveLength(0);
    expect(test.claim).toHaveBeenCalledWith(targets.map((index) => ({ id: `p${index}`, index })));
    expect(saved).toEqual(pages);
  });

  it("rejects publication if an untouched dependency changed during the review", async () => {
    const test = setup();
    let claimed = 0;
    mocks.prisma.page.updateMany.mockImplementation(async () => ({ count: ++claimed === 21 ? 0 : 1 }));
    await expect(test.run()).rejects.toBeInstanceOf(ExportRepairSupersededError);
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    expect(saved).toEqual(pages);
    expect(test.fence).toHaveBeenLastCalledWith(mocks.prisma);
  });

  it("rolls back every patch if publication fails after the first changed page", async () => {
    const test = setup();
    mocks.prisma.project.update.mockRejectedValueOnce(new Error("Database disconnected"));
    await expect(test.run()).rejects.toThrow("Database disconnected");
    expect(saved).toEqual(pages);
  });

  it("rolls back the manuscript if the durable completion stamp cannot be written", async () => {
    const test = setup();
    test.options.onRepairGroupPublished = async () => { throw new Error("Checkpoint write failed"); };
    await expect(test.run()).rejects.toThrow("Checkpoint write failed");
    expect(saved).toEqual(pages);
  });

  it("propagates a user stop without recording an unavailable repair or writing prose", async () => {
    const test = setup("stop");
    await expect(test.run()).rejects.toBeInstanceOf(StopRequestedError);
    expect(test.unavailable).not.toHaveBeenCalled();
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
  });

  it("reuses grouped story and style audits and atomically rebuilds state without per-page extraction", async () => {
    const test = setup("checks");
    await test.run();
    expect(test.calls.map((call) => call.purpose)).toEqual(["revise-page", "review-page"]);
    expect(mocks.keeperStoryExtractForSave).not.toHaveBeenCalled();
    expect(saved[7]!.storyDelta).toMatchObject({ factsAdded: ["Scene 8 occurred."] });
    expect(mocks.prisma.project.update).toHaveBeenCalledWith(expect.objectContaining({ data: {
      storyState: expect.objectContaining({ facts: expect.arrayContaining([{ pageIndex: 8, text: "Scene 8 occurred." }]) })
    } }));
  });

  it("reuses only original prefix deltas and saves the accepted complete review with publication", async () => {
    const test = setup("checks");
    test.options.generationJobId = "compile-g";
    const checks = { pageModelReview: true, storyExtractAudit: true, styleAuditor: true };
    const initial = { fingerprint: pictureBookReviewFingerprint({ input, plan, pages, checks }),
      reviews: pages.map((page) => ({ pageIndex: page.index, draftMarkdown: page.markdown,
        report: pageQualityReportSchema.parse({ approved: true, score: 95, issues: [], requiredRevisions: [], notes: "" }),
        completedChecks: checks, storyExtract: { storyDelta: { factsAdded: [`Original scene ${page.index}.`] }, contradictions: [] },
        styleAudit: { styleOk: true, styleIssues: [] } })) };
    const job = { projectId: "project", type: "COMPILE_EXPORT", status: "ACTIVE", payload: { unrelated: true, pictureBookReview: initial } };
    mocks.prisma.generationJob.findUnique.mockResolvedValueOnce(job).mockResolvedValueOnce(job);
    await test.run();
    expect(JSON.parse(test.calls[1]!.messages[1]!.content).reusableStoryExtractPageIndexes).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(saved[0]!.storyDelta).toMatchObject({ factsAdded: ["Original scene 1."] });
    expect(saved[7]!.storyDelta).toMatchObject({ factsAdded: ["Scene 8 occurred."] });
    expect(saved[20]!.storyDelta).toMatchObject({ factsAdded: ["Scene 21 occurred."] });
    expect(mocks.prisma.generationJob.update).toHaveBeenCalledWith({ where: { id: "compile-g" }, data: { payload: {
      ...job.payload, pictureBookFinalReview: expect.objectContaining({
        fingerprint: pictureBookReviewFingerprint({ input, plan, pages: saved, checks }), reviews: expect.any(Array)
      })
    } } });
  });

  it("offers unchanged checklist witnesses from the frozen snapshot and publishes canonical checks", async () => {
    const test = setup();
    const scopedInput = { ...input, prompt: input.prompt + " Each page must include an event." };
    const scopedPlan = { ...plan, requirementInventory: { version: 1 as const, complete: true, status: "available" as const,
      brief: scopedInput.prompt, requirements: [{ kind: "content" as const, quote: "an event", text: "an event",
        scope: { extent: "each_page" as const, quote: "Each page must include an event." } }] } };
    Object.assign(test.options, { input: scopedInput, plan: scopedPlan, generationJobId: "compile-g" });
    const checks = { pageModelReview: true, storyExtractAudit: false, styleAuditor: false };
    const initial = { fingerprint: pictureBookReviewFingerprint({ input: scopedInput, plan: scopedPlan, pages, checks }),
      reviews: pages.map(page => ({ pageIndex: page.index, draftMarkdown: page.markdown, findings: [],
        report: pageQualityReportSchema.parse({ approved: true, score: 95, issues: [], requiredRevisions: [], notes: "" }),
        completedChecks: checks, storyExtract: null, styleAudit: null,
        requirementChecks: [{ requirementIndex: 0, evidence: page.markdown.slice(0, 120) }] })) };
    const job = { projectId: "project", type: "COMPILE_EXPORT", status: "ACTIVE", payload: { pictureBookReview: initial } };
    mocks.prisma.generationJob.findUnique.mockResolvedValueOnce(job).mockResolvedValueOnce(job);
    const generate = test.options.providers.text.generateJson.bind(test.options.providers.text);
    test.options.providers.text.generateJson = async request => {
      const response = await generate(request);
      if (request.purpose !== "review-page") return response;
      const payload = JSON.parse(request.messages[1]!.content);
      const data = JSON.parse(response.text);
      for (const row of data.pages) row.requirementChecks = payload.reusableRequirementCheckPageIndexes.includes(row.pageIndex)
        ? "reuse" : [Object.keys(payload.pages.find((page: { index: number }) => page.index === row.pageIndex).spans)[0]];
      return { ...response, data: request.schema.parse(data), text: JSON.stringify(data) };
    };
    await test.run();
    const payload = JSON.parse(test.calls[1]!.messages[1]!.content);
    expect(payload.reusableRequirementCheckPageIndexes).toEqual(pages.filter(page => !targets.includes(page.index)).map(page => page.index));
    expect(test.calls.map(call => call.purpose)).toEqual(["revise-page", "review-page"]);
    expect(saved[7]!.revision).toBe(2);
    const publication = mocks.prisma.generationJob.update.mock.calls.find(([call]) => call.data.payload?.pictureBookFinalReview)?.[0];
    expect(publication?.data.payload.pictureBookFinalReview.reviews[0].requirementChecks).toEqual(initial.reviews[0]!.requirementChecks);
  });

  function setupPremium(mode: "safe" | "meaning" | "unresolved" | "missing" | "downstream" | "linked" | "metadata" | "extra-page" | "mixed" | "local" = "safe") {
    const test = setup("checks");
    const premiumInput = createProjectSchema.parse(premium.input);
    saved = premium.pages.map((page) => ({ ...page, id: `p${page.index}`, imagePrompt: null,
      status: [13, 30].includes(page.index) ? "FAILED_QA" : "COMPLETED", revision: 1, images: [], chapter: null,
      qualityReport: pageQualityReportSchema.parse({ ...pageQualityReportSchema.parse(pages[0]!.qualityReport),
        issues: premium.issues.find((issue) => issue.pageIndexes.length === 1 && issue.pageIndexes[0] === page.index)?.messages ?? [] }) }));
    const original = structuredClone(saved);
    Object.assign(test.options, { input: premiumInput, plan: bookPlanSchema.parse(premium.plan), pages: original,
      extraPageIndexes: [13, 30], finalQa: { approved: false, score: 88, issues: [...premium.issues[0]!.messages], requiredFixes: [], notes: "" },
      quality: { enabled: (feature: string) => ["pageModelReview", "pageLocalQa", "storyExtractAudit", "styleAuditor", "styleExcerpts"].includes(feature) } });
    if (mode === "mixed") test.options.finalQa.issues.push("Page 13: Correct the lantern chronology.");
    test.options.providers.text.generateJson = async <T,>(request: GenerateJsonOptions<T>) => {
      if (request.purpose === "review-picture-book-continuity") return { data: request.schema.parse({ findings: [] }), text: '{"findings":[]}', provider: "fixture", model: "continuity-fixture" };
      test.calls.push(request);
      expect(mocks.prisma.page.update).not.toHaveBeenCalled();
      const payload = JSON.parse(request.messages[1]!.content);
      const patch = structuredClone(premium.patch);
      if (mode === "metadata") Object.assign(patch.pages[0]!, { summary: "Changed summary" });
      if (mode === "extra-page") patch.pages.push({ ...patch.pages[0]!, pageIndex: 11,
        patches: [{ find: original[10]!.markdown, replace: `${original[10]!.markdown} Turtle waited.` }] });
      if (mode === "local") patch.pages[0]!.patches[0]!.replace = "TODO: finish the scene.";
      if (mode === "meaning") patch.pages[1]!.patches[1]!.replace = patch.pages[1]!.patches[1]!.replace.replace("six lanterns", "seven lanterns");
      // Captured patches/findings; the new explicit semantic comparison is a
      // scripted response, not a claim that the historic model supplied it.
      const data = request.purpose === "revise-page" ? patch : { pages: premium.review.pages
        .filter((row) => payload.reviewPageIndexes.includes(row.pageIndex)).map((row) => ({ ...row,
          findings: (mode === "linked" || mode === "downstream") && row.pageIndex === 23 ? [{ ...row.findings[0]!,
            category: mode === "downstream" ? "continuity" : "repetition",
            relatedEvidence: [{ pageIndex: 13, quote: payload.pages[12].markdown.slice(0, 100) }] }] : row.findings,
          ...([13, 30].includes(row.pageIndex) && mode !== "missing" && request.messages[0]!.content.includes("repairAssessment")
            ? { repairAssessment: { targetResolved: mode !== "unresolved" && mode !== "mixed", meaningPreserved: mode !== "meaning",
              noNewRegressions: mode !== "downstream", reason: mode === "meaning" ? "The edit changes six lanterns to seven."
                : "Compared sentence boundaries, meaning and later dependencies against the original." } } : {}) })) };
      return { data: request.schema.parse(data), text: JSON.stringify(data), provider: "fixture", model: "fixture" };
    };
    return { ...test, original };
  }

  it("keeps the captured Premium sentence improvements and surfaces inherited repetition separately", async () => {
    const test = setupPremium();
    const { original } = test;
    await test.run();
    expect(saved.filter((page) => page.revision === 2).map((page) => page.index)).toEqual([13, 30]);
    expect(saved.filter((page) => page.status === "FAILED_QA").map((page) => page.index)).toEqual([11, 23]);
    expect(unresolvedPageQualityIssues(saved).map((issue) => issue.affectedPageIndexes)).toEqual([[11], [23]]);
    expect(saved[10]!.markdown).toBe(original[10]!.markdown);
    expect(saved[22]!.markdown).toBe(original[22]!.markdown);
    expect(test.calls.map((call) => call.purpose)).toEqual(["revise-page", "review-page"]);
    expect(test.unavailable).not.toHaveBeenCalled();
    expect(test.options.onRepairGroupPublished).toHaveBeenCalledWith(mocks.prisma,
      expect.arrayContaining([expect.objectContaining({ index: 11, status: "FAILED_QA" })]));
    expect(JSON.parse(test.calls[1]!.messages[1]!.content).repairContext.sentenceOnly).toBe(true);
  });

  it.each(["meaning", "unresolved", "missing", "downstream", "linked", "metadata", "extra-page", "mixed", "local"] as const)("retains the original Premium book for %s repairs", async (mode) => {
    const test = setupPremium(mode);
    await test.run();
    expect(saved).toEqual(test.original);
    expect(mocks.prisma.page.update).not.toHaveBeenCalled();
    expect(test.unavailable).toHaveBeenCalledTimes(2);
    expect(test.calls.length).toBeLessThanOrEqual(3);
    expect(mocks.revisePageDraftWithRestart).not.toHaveBeenCalled();
    if (mode === "linked") expect(test.unavailable).toHaveBeenCalledWith("p13", 13,
      expect.objectContaining({ failureClass: "verification_failed", affectedPageIndexes: [23] }));
    if (mode === "meaning") expect(test.unavailable).toHaveBeenCalledWith("p13", 13,
      expect.objectContaining({ failureClass: "semantic_regression", message: expect.stringContaining("six lanterns to seven") }));
    if (mode === "missing") {
      expect(test.calls).toHaveLength(3);
      expect(JSON.parse(test.calls[2]!.messages[1]!.content).reviewPageIndexes).toEqual([13, 30]);
    }
    if (["metadata", "extra-page", "local"].includes(mode)) expect(test.calls).toHaveLength(mode === "local" ? 2 : 1);
  });

  it("rolls back inherited findings together with the Premium edits if the checkpoint fails", async () => {
    const test = setupPremium();
    test.options.onRepairGroupPublished = async () => { throw new Error("Checkpoint write failed"); };
    await expect(test.run()).rejects.toThrow("Checkpoint write failed");
    expect(saved).toEqual(test.original);
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
