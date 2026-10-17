import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  FallbackTextModelAdapter, OpenAITextAdapter, OPENAI_GPT_6_LUNA_MODEL, isTextProviderFallbackError,
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
import { LoggingTextModelAdapter, textRoutingRunLog } from "./loggedAdapters.js";
import { createRunLogger } from "./runLogging.js";

type Operation = "generateText" | "generateJson";
const answer = '{"value":"ok"}';

/**
 * gpt-6-luna over a stand-in client. A `stall` request answers a little and then
 * waits on its request's signal; when the stall deadline aborts it, the stream
 * ends without a terminal event and without throwing, which is what the SDK does.
 */
function luna(outcomes: Array<"stall" | { input: number; output: number }>): OpenAITextAdapter {
  const adapter = new OpenAITextAdapter({ apiKey: "test", model: OPENAI_GPT_6_LUNA_MODEL, thinkingEffort: "none" });
  Object.assign(adapter, { client: { responses: { create: async (_request: unknown, options?: { signal?: AbortSignal }) => {
    const outcome = outcomes.shift();
    if (!outcome) throw new Error("Unexpected extra provider dispatch");
    if (outcome === "stall") return (async function* () {
      yield { type: "response.created", response: { model: OPENAI_GPT_6_LUNA_MODEL, status: "in_progress" } };
      yield { type: "response.output_text.delta", delta: '{"value":"the first paragraph of a chapter that never ends' };
      await new Promise((resolve) => options?.signal?.addEventListener("abort", resolve, { once: true }));
    })();
    return (async function* () {
      yield { type: "response.output_text.delta", delta: answer };
      yield { type: "response.completed", response: { model: OPENAI_GPT_6_LUNA_MODEL, output_text: answer, output: [], status: "completed",
        usage: { input_tokens: outcome.input, output_tokens: outcome.output } } };
    })();
  } } } });
  return adapter;
}

/** The worker's pair: luna with a fallback that must not run, its routing events in the run log as `createLoggedProviders` writes them. */
function loggedPair(primary: TextModelAdapter) {
  const logger = createRunLogger({ id: "bull", name: "generate-book", data: { projectId: "p", generationJobId: "run" } } as Parameters<typeof createRunLogger>[0]);
  const pair = new FallbackTextModelAdapter({
    primary: { selection: { provider: "openai", model: OPENAI_GPT_6_LUNA_MODEL }, adapter: primary },
    fallback: { selection: { provider: "deepseek", model: "deepseek-v4-pro" }, adapter: luna([]) },
    shouldFallback: isTextProviderFallbackError,
    onEvent: textRoutingRunLog(logger)
  });
  return {
    adapter: new LoggingTextModelAdapter(pair, logger, undefined, "p", { provider: "openai", model: OPENAI_GPT_6_LUNA_MODEL }),
    entries: async () => (await readRunLog(logger.filePath)).trim().split("\n").map((line) => JSON.parse(line))
  };
}

async function invoke(adapter: TextModelAdapter, operation: Operation) {
  const options = { messages: [{ role: "user" as const, content: "Write the chapter." }], maxTokens: 1000, purpose: "compose-chapter" };
  const result = operation === "generateJson"
    ? adapter.generateJson({ ...options, schema: z.object({ value: z.string() }) })
    : adapter.generateText(options);
  void result.catch(() => {});
  await vi.runAllTimersAsync();
  return result;
}

const settled = () => [...ledger.rows.values()].filter((row) => (row.metadata as Record<string, unknown>).liveStatus === "settled");

beforeEach(() => { vi.useFakeTimers(); ledger.rows.clear(); ledger.nextId = 0; setObjectStoreForTests(new MemoryObjectStore()); });
afterEach(() => { setObjectStoreForTests(null); vi.restoreAllMocks(); vi.useRealTimers(); });

describe.each<Operation>(["generateText", "generateJson"])("%s stall deadline accounting", (operation) => {
  it("keeps the abandoned request on its own failed row, answers on a fresh luna request, and logs the stall", async () => {
    const run = loggedPair(luna(["stall", { input: 40, output: 224 }]));

    const result = await invoke(run.adapter, operation);

    expect(result).toMatchObject({ provider: "openai", model: OPENAI_GPT_6_LUNA_MODEL, text: answer });
    const rows = [...ledger.rows.values()];
    expect(rows.map((row) => row.model)).toEqual([OPENAI_GPT_6_LUNA_MODEL, OPENAI_GPT_6_LUNA_MODEL]);
    expect(new Set(rows.map((row) => (row.metadata as Record<string, unknown>).callId)).size).toBe(1);
    // The fresh request settles alone, with its own usage.
    expect(settled()).toHaveLength(1);
    expect(settled()[0]).toMatchObject({ promptTokens: 40, outputTokens: 224 });
    // The abandoned one is a row of its own: unpriced, its streamed output kept as an estimate, and why it ended.
    const abandoned = rows.find((row) => !settled().includes(row))!;
    expect(abandoned).toMatchObject({
      costHint: null,
      metadata: { liveStatus: "failed", costStatus: "unknown_usage", provisional: true,
        // The settled copy of the routing event's serialized error, as for every same-model retry.
        error: { value: { name: "ProviderStallDeadlineError", status: 504, stall: { rule: "idle" } } } }
    });
    expect(Number(abandoned.outputTokens)).toBeGreaterThan(0);

    const events = (await run.entries()).map((entry) => entry.event as string).filter((event) => event.startsWith("text.routing."));
    expect(events).toEqual(["text.routing.stall_deadline", "text.routing.fallback.primary_retry"]);
    const stall = (await run.entries()).find((entry) => entry.event === "text.routing.stall_deadline");
    expect(stall).toMatchObject({
      purpose: "compose-chapter",
      primary: { provider: "openai", model: OPENAI_GPT_6_LUNA_MODEL },
      stall: { rule: "idle", deadline: { idleMs: 30_000, minTokensPerSecond: 25 } }
    });
  });
});
