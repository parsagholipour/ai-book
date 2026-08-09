import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { unsupportedGenerateWithTools } from "./fake.js";
import { MECHANICAL_TEXT_PURPOSES } from "./modelTiers.js";
import { RoutingTextModelAdapter } from "./textRouting.js";
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  JsonResult,
  TextModelAdapter,
  TextResult,
  ToolCallsResult
} from "./types.js";

class RecordingTextAdapter implements TextModelAdapter {
  purposes: Array<string | undefined> = [];

  constructor(private readonly name: string) {}

  async generateText(options: GenerateTextOptions): Promise<TextResult> {
    this.purposes.push(options.purpose);
    return { text: this.name, model: this.name, provider: this.name };
  }

  async generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
    this.purposes.push(options.purpose);
    return { text: this.name, model: this.name, provider: this.name, data: undefined as T };
  }

  async *streamText(options: GenerateTextOptions): AsyncGenerator<string> {
    this.purposes.push(options.purpose);
    yield this.name;
  }

  generateWithTools(): Promise<ToolCallsResult> {
    return unsupportedGenerateWithTools();
  }
}

function routedAdapters() {
  const prose = new RecordingTextAdapter("prose-model");
  const mechanical = new RecordingTextAdapter("mechanical-model");
  const routing = new RoutingTextModelAdapter(
    { selection: { provider: "gemini", model: "prose-model" }, adapter: prose },
    { selection: { provider: "gemini", model: "mechanical-model" }, adapter: mechanical }
  );
  return { prose, mechanical, routing };
}

describe("RoutingTextModelAdapter", () => {
  it("routes every mechanical purpose to the mechanical model", async () => {
    const { mechanical, routing } = routedAdapters();

    for (const purpose of MECHANICAL_TEXT_PURPOSES) {
      const result = await routing.generateText({ messages: [], purpose });
      expect(result.model).toBe("mechanical-model");
      expect(routing.selectionForPurpose(purpose).model).toBe("mechanical-model");
    }
    expect(mechanical.purposes).toEqual([...MECHANICAL_TEXT_PURPOSES]);
  });

  it("routes prose and unknown purposes to the prose model", async () => {
    const { prose, routing } = routedAdapters();

    for (const purpose of ["generate-page", "plan-book", "polish-page", "some-future-purpose"]) {
      const result = await routing.generateJson({ messages: [], purpose, schema: undefined as never });
      expect(result.model).toBe("prose-model");
    }
    expect((await routing.generateJson({ messages: [], schema: undefined as never })).model).toBe("prose-model");
    expect(routing.selectionForPurpose("generate-page").model).toBe("prose-model");
    expect(routing.selectionForPurpose(undefined).model).toBe("prose-model");
    expect(prose.purposes).toHaveLength(5);
  });

  it("routes streamText by purpose", async () => {
    const { routing } = routedAdapters();

    const chunks: string[] = [];
    for await (const chunk of routing.streamText({ messages: [], purpose: "review-page" })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["mechanical-model"]);
  });

  it("pins mechanical purposes to the strings actually used by generation code", async () => {
    const sources = await Promise.all(
      [
        "../generation/pages.ts",
        "../generation/bestOf.ts",
        "../generation/readerChapters.ts",
        "../generation/coverDesigns.ts",
        "../ingestion/manuscriptImport.ts"
      ].map((path) =>
        readFile(new URL(path, import.meta.url), "utf8")
      )
    );
    const combined = sources.join("\n");

    // Emitted by apps/worker (compileExport.ts), which this core test cannot
    // read; the worker's own suites exercise the call that carries it.
    const usedOutsideCore = new Set(["book.final_qa.chapter_transitions"]);
    for (const purpose of MECHANICAL_TEXT_PURPOSES) {
      if (usedOutsideCore.has(purpose)) {
        continue;
      }
      expect(combined, `purpose "${purpose}" is no longer used by generation code`).toContain(`"${purpose}"`);
    }
  });
});
