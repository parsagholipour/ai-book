import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  FallbackTextModelAdapter, OpenAITextAdapter, ProviderHttpError,
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
vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../runtime/jobLifecycle.js", () => ({ assertJobNotStopped: vi.fn(), updateJobProgress: vi.fn() }));
import { LoggingTextModelAdapter } from "./loggedAdapters.js";
import { createRunLogger } from "./runLogging.js";

type Outcome = { input: number; output: number; fail?: boolean; reportUsage?: boolean };
type Operation = "generateText" | "generateJson" | "generateWithTools";
const options = { messages: [{ role: "user" as const, content: "Write a result." }], maxTokens: 1000, purpose: "compose-chapter" };

function provider(model: string, outcomes: Outcome[]) {
  const adapter = new OpenAITextAdapter({ apiKey: "test", model, thinkingEffort: "none" });
  Object.assign(adapter, { client: { responses: { create: async (request: { stream?: boolean }) => {
    const outcome = outcomes.shift();
    if (!outcome) throw new Error("Unexpected extra provider dispatch");
    if (!request.stream) return { model, output_text: '{"value":"ok"}', output: [],
      status: outcome.fail ? "failed" : "completed",
      ...(outcome.fail ? { error: { message: "connection reset after response" } } : {}),
      usage: { input_tokens: outcome.input, output_tokens: outcome.output,
        output_tokens_details: { reasoning_tokens: Math.floor(outcome.output / 2) } }
    };
    return (async function* () {
      yield { type: "response.output_text.delta", delta: '{"value":"ok"}' };
      yield { type: "response.completed", response: { model, output_text: '{"value":"ok"}', output: [], status: "completed",
        ...(outcome.reportUsage === false ? {} : { usage: {
          input_tokens: outcome.input, output_tokens: outcome.output,
          output_tokens_details: { reasoning_tokens: Math.floor(outcome.output / 2) }
        } })
      } };
      if (outcome.fail) throw new ProviderHttpError("connection reset after response", { status: 502, retryAfterMs: 1 });
    })();
  } } } });
  return adapter;
}

function logged(adapter: TextModelAdapter) {
  const logger = createRunLogger({ id: "bull", name: "generate-book", data: { projectId: "p", generationJobId: "run" } } as Parameters<typeof createRunLogger>[0]);
  return {
    adapter: new LoggingTextModelAdapter(adapter, logger, undefined, "p", { provider: "openai", model: "primary" }),
    entries: async () => (await readRunLog(logger.filePath)).trim().split("\n").map((line) => JSON.parse(line))
  };
}
async function invoke(adapter: TextModelAdapter, operation: Operation) {
  const result = operation === "generateJson"
    ? adapter.generateJson({ ...options, schema: z.object({ value: z.string() }) })
    : operation === "generateWithTools"
      ? adapter.generateWithTools({ ...options, tools: [] })
      : adapter.generateText(options);
  void result.catch(() => {});
  await vi.runAllTimersAsync();
  return result;
}
function settled() {
  return [...ledger.rows.values()].filter(row => (row.metadata as Record<string, unknown>).liveStatus === "settled");
}
function sum(rows: Record<string, unknown>[], field: string) { return rows.reduce((total, row) => total + Number(row[field] ?? 0), 0); }

beforeEach(() => { vi.useFakeTimers(); ledger.rows.clear(); ledger.nextId = 0; setObjectStoreForTests(new MemoryObjectStore()); });
afterEach(() => { setObjectStoreForTests(null); vi.restoreAllMocks(); vi.useRealTimers(); });

describe.each<Operation>(["generateText", "generateJson", "generateWithTools"])("%s network retry accounting", operation => {
  it("preserves each paid attempt in its own ledger row after recovery", async () => {
    const run = logged(provider("primary", [{ input: 20, output: 112, fail: true }, { input: 40, output: 224 }]));
    await invoke(run.adapter, operation);
    const events = await run.entries();
    const usage = events.filter(e => e.event === `text.${operation}.provider_usage`);
    expect(usage.map(e => [e.providerRequest.requestIndex, e.usage.outputTokens])).toEqual([[1, 112], [2, 224]]);
    const rows = settled();
    expect(rows).toHaveLength(2);
    expect(sum(rows, "promptTokens")).toBe(60);
    expect(sum(rows, "outputTokens")).toBe(336);
    expect(new Set(rows.map(row => (row.metadata as Record<string, unknown>).callId)).size).toBe(1);
    expect(rows.map(row => row.model)).toEqual(["primary", "primary"]);
  });
  it("settles exhausted attempts exactly once through the outer error handler", async () => {
    const run = logged(provider("primary", [1, 2, 3].map(n => ({ input: n * 20, output: n * 112, fail: true }))));
    await expect(invoke(run.adapter, operation)).rejects.toThrow("connection reset");
    expect(settled()).toHaveLength(3);
    expect(sum(settled(), "promptTokens")).toBe(120);
    expect(sum(settled(), "outputTokens")).toBe(672);
  });
});

it("does not copy unreported usage into the successful retry", async () => {
  const run = logged(provider("primary", [{ input: 20, output: 112, fail: true, reportUsage: false }, { input: 40, output: 224 }]));
  await invoke(run.adapter, "generateText");
  expect(ledger.rows.size).toBe(2);
  expect(settled()).toHaveLength(1);
  expect(sum(settled(), "outputTokens")).toBe(224);
  const failed = [...ledger.rows.values()].find(row => !settled().includes(row));
  expect(failed).toMatchObject({ costHint: null, metadata: { liveStatus: "failed", provisional: true } });
});

it("does not double-settle a failed fallback when the outer retry restarts the primary", async () => {
  const primary = provider("primary", [{ input: 20, output: 112, fail: true }, { input: 40, output: 224 }]);
  const fallback = provider("fallback", [{ input: 30, output: 168, fail: true }]);
  const run = logged(new FallbackTextModelAdapter({
    primary: { selection: { provider: "openai", model: "primary" }, adapter: primary },
    fallback: { selection: { provider: "openai", model: "fallback" }, adapter: fallback },
    shouldFallback: () => true
  }));
  await invoke(run.adapter, "generateText");
  const rows = settled();
  expect(rows).toHaveLength(3);
  expect(rows.map(row => row.model)).toEqual(["primary", "fallback", "primary"]);
  expect(sum(rows, "outputTokens")).toBe(504);
  expect(sum(rows, "promptTokens")).toBe(90);
});
