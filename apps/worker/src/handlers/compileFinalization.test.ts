import { beforeEach, expect, it, vi } from "vitest";
import type { FinalBookQa, TextModelAdapter, CoverageEvidenceContext } from "@book-maker/core";

const db = vi.hoisted(() => ({ rows: new Map<string, { id: string; payload: Record<string, unknown> }>(), lock: vi.fn(), stop: vi.fn() }));
vi.mock("@book-maker/db", () => {
  const tx = {
    $queryRaw: db.lock,
    generationJob: {
      findFirst: async (args: { where: { payload: { equals: string } } }) => [...db.rows.values()].find((row) =>
        (row.payload.finalization as { key?: string } | undefined)?.key === args.where.payload.equals) ?? null,
      findUnique: async (args: { where: { id: string } }) => structuredClone(db.rows.get(args.where.id) ?? null),
      update: async (args: { where: { id: string }; data: { payload: Record<string, unknown> } }) => {
        const row = { id: args.where.id, payload: structuredClone(args.data.payload) }; db.rows.set(row.id, row); return row;
      }
    }
  };
  // Serial transactions model the production Project FOR UPDATE lock.
  let tail: Promise<unknown> = Promise.resolve();
  return { prisma: { $transaction: (run: (value: typeof tx) => Promise<unknown>) => {
    const result = tail.then(() => run(tx)); tail = result.catch(() => {}); return result;
  } } };
});
vi.mock("../runtime/jobLifecycle.js", () => ({ assertJobNotStopped: db.stop }));
import { openCompileFinalization } from "./compileFinalization.js";
import { prisma } from "@book-maker/db";
import { finalizationCoverageForCompile, prepareFinalizationCoverageInventory } from "./compileExportCoverageCheckpoint.js";
import { finalRepairQualityIssues, RepairRejectedError } from "./compileRepairOutcome.js";

const page = { id: "page1", index: 1, title: "Lantern", markdown: "Rabbit waits.", revision: 1 };
const options = { projectId: "project", planId: "plan", generationJobId: "compile1", contentRevision: 1,
  operationIdentity: { attemptId: "paid1" }, input: { tier: "fast" }, pages: [page], payload: {} };
const qa: FinalBookQa = { approved: true, score: 100, issues: [], requiredFixes: [], notes: "Clean." };
beforeEach(() => { db.rows.clear(); db.lock.mockReset(); db.stop.mockReset(); });

it("claims a related repair group atomically and cannot re-spend it after interruption", async () => {
  const pages = [page, { ...page, id: "page2", index: 2 }];
  const first = await openCompileFinalization({ ...options, pages });
  await first.beginRepair(pages.map((item) => item.id));
  expect(await first.claimPages([pages[0]!, { id: "not-a-target", index: 3 }])).toBe(false);
  expect(first.state.startedPageIds).toEqual([]);
  expect(await first.claimPages(pages)).toBe(true);
  expect(first.state.startedPageIds).toEqual(["page1", "page2"]);
  await first.close();
  const successor = await openCompileFinalization({ ...options, generationJobId: "compile2", pages });
  expect(await successor.claimPages(pages)).toBe(false);
  expect(await successor.claimPages([pages[1]!])).toBe(false);
  expect(await successor.claimPage("page2", 2)).toBe(false);
  await successor.close();
});

it("does not create a fresh group budget after an older page-wise repair started", async () => {
  const second = { ...page, id: "page2", index: 2 };
  const run = await openCompileFinalization({ ...options, pages: [page, second] });
  await run.beginRepair([page.id, second.id]);
  expect(await run.claimPage(page.id, page.index)).toBe(true);
  expect(await run.claimPages([second])).toBe(false);
  await run.close();
});

it("saves group completion in the publication transaction so a successor never reports it interrupted", async () => {
  const pages = [page, { ...page, id: "page2", index: 2 }];
  const first = await openCompileFinalization({ ...options, pages });
  await first.beginRepair(pages.map((item) => item.id));
  await first.claimPages(pages);
  const published = pages.map((item) => ({ ...item, markdown: "Rabbit and Turtle agree on the path.", revision: 2 }));
  await prisma.$transaction((tx) => first.finishRepairInTransaction(tx, published));
  // No separate completePage/finishRepair calls: model a worker dying after
  // the manuscript transaction commits, before normal handler bookkeeping.
  await first.close();
  const successor = await openCompileFinalization({ ...options, generationJobId: "compile2", pages: published });
  expect(successor.state.repairPassCompleted).toBe(true);
  expect(successor.state.completedPageIds).toEqual(["page1", "page2"]);
  expect(successor.state.unavailableRepairPageIds ?? []).toEqual([]);
  expect(await successor.claimPages(published)).toBe(false);
  await successor.close();
});

