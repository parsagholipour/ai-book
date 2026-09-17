import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectSchema, FallbackDecisionAdapter, JEV_SELECTION, type DecisionRequest, type SourcePassage } from "@book-maker/core";

const mocks = vi.hoisted(() => ({
  prisma: {
    providerCallLog: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    project: { findUniqueOrThrow: vi.fn() }, sourceExtraction: { findMany: vi.fn() }, projectSource: { createMany: vi.fn() }
  },
  search: vi.fn(), read: vi.fn(), overview: vi.fn(),
  append: vi.fn(),
  loadRouting: vi.fn()
}));
vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {}, createSourceService: () => ({ search: mocks.search, read: mocks.read, overview: mocks.overview }) }));
vi.mock("../runtime/jobLifecycle.js", () => ({ assertJobNotStopped: vi.fn(), hasStoppedGenerationJob: vi.fn(), updateJobProgress: vi.fn() }));
vi.mock("./runLogging.js", () => ({
  createRunLogger: () => ({ filePath: "/tmp/logged-decisions.jsonl", append: mocks.append })
}));
vi.mock("./generationTextRouting.js", () => ({
  loadLiveGenerationTextRouting: () => mocks.loadRouting
}));

import { config } from "../runtime/config.js";
import { createLoggedDecisions, recordDecisionAttempt } from "./loggedDecisions.js";
import type { WorkerRuntimeJob } from "../runtime/jobPayloads.js";
import { withProjectDecisionSources } from "./sourceContext.js";

const request: DecisionRequest = { purpose: "judge-page-drafts", instructions: "Choose the faithful draft", context: "Book context", options: [{ id: "a", description: "Archive closed. [source:s1:1:2]" }, { id: "b", description: "It stayed open." }] };
const fallback = { provider: "deepseek", model: "deepseek-v4-flash" } as const;
const llm = { writer: fallback, writerFallback: fallback, judgment: fallback, judgmentFallback: fallback };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.append.mockResolvedValue("2026-01-01T00:00:00.000Z");
  mocks.prisma.providerCallLog.create.mockImplementation(async () => ({ id: `log-${mocks.prisma.providerCallLog.create.mock.calls.length}` }));
  mocks.prisma.providerCallLog.findUnique.mockResolvedValue({ metadata: {} });
});

describe("decision accounting and source context", () => {
  it("settles one row per physical call, including the uncertain paid Jev call", async () => {
    let calls = 0;
    const route = new FallbackDecisionAdapter({ primary: JEV_SELECTION, fallback, gateWinningProbability: true,
      createAdapter: (selection) => ({ async choose() {
        return { ...selection, selectedOption: "a", ...(selection.provider === JEV_SELECTION.provider ? { probabilities: { a: 0.6, b: 0.4 } } : {}), usage: { promptTokens: 1000, outputTokens: selection.provider === JEV_SELECTION.provider ? 0 : 20 } };
      } }),
      onAttempt: (attempt) => recordDecisionAttempt(attempt, { callId: `call-${++calls}`, projectId: "p", generationJobId: "j" })
    });
    await route.choose(request);
    expect(mocks.prisma.providerCallLog.create).toHaveBeenCalledTimes(2);
    expect(mocks.prisma.providerCallLog.update).toHaveBeenCalledTimes(2);
    const first = mocks.prisma.providerCallLog.update.mock.calls[0]![0];
    expect(first).toMatchObject({ where: { id: "log-1" }, data: { provider: JEV_SELECTION.provider, promptTokens: 1000, outputTokens: 0, costHint: 0.000042, metadata: { decision: { selectedOption: "a", probabilities: { a: 0.6, b: 0.4 }, escalationReason: "low_probability" } } } });
    expect(mocks.prisma.providerCallLog.update.mock.calls[1]![0]).toMatchObject({ where: { id: "log-2" }, data: { provider: "deepseek", metadata: { decision: { role: "fallback", escalationReason: "low_probability" } } } });
  });
  it("retains unpriced failures and their escalation metadata", async () => {
    await recordDecisionAttempt({ selection: JEV_SELECTION, request, role: "primary", durationMs: 10, error: new Error("context too long"), escalationReason: "provider_failure" }, { callId: "c", projectId: "p", generationJobId: "j" });
    expect(mocks.prisma.providerCallLog.create).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.providerCallLog.update).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.providerCallLog.update.mock.calls[0]![0].data).toMatchObject({ costHint: null, metadata: { liveStatus: "failed", decision: { escalationReason: "provider_failure" } } });
  });
  it("still writes ProviderCallLog when the run-log append throws", async () => {
    mocks.append.mockRejectedValue(new Error("disk full"));
    mocks.loadRouting.mockResolvedValue({
      fastDecisions: JEV_SELECTION,
      fastDecisionsFallback: fallback,
      fastJudgments: fallback,
      fastJudgmentsFallback: fallback,
      fast: llm,
      balanced: llm,
      premium: llm,
      ultra: llm
    });
    const previousMockAi = config.MOCK_AI;
    try {
      config.MOCK_AI = true;
      const route = createLoggedDecisions({
        id: "1",
        name: "generate-book",
        data: { projectId: "p", generationJobId: "j", planId: "plan-1" }
      } as WorkerRuntimeJob);
      await (await route.resolve())!.choose(request);
    } finally {
      config.MOCK_AI = previousMockAi;
    }
    expect(mocks.append).toHaveBeenCalled();
    expect(mocks.prisma.providerCallLog.create).toHaveBeenCalled();
    expect(mocks.prisma.providerCallLog.update).toHaveBeenCalled();
  });
  it("does not price Jev when output is free but billed input usage is missing", async () => {
    await recordDecisionAttempt({ selection: JEV_SELECTION, request, role: "primary", durationMs: 10, result: { ...JEV_SELECTION, selectedOption: "a", usage: { outputTokens: 0 } } }, { callId: "c", projectId: "p", generationJobId: "j" });
    expect(mocks.prisma.providerCallLog.update.mock.calls[0]![0].data).toMatchObject({ costHint: null, metadata: { provisional: true } });
  });
  it("loads cited passages once and gives primary and fallback the identical full request", async () => {
    const passage: SourcePassage = { sourceId: "s1", version: 1, ordinal: 2, name: "Archive", locator: "Page 2", content: "The archive closed in 2047. Persian source: بایگانی بسته شد." };
    mocks.prisma.project.findUniqueOrThrow.mockResolvedValue({ userId: "owner" });
    mocks.prisma.sourceExtraction.findMany.mockResolvedValue([{}]);
    mocks.read.mockResolvedValue(passage);
    mocks.search.mockResolvedValue([]);
    mocks.overview.mockResolvedValue([]);
    const requests: DecisionRequest[] = [];
    const adapter = new FallbackDecisionAdapter({ primary: JEV_SELECTION, fallback, gateWinningProbability: true, createAdapter: (selection) => ({ async choose(value) {
      requests.push(value);
      return { ...selection, selectedOption: "a", probabilities: { a: 0.6, b: 0.4 } };
    } }) });
    const input = createProjectSchema.parse({ prompt: "Source-grounded book", mediaSettings: { mobile: { sourceRefs: [{ sourceId: "s1", version: 1 }] } } });
    const route = withProjectDecisionSources({ resolve: async () => adapter }, input, "p");
    await (await route.resolve())!.choose(request);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBe(requests[1]);
    expect(requests[0]?.context).toContain(passage.content);
    expect(requests[0]?.context).toContain("[source:s1:1:2]");
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith("s1", 1, 2);
    expect(mocks.search).toHaveBeenCalledTimes(1);
  });
});
