import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerateTextOptions, GenerateWithToolsOptions, SourceService, ToolCallsResult } from "@book-maker/core";
import { classifyProjectChatMessage } from "../bookEditIntent.js";
import { deterministicCreationTurn, enrichCreationTurnWithSearch, type MobileCreationTurnRequest } from "../mobileCreation.js";
import { decideDecision, routerAdapter } from "../testing/bookEditIntentFixtures.js";
import { generateGroundedProjectAnswer, GROUNDED_ANSWER_CALL_BUDGET_MS } from "./groundedAnswer.js";
import { projectRecord, resetMobileHarness, teardownMobileHarness } from "./testing/mobileApiHarness.js";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

beforeEach(resetMobileHarness);
afterEach(() => {
  vi.useRealTimers();
  teardownMobileHarness();
});

const verified = "[source:archive:1:0]";
const stale = "[source:archive:1:99]";
const answer = `The archive names CYAN-482. ${verified} A copied reference: ${stale}`;
const validated = `The archive names CYAN-482. ${verified} A copied reference: [unverified source]`;
const passage = { sourceId: "archive", version: 1, ordinal: 0, name: "Archive", locator: "Entry", content: "The archive code is CYAN-482." };
const sources: SourceService = { search: async () => [passage], overview: async () => [], read: async () => passage };
const project = () => ({
  ...projectRecord(), category: "BUSINESS" as const, status: "COMPLETE" as const,
  exportInvalidationRevision: null, pdfPageMap: null, storyState: null
});

describe("citation previews", () => {
  for (const kind of ["creation", "router", "grounded"] as const) {
    for (const streaming of [true, false]) {
      it(`${kind} validates live citations and keeps streaming ${streaming ? "enabled" : "absent"}`, async () => {
        const calls: GenerateWithToolsOptions[] = [];
        const previews: string[] = [];
        const model = routerAdapter(async (options) => {
          calls.push(options);
          await options.onToolCallProgress?.({ type: "start" });
          if (kind !== "grounded" && calls.length === 1) {
            return { text: "", model: "test", provider: "test", toolCalls: [
              { id: "search", name: "search_sources", arguments: { query: "archive code" } }
            ] };
          }
          if (kind === "grounded") {
            await options.onOutputTextChunk?.(answer);
            return { text: answer, model: "test", provider: "test", toolCalls: [] };
          }
          const result: ToolCallsResult = kind === "creation"
            ? { text: "", model: "test", provider: "test", toolCalls: [{
              id: "finish", name: "finish_turn", arguments: { assistantMessage: answer, question: null, language: "en" }
            }] }
            : decideDecision({ action: "answer", confidence: 1, reasoning: "Read evidence", assistantMessage: answer,
              clarification: "none", pageIndexes: [], chapterIndex: null, targetLanguage: null });
          const call = result.toolCalls[0]!;
          await options.onToolCallProgress?.({ type: "arguments", index: 0, name: call.name, argumentsText: JSON.stringify(call.arguments) });
          return result;
        });
        model.generateJson = async (options) => ({ data: options.schema.parse({ language: "en" }), text: '{"language":"en"}', model: "test", provider: "test" });
        const observer = streaming ? { onAssistantText: (text: string) => { previews.push(text); } } : {};
        let saved: string | undefined;
        if (kind === "creation") {
          const request: MobileCreationTurnRequest = {
            messages: [{ role: "user", content: "Tell me the code in the archive" }], sourceService: sources, ...observer
          };
          saved = (await enrichCreationTurnWithSearch({ textModel: model, research: { search: async () => { throw new Error("Unexpected web search"); } } }, request, deterministicCreationTurn(request))).assistantMessage;
        } else if (kind === "router") {
          saved = (await classifyProjectChatMessage({ message: "What is the archive code?", stage: "complete", pages: [],
            textModel: model, sourceService: sources, ...observer })).assistantMessage;
        } else {
          saved = await generateGroundedProjectAnswer(project(), "What is the archive code?", "Unavailable", model, undefined, [], sources, observer.onAssistantText);
        }
        expect(saved).toBe(validated);
        if (streaming) {
          expect(previews).toContain(validated);
          expect(previews.some((text) => text.includes(stale))).toBe(false);
        } else {
          expect(previews).toEqual([]);
          for (const call of calls) {
            expect(call).not.toHaveProperty("onToolCallProgress");
            expect(call).not.toHaveProperty("onOutputTextChunk");
          }
        }
      });
    }
  }
});

describe("grounded answer preview lifetime", () => {
  const providerRequest = { provider: "test", model: "test", requestedMaxTokens: 800, effectiveMaxTokens: 800 };

  it("ignores provider callbacks after the answer deadline falls back", async () => {
    vi.useFakeTimers();
    const previews: string[] = [];
    let late!: GenerateTextOptions;
    const model = routerAdapter(async () => { throw new Error("Unexpected tools"); });
    model.generateText = async (options) => {
      late = options;
      await options.onOutputTextChunk?.("Partial answer");
      return new Promise(() => undefined);
    };
    const response = generateGroundedProjectAnswer(project(), "What happens?", "Saved fallback", model, undefined, [], undefined, (text) => { previews.push(text); });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(GROUNDED_ANSWER_CALL_BUDGET_MS);
    expect(await response).toBe("Saved fallback");
    const before = [...previews];
    await late.onProviderRequest?.(providerRequest);
    await late.onOutputTextChunk?.("Late abandoned text");
    expect(previews).toEqual(before);
  });

  it("ignores callbacks from a failed attempt while its replacement streams", async () => {
    vi.useFakeTimers();
    const previews: string[] = [];
    let abandoned!: GenerateTextOptions;
    let attempts = 0;
    const model = routerAdapter(async () => { throw new Error("Unexpected tools"); });
    model.generateText = async (options) => {
      if (++attempts === 1) {
        abandoned = options;
        await options.onOutputTextChunk?.("Abandoned");
        throw Object.assign(new Error("Connection lost"), { code: "ECONNRESET" });
      }
      await options.onOutputTextChunk?.("Replacement");
      await abandoned.onProviderRequest?.(providerRequest);
      await abandoned.onOutputTextChunk?.("Late abandoned text");
      return { text: "Replacement", model: "test", provider: "test" };
    };
    const response = generateGroundedProjectAnswer(project(), "What happens?", "Fallback", model, undefined, [], undefined, (text) => { previews.push(text); });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(await response).toBe("Replacement");
    expect(previews).toEqual(["", "Abandoned", "", "Replacement"]);
  });
});