it("resumes the same operation across image successors without repeating model QA or repair", async () => {
  const compute = vi.fn(async () => ({ finalQa: qa, issues: [] }));
  const first = await openCompileFinalization(options);
  await first.review("initial", [page], compute);
  await first.beginRepair([page.id]);
  expect(await first.claimPage(page.id, 1)).toBe(true);
  await first.completePage(page.id);
  const repaired = { ...page, revision: 3, markdown: "Rabbit asks Turtle for help." };
  await first.finishRepair([repaired]);
  await first.review("final", [repaired], compute);
  await first.phase("illustrations", ["image1"]);
  await first.close();
  const successor = await openCompileFinalization({ ...options, generationJobId: "compile2", pages: [repaired] });
  expect(successor.state.phase).toBe("illustrations");
  await successor.review("initial", [repaired], compute);
  await successor.review("final", [repaired], compute);
  expect(await successor.claimPage(page.id, 1)).toBe(false);
  expect(compute).toHaveBeenCalledTimes(2);
  expect(db.rows.get("compile2")?.payload.finalizationOperationId).toBe("compile1");
  expect([...db.rows.values()].filter((row) => row.payload.finalization)).toHaveLength(1);
  await successor.close();
});

it("consumes an interrupted page claim and preserves completed checkpoints", async () => {
  const first = await openCompileFinalization(options);
  await first.beginRepair([page.id]);
  await first.claimPage(page.id, 1);
  await first.close();
  const resumed = await openCompileFinalization(options);
  expect(await resumed.claimPage(page.id, 1)).toBe(false);
  expect(resumed.state.completedPageIds).toEqual([]);
  await resumed.close();
});

it("a new user revision gets its own allowance while internal page revisions do not", async () => {
  const first = await openCompileFinalization(options); await first.beginRepair([page.id]); await first.claimPage(page.id, 1); await first.close();
  const next = await openCompileFinalization({ ...options, generationJobId: "compile3", contentRevision: 2 });
  await next.beginRepair([page.id]);
  expect(await next.claimPage(page.id, 1)).toBe(true); await next.close();
});

it("records a bounded unavailable check once but cancellation escapes", async () => {
  const first = await openCompileFinalization(options);
  const compute = vi.fn(async () => { throw new Error("OpenAI response was incomplete: max_output_tokens."); });
  expect((await first.review("initial", [page], compute)).issues[0]?.code).toBe("FINAL_REVIEW_UNAVAILABLE");
  await first.review("initial", [page], compute);
  expect(compute).toHaveBeenCalledTimes(1);
  await expect(first.review("final", [{ ...page, revision: 2 }], async () => { throw Object.assign(new Error("stopped"), { name: "StopRequestedError" }); })).rejects.toMatchObject({ name: "StopRequestedError" });
  await first.close();
});

it("waits for a live competing delivery then uses its checkpoint", async () => {
  vi.useFakeTimers();
  try {
    const first = await openCompileFinalization(options);
    let acquired = false;
    const waiting = openCompileFinalization({ ...options, generationJobId: "compile2" }).then((value) => { acquired = true; return value; });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(acquired).toBe(false);
    await first.review("initial", [page], async () => ({ finalQa: qa, issues: [] }));
    await first.close();
    await vi.advanceTimersByTimeAsync(1_000);
    const second = await waiting;
    const compute = vi.fn();
    await second.review("initial", [page], compute);
    expect(compute).not.toHaveBeenCalled();
    await second.close();
  } finally { vi.useRealTimers(); }
});

it("does not buy another review when repair preserved the original manuscript", async () => {
  const operation = await openCompileFinalization(options);
  const compute = vi.fn(async () => ({ finalQa: qa, issues: [] }));
  await operation.review("initial", [page], compute);
  await operation.beginRepair([page.id]); await operation.finishRepair([page]);
  await operation.review("final", [page], compute);
  expect(compute).toHaveBeenCalledTimes(1);
  await operation.close();
});

