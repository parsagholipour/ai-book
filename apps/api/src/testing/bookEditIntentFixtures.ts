import { vi } from "vitest";
import type { GenerateWithToolsOptions, TextModelAdapter, ToolCallsResult } from "@book-maker/core";
import type { BookEditPageContext } from "../bookEditIntent.js";

/**
 * Book and router fixtures shared by the `bookEditIntent*.test.ts` suites: a
 * two-page book, and fake `TextModelAdapter`s that answer the tool-calling
 * router with a scripted `decide` call.
 */

export const pages = [
  {
    id: "page-1",
    index: 1,
    title: "Opening",
    summary: "Rabbit brags before the race.",
    previewText: "Rabbit hops to the starting line while Turtle smiles."
  },
  {
    id: "page-2",
    index: 2,
    title: "Practice",
    summary: "Turtle keeps moving.",
    previewText: "The old phrase appears in the practice scene."
  }
];

export const chapters = [
  { index: 1, title: "The Race Begins", pageIndexes: [1] },
  { index: 2, title: "Steady Wins", pageIndexes: [2] }
];

export function manyPages(count: number): BookEditPageContext[] {
  return Array.from({ length: count }, (_, offset) => ({
    id: `page-${offset + 1}`,
    index: offset + 1,
    title: `Section ${offset + 1}`,
    summary: `Summary of section ${offset + 1}.`,
    previewText: `Preview of section ${offset + 1}.`
  }));
}

export function routerAdapter(
  generateWithTools: (options: GenerateWithToolsOptions) => Promise<ToolCallsResult>
): TextModelAdapter {
  return {
    generateText: async () => ({ text: "", model: "test-router", provider: "test" }),
    generateJson: async () => {
      throw new Error("generateJson is not used by the tool-calling router");
    },
    generateWithTools: generateWithTools as TextModelAdapter["generateWithTools"],
    async *streamText() {
      yield "";
    }
  };
}

export type DecideArgs = {
  action: string;
  confidence: number;
  reasoning: string;
  assistantMessage: string;
  editInstruction?: string;
  clarification: "none" | "scope";
  pageIndexes: number[];
  chapterIndex: number | null;
  targetLanguage: string | null;
  editTarget?: string;
  editStyle?: string;
  backMatterSources?: boolean;
};

export type FakeRouterModel = TextModelAdapter & { generateWithTools: ReturnType<typeof vi.fn> };

export function decideDecision(args: DecideArgs): ToolCallsResult {
  const completeArgs = {
    ...args,
    editInstruction:
      args.action === "propose_edit"
        ? args.editInstruction?.trim() || args.assistantMessage
        : args.editInstruction ?? ""
  };
  return {
    text: "",
    model: "test-router",
    provider: "test",
    toolCalls: [{ id: "call-decide", name: "decide", arguments: completeArgs }]
  };
}

export function fakeDecideModel(args: DecideArgs): FakeRouterModel {
  const generateWithTools = vi.fn(async () => decideDecision(args));
  return Object.assign(routerAdapter(generateWithTools), { generateWithTools });
}

export function fakeFlakyDecideModel(args: DecideArgs): FakeRouterModel {
  let attempts = 0;
  const generateWithTools = vi.fn(async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("socket hang up");
      (error as Error & { code?: string }).code = "ECONNRESET";
      throw error;
    }
    return decideDecision(args);
  });
  return Object.assign(routerAdapter(generateWithTools), { generateWithTools });
}

export function fakeFailingTextModel(): FakeRouterModel {
  const generateWithTools = vi.fn(async () => {
    throw new Error("router unavailable");
  });
  return Object.assign(routerAdapter(generateWithTools), { generateWithTools });
}

export function fakeHangingTextModel(): FakeRouterModel {
  const generateWithTools = vi.fn(async () => new Promise<ToolCallsResult>(() => undefined));
  return Object.assign(routerAdapter(generateWithTools), { generateWithTools });
}

export function scriptedTextModel(results: ToolCallsResult[]): FakeRouterModel {
  let index = 0;
  const generateWithTools = vi.fn(async () => {
    const next = results[Math.min(index, results.length - 1)]!;
    index += 1;
    return next;
  });
  return Object.assign(routerAdapter(generateWithTools), { generateWithTools });
}
