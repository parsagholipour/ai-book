import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GeminiResearchAdapter } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { MemoryObjectStore, readRunLog, setObjectStoreForTests } from "@book-maker/storage";

vi.mock("@book-maker/db", () => {
  const create = vi.fn();
  const providerCallLog = { create };
  // A grounded search claims its allowance ordinal in a transaction (searchGroundingAllowance.ts).
  const tx = { providerCallLog, $queryRaw: vi.fn(async () => [{ units: 1 }]) };
  return { Prisma: {}, prisma: { providerCallLog, $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) } };
});
vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../runtime/jobLifecycle.js", () => ({ assertJobNotStopped: vi.fn(), updateJobProgress: vi.fn() }));

import { LoggingResearchAdapter } from "./loggedAdapters.js";
import { createRunLogger } from "./runLogging.js";

beforeEach(() => {
  vi.clearAllMocks();
  setObjectStoreForTests(new MemoryObjectStore());
});
afterEach(() => {
  vi.restoreAllMocks();
  setObjectStoreForTests(null);
});

it.each([true, false])("persists research timings in the durable trace with metered usage=%s", async (metered) => {
  let now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const inner = new GeminiResearchAdapter({ apiKey: "fixture", textModel: "gemini-2.5-flash" });
  Object.assign(inner, { ai: { models: { generateContent: async () => {
    now += 1_200;
    return {
      text: "Source-backed notes.", candidates: [],
      ...(metered ? { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30 } } : {})
    };
  } } } });
  const logger = createRunLogger({ id: "timing", name: "generate-book", data: { projectId: "p", generationJobId: "job" } } as Parameters<typeof createRunLogger>[0]);

  await new LoggingResearchAdapter(inner, logger, "job", "p").search({ query: "research timing" });

  const entries = (await readRunLog(logger.filePath)).trim().split("\n").map((line) => JSON.parse(line));
  const request = entries.find((entry) => entry.event === "research.search.request");
  const response = entries.find((entry) => entry.event === "research.search.response");
  expect(response).toMatchObject({
    callId: request.callId,
    job: { projectId: "p", generationJobId: "job" },
    result: { timings: { providerRequestMs: 1_200, groundingRedirectsMs: 0, totalMs: 1_200 } }
  });
  expect(prisma.providerCallLog.create).toHaveBeenCalledTimes(metered ? 1 : 0);
  if (metered) expect(prisma.providerCallLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
    promptTokens: 100, outputTokens: 50, costHint: expect.any(Number)
  }) });
});