it("refuses a corrupted persisted configuration instead of resetting its budget", async () => {
  const first = await openCompileFinalization(options); await first.close();
  const state = db.rows.get("compile1")!.payload.finalization as { configuration: unknown };
  state.configuration = { tier: "premium" };
  await expect(openCompileFinalization(options)).rejects.toThrow("checkpoint is invalid");
});

it("accepts PostgreSQL JSONB key reordering recursively", async () => {
  const configured = { ...options, input: { tier: "fast", settings: { final: true, page: false } } };
  const first = await openCompileFinalization(configured); await first.close();
  const state = db.rows.get("compile1")!.payload.finalization as { configuration: unknown };
  state.configuration = { settings: { page: false, final: true }, tier: "fast" };
  const resumed = await openCompileFinalization(configured);
  expect(resumed.state.configuration).toEqual(configured.input);
  await resumed.close();
});

it("a claimed review with no saved result is unavailable on restart, never paid for twice", async () => {
  const first = await openCompileFinalization(options);
  await expect(first.review("initial", [page], async () => { throw Object.assign(new Error("stopped"), { name: "AbortError" }); })).rejects.toThrow();
  await first.close();
  const resumed = await openCompileFinalization(options);
  const compute = vi.fn();
  expect((await resumed.review("initial", [page], compute)).issues[0]?.code).toBe("FINAL_REVIEW_UNAVAILABLE");
  expect(compute).not.toHaveBeenCalled(); await resumed.close();
});

it("honors cancellation before waiting on a competing operation", async () => {
  const first = await openCompileFinalization(options);
  db.stop.mockRejectedValue(Object.assign(new Error("stopped by user"), { name: "StopRequestedError" }));
  await expect(openCompileFinalization({ ...options, generationJobId: "compile2" })).rejects.toMatchObject({ name: "StopRequestedError" });
  await first.close();
});

it("checks the owner on the supplied publication transaction without opening a nested one", async () => {
  const operation = await openCompileFinalization(options);
  const row = structuredClone(db.rows.get("compile1")!);
  (row.payload.finalization as { lease: { token: string } }).lease.token = "another-owner";
  const findUnique = vi.fn(async () => row);
  const client = { generationJob: { findUnique } } as unknown as Parameters<typeof operation.assertLease>[0];
  db.lock.mockClear();
  await expect(operation.assertLease(client)).rejects.toMatchObject({ name: "FinalizationLeaseLostError" });
  expect(findUnique).toHaveBeenCalledTimes(1);
  expect(db.lock).not.toHaveBeenCalled();
  await operation.close();
});

it("persists unavailable repair findings and consumed allowance across successors", async () => {
  const first = await openCompileFinalization(options);
  await first.beginRepair([page.id]); await first.claimPage(page.id, 1);
  await first.unavailablePage(page.id); await first.finishRepair([page]); await first.close();
  const resumed = await openCompileFinalization({ ...options, generationJobId: "compile2" });
  expect(resumed.state.unavailableRepairPageIds).toEqual([page.id]);
  expect(resumed.state.completedPageIds).toEqual([page.id]);
  expect(await resumed.claimPage(page.id, 1)).toBe(false);
  await resumed.close();
});

it("preserves the rejection class, actual failed pages and reason across a successor", async () => {
  const first = await openCompileFinalization(options);
  await first.beginRepair([page.id]); await first.claimPage(page.id, 1);
  await first.unavailablePage(page.id, 1, new RepairRejectedError("verification_failed", [11, 23], "Unchanged pages repeat earlier discoveries."));
  await first.finishRepair([page]); await first.close();
  const resumed = await openCompileFinalization({ ...options, generationJobId: "compile2" });
  // A retry cannot replace the useful evidence with an already-attempted error.
  await resumed.unavailablePage(page.id, 1, new Error("Already attempted"));
  expect(resumed.state.repairFailures).toEqual([{ pageId: page.id, targetPageIndex: 1,
    failureClass: "verification_failed", affectedPageIndexes: [11, 23], reason: "Unchanged pages repeat earlier discoveries." }]);
  expect(finalRepairQualityIssues(resumed.state, [page])).toEqual([expect.objectContaining({
    code: "FINAL_QA_REPAIR_REJECTED", affectedPageIndexes: [11, 23], message: expect.stringContaining("Unchanged pages repeat earlier discoveries.")
  })]);
  expect(await resumed.claimPage(page.id, 1)).toBe(false);
  await resumed.close();
});

