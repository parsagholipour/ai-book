import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FallbackTextModelAdapter,
  OpenAITextAdapter,
  PROVIDER_QUOTA_EXHAUSTED_ERROR_CLASS,
  ProviderHttpError,
  isTextProviderFallbackError,
  type TextModelAdapter
} from "@book-maker/core";
import { MemoryObjectStore, readRunLog, setObjectStoreForTests } from "@book-maker/storage";

const ledger = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>(), nextId: 0 }));
vi.mock("@book-maker/db", () => ({ Prisma: {}, prisma: { providerCallLog: {
  create: vi.fn(async ({ data }) => {
    const id = `usage-${++ledger.nextId}`;
    ledger.rows.set(id, data);
    return { id };
  }),
  update: vi.fn(async ({ where, data }) => {
    ledger.rows.set(where.id, { ...ledger.rows.get(where.id), ...data });
    return { id: where.id };
  }),
  findUnique: vi.fn(async ({ where }) => ledger.rows.get(where.id) ?? null)
} } }));
vi.mock("../runtime/config.js", () => ({ config: { MOCK_AI: false, GEMINI_EMBEDDING_MODEL: "gemini-embedding-001" } }));
vi.mock("../runtime/jobLifecycle.js", () => ({ assertJobNotStopped: vi.fn(), updateJobProgress: vi.fn() }));
import { LoggingEmbeddingAdapter } from "./loggedEmbeddingAdapter.js";
import { LoggingTextModelAdapter } from "./loggedAdapters.js";
import { createRunLogger } from "./runLogging.js";
import { recordProviderQuotaRefusal } from "./usageAccounting.js";

/** OpenAI's answer on 2026-10-16, as the SDK raised it. */
function creditsExhausted() {
  return Object.assign(new Error("429 You have no credits remaining. Add credits to your account to continue using the API."), {
    status: 429,
    code: "credit_balance_exhausted",
    type: "insufficient_quota",
    headers: {},
    error: { type: "insufficient_quota", code: "credit_balance_exhausted", message: "You have no credits remaining." }
  });
}

function emptyLuna(requests: string[]): OpenAITextAdapter {
  const adapter = new OpenAITextAdapter({ apiKey: "test", model: "gpt-6-luna", thinkingEffort: "none" });
  Object.assign(adapter, { client: { responses: { create: async () => {
    requests.push("gpt-6-luna");
    throw creditsExhausted();
  } } } });
  return adapter;
}

function answeringDeepSeek(): TextModelAdapter {
  const answer = async () => ({
    text: "chapter",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    usage: { promptTokens: 100, outputTokens: 50 }
  });
  return {
    generateText: answer,
    generateJson: async () => ({ ...(await answer()), data: {} as never }),
    async *streamText() {
      yield "chapter";
    },
    generateWithTools: async () => ({ ...(await answer()), toolCalls: [] })
  };
}

function logger() {
  return createRunLogger({ id: "bull", name: "generate-book", data: { projectId: "p", generationJobId: "run" } } as Parameters<typeof createRunLogger>[0]);
}

function rows() {
  return [...ledger.rows.values()].map((row) => ({ provider: row.provider, metadata: row.metadata as Record<string, unknown> }));
}

beforeEach(() => {
  vi.useFakeTimers();
  ledger.rows.clear();
  ledger.nextId = 0;
  setObjectStoreForTests(new MemoryObjectStore());
});
afterEach(() => {
  setObjectStoreForTests(null);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("a provider account out of credits, in the worker", () => {
  it("asks the empty account once, writes its row as quota-exhausted, and lets the fallback write the chapter", async () => {
    const requests: string[] = [];
    const runLog = logger();
    const pair = new FallbackTextModelAdapter({
      primary: { selection: { provider: "openai", model: "gpt-6-luna" }, adapter: emptyLuna(requests) },
      fallback: { selection: { provider: "deepseek", model: "deepseek-v4-pro" }, adapter: answeringDeepSeek() },
      shouldFallback: isTextProviderFallbackError,
      primaryRetryDelayMs: () => 0
    });
    const adapter = new LoggingTextModelAdapter(pair, runLog, undefined, "p", { provider: "openai", model: "gpt-6-luna" });

    const result = adapter.generateText({ messages: [{ role: "user", content: "Write." }], purpose: "compose-chapter" });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toMatchObject({ provider: "deepseek" });
    expect(requests).toEqual(["gpt-6-luna"]);
    expect(rows()).toEqual([
      { provider: "openai", metadata: expect.objectContaining({ liveStatus: "failed", errorClass: PROVIDER_QUOTA_EXHAUSTED_ERROR_CLASS }) },
      { provider: "deepseek", metadata: expect.not.objectContaining({ errorClass: expect.anything() }) }
    ]);
    const events = (await readRunLog(runLog.filePath)).trim().split("\n").map((line) => JSON.parse(line).event as string);
    expect(events).not.toContain("text.generateText.retry");
  });

  it("marks only a quota refusal, so the mark can mean nothing else", async () => {
    await recordProviderQuotaRefusal({
      projectId: "p", generationJobId: "run", provider: "gemini", model: "imagen", operation: "image.generate", callId: "a", durationMs: 10,
      error: new ProviderHttpError("unavailable", { status: 503 })
    });
    expect(rows()).toEqual([]);

    await recordProviderQuotaRefusal({
      projectId: "p", generationJobId: "run", provider: "gemini", model: "imagen", operation: "image.generate", callId: "b", durationMs: 10,
      error: Object.assign(new Error('{"error":{"code":429,"message":"Your prepayment credits are depleted.","status":"RESOURCE_EXHAUSTED"}}'), { status: 429 })
    });
    expect(rows()).toEqual([
      {
        provider: "gemini",
        metadata: expect.objectContaining({
          liveStatus: "failed",
          costStatus: "unknown_usage",
          usageUnavailableReason: "provider_error",
          errorClass: PROVIDER_QUOTA_EXHAUSTED_ERROR_CLASS
        })
      }
    ]);
    expect([...ledger.rows.values()][0]).toMatchObject({ costHint: null, promptTokens: null, outputTokens: null });
  });

  it("writes a failed Gemini row for an embedding the empty account refused, and none for any other failure", async () => {
    const depleted = Object.assign(new Error('{"error":{"code":429,"message":"Your prepayment credits are depleted.","status":"RESOURCE_EXHAUSTED"}}'), { status: 429 });
    const embedding = new LoggingEmbeddingAdapter({ embed: async () => { throw depleted; } }, logger(), "run", "p");
    const refused = embedding.embed("page text").catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    await expect(refused).resolves.toBe(depleted);
    expect(rows()).toEqual([
      { provider: "gemini", metadata: expect.objectContaining({ operation: "embedding.embed", errorClass: PROVIDER_QUOTA_EXHAUSTED_ERROR_CLASS }) }
    ]);

    ledger.rows.clear();
    const broken = new LoggingEmbeddingAdapter({ embed: async () => { throw new Error("bad input"); } }, logger(), "run", "p");
    await expect(broken.embed("page text")).rejects.toThrow("bad input");
    expect(rows()).toEqual([]);
  });
});
