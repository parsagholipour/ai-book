import { beforeEach, expect, it, vi } from "vitest";
import { GeminiResearchAdapter } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { MemoryObjectStore, setObjectStoreForTests } from "@book-maker/storage";

const counter = vi.hoisted(() => ({ units: 0 }));
vi.mock("@book-maker/db", () => {
  const create = vi.fn();
  const providerCallLog = { create };
  const tx = {
    providerCallLog,
    $queryRaw: vi.fn(async (_sql: TemplateStringsArray, _pool: string, _period: string, units: number) => {
      counter.units += units;
      return [{ units: counter.units }];
    })
  };
  return { Prisma: {}, prisma: { providerCallLog, $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) } };
});
vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../runtime/jobLifecycle.js", () => ({ assertJobNotStopped: vi.fn(), updateJobProgress: vi.fn() }));

import { LoggingResearchAdapter } from "./loggedAdapters.js";
import { createRunLogger } from "./runLogging.js";

beforeEach(() => {
  vi.clearAllMocks();
  counter.units = 0;
  setObjectStoreForTests(new MemoryObjectStore());
});

function searchReturning(response: Record<string, unknown>) {
  const inner = new GeminiResearchAdapter({ apiKey: "fixture", textModel: "gemini-2.5-flash" });
  Object.assign(inner, { ai: { models: { generateContent: async () => response } } });
  const logger = createRunLogger({ id: "grounding", name: "generate-book", data: { projectId: "p", generationJobId: "job" } } as Parameters<typeof createRunLogger>[0]);
  return new LoggingResearchAdapter(inner, logger, "job", "p");
}

const usageMetadata = { promptTokenCount: 200, candidatesTokenCount: 800 };

const groundedResponse = {
  text: "Notes.", usageMetadata,
  candidates: [{ groundingMetadata: { webSearchQueries: ["a", "b"], groundingChunks: [{ web: { title: "iso.org", uri: "https://www.iso.org/standard/1161" } }] } }]
};

it("prices a grounded search inside the free allowance at its tokens, recording where it fell", async () => {
  await searchReturning(groundedResponse).search({ query: "ISO 1161", purpose: "case-source-search" });

  expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  expect(prisma.providerCallLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
    purpose: "case-source-search",
    promptTokens: 200,
    outputTokens: 800,
    // $0.00206 of tokens; the first grounded prompt of the day is inside Google's 1,500.
    costHint: 0.00206,
    metadata: expect.objectContaining({
      operation: "research.search", groundedPrompt: true, webSearchQueries: 2, groundingSources: 1,
      groundingFeeUsd: 0, groundingListFeeUsd: 0.035, groundingPool: "gemini-2.5-flash", groundingUnits: 1,
      groundingPeriod: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), groundingOrdinal: 1, groundingAllowance: 1_500,
      groundingFreeUnits: 1, groundingAllowanceCovered: true
    })
  }) });
});

it("bills the list fee once the pool's allowance for the period is spent", async () => {
  counter.units = 1_500;
  await searchReturning(groundedResponse).search({ query: "ISO 1161", purpose: "case-source-search" });

  expect(prisma.providerCallLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
    costHint: 0.03706,
    metadata: expect.objectContaining({ groundingFeeUsd: 0.035, groundingOrdinal: 1_501, groundingAllowanceCovered: false })
  }) });
});

it("charges no fee and claims nothing for a search that cited nothing", async () => {
  await searchReturning({ text: "Nothing found.", usageMetadata, candidates: [] }).search({ query: "q", purpose: "chapter-research" });

  expect(prisma.$transaction).not.toHaveBeenCalled();
  expect(prisma.providerCallLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
    costHint: 0.00206,
    metadata: expect.objectContaining({ groundedPrompt: false, groundingFeeUsd: 0, groundingUnits: 0 })
  }) });
});