it("keeps illustration totals after a successor resumes with no pending image jobs", async () => {
  const first = await openCompileFinalization(options);
  await first.phase("illustrations", ["image1", "image2"]); await first.close();
  const resumed = await openCompileFinalization({ ...options, generationJobId: "compile2" });
  await resumed.phase("illustrations", []);
  expect(resumed.state.illustrationJobsTotal).toBe(2);
  expect(db.rows.get("compile2")?.payload.finalizationProgress).toMatchObject({ illustrationJobsTotal: 2 });
  await resumed.close();
});

it("durably overlaps complete coverage with images and reuses one QA operation on the successor", async () => {
  const calls: string[] = [];
  const textModel: TextModelAdapter = { generateText: vi.fn(), streamText: vi.fn(), generateWithTools: vi.fn(),
    async generateJson(request) {
      const phase = JSON.parse(String(request.messages.at(-1)?.content)).phase;
      calls.push(phase);
      const data = phase === "brief_requirement_inventory" ? { complete: true, requirements: [
        { text: "Illustrate every page.", quote: "Illustrate every page.", kind: "illustration", illustrationScope: "all_story_pages" },
        { text: "No cover artwork.", quote: "No cover artwork.", kind: "content" }
      ] } : { complete: true, requirements: [
        { id: "brief-1", status: "unverified", reason: "Pending illustrations.", evidence: [] },
        { id: "brief-2", status: "unverified", reason: "Media inventory pending.", evidence: [] }
      ] };
      return { data: request.schema.parse(data), text: JSON.stringify(data), provider: "fixture", model: "fixture" };
    } };
  const context: CoverageEvidenceContext = { title: "Story", targetStoryPages: 1, storyPageIndexes: [1],
    illustratedPageIndexes: [], expectedIllustratedPageIndexes: [1], characters: [], referenceProvenance: [],
    mediaInventory: { storyPagesWithArtwork: [], coverArtworkCount: 0 } };
  const request = { brief: "Illustrate every page. No cover artwork.", promises: [], pages: [page], chapters: [], evidenceContext: context, textModel };
  const compute = vi.fn(async () => ({ finalQa: qa, issues: [] }));
  const first = await openCompileFinalization(options);
  await prepareFinalizationCoverageInventory(first, request.brief, textModel);
  await first.review("initial", [page], compute);
  await first.phase("coverage", ["image1"]);
  const pending = await finalizationCoverageForCompile({ ...request, operation: first });
  expect(pending.stored.review.requirements[0]?.status).toBe("missing");
  expect(pending.stored.review.requirements[1]?.status).toBe("fulfilled");
  await first.phase("illustrations", ["image1"]); await first.close();
  const second = await openCompileFinalization({ ...options, generationJobId: "compile2" });
  await second.review("initial", [page], compute);
  const complete = await finalizationCoverageForCompile({ ...request, operation: second,
    evidenceContext: { ...context, illustratedPageIndexes: [1], mediaInventory: { storyPagesWithArtwork: [1], coverArtworkCount: 1 } } });
  expect(complete.stored.review.requirements[0]?.status).toBe("fulfilled");
  expect(complete.stored.review.requirements[1]?.status).toBe("missing");
  expect(calls).toEqual(["brief_requirement_inventory", "manuscript_requirement_verification"]);
  expect(compute).toHaveBeenCalledOnce();
  expect([...db.rows.values()].filter((row) => row.payload.finalization)).toHaveLength(1);
  for (const mutation of [
    { pages: [{ ...page, markdown: "Turtle finds a new path.", revision: 2 }] },
    { chapters: [{ index: 1, title: "Current partition", startPageIndex: 1, endPageIndex: 1 }] },
    { evidenceContext: { ...context, referenceProvenance: [{ id: "portrait2", path: "new.png" }] } }
  ]) await finalizationCoverageForCompile({ ...request, operation: second, ...mutation });
  expect(calls.filter((call) => call === "brief_requirement_inventory")).toHaveLength(1);
  expect(calls.filter((call) => call === "manuscript_requirement_verification")).toHaveLength(4);
  await second.close();
  const third = await openCompileFinalization({ ...options, contentRevision: 2, generationJobId: "compile3" });
  await finalizationCoverageForCompile({ ...request, operation: third });
  expect(calls.filter((call) => call === "brief_requirement_inventory")).toHaveLength(2);
  expect(calls.filter((call) => call === "manuscript_requirement_verification")).toHaveLength(5);
  await third.close();
});
